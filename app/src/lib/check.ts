// Checks a Jurat proof from public data only: the holder's NEAR transaction,
// OutLayer's attestation for it, Intel's DCAP verification and the approved
// worker builds on worker.outlayer.near. Nothing here trusts Jurat's servers
// (there are none) or OutLayer's dashboard.

import { getCollateralAndVerify, Quote, utils, verify } from '@phala/dcap-qvl';
import { fromBase64, hex, sha256 } from './bytes';
import { ARCHIVAL_RPC, ENCLAVES, OUTLAYER, OUTLAYER_API, WORKER_REGISTER } from './config';
import { parseChallenge, type Challenge } from './challenge';
import { CONTRACTS, codeHash, getChallenge, parseContractText, toChallenge, type ContractChallenge } from './contract';
import { rpc, txStatus, view } from './rpc';

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Proof {
  txHash: string;
  sender: string;
  verdict: string | null;
  holder: string | null;
  challenge: Challenge | null;
  /** The Jurat contract the proof went through, when it did. */
  contract: string | null;
  blockTimeMs: number | null;
  output: Record<string, unknown> | null;
  checks: Check[];
  ok: boolean;
}

export interface Attestation {
  task_id: number;
  task_type: string;
  tdx_quote: string;
  worker_measurement: string;
  request_id: number;
  caller_account_id: string;
  transaction_hash: string;
  block_height: number;
  build_target?: string;
  wasm_hash: string;
  executed_wasm_sha256: string;
  input_hash: string;
  output_hash: string;
  attached_usd?: string;
  timestamp: number;
  repo_url?: string;
  commit_hash?: string;
  project_id?: string;
  secrets_ref?: string;
}

/** OutLayer's V1 task hash (worker/src/tdx_attestation.rs), bound into REPORTDATA. */
export async function taskHash(a: Attestation): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(a.task_type)];
  const i64 = (v: number | bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
    return b;
  };
  parts.push(i64(a.task_id));
  for (const k of ['repo_url', 'commit_hash', 'build_target', 'wasm_hash', 'input_hash', 'output_hash'] as const) {
    if (a[k]) parts.push(enc.encode(a[k]!));
  }
  if (a.block_height != null) parts.push(i64(a.block_height)); // u64 LE; same bytes for any height below 2^63
  for (const k of ['caller_account_id', 'project_id', 'secrets_ref'] as const) {
    if (a[k]) parts.push(enc.encode(a[k]!));
  }
  parts.push(i64(a.timestamp));
  if (a.attached_usd != null) parts.push(enc.encode(a.attached_usd));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return hex(await sha256(all));
}

/**
 * Verify a TDX quote with Intel's DCAP rules. The collateral (Intel-signed CRLs,
 * TCB info and QE identity) comes first from OutLayer's archive, as of the
 * moment the quote was made, because that endpoint allows browser requests;
 * Phala's PCCS is the fallback. Where it came from changes nothing about the
 * trust: dcap-qvl checks Intel's signatures on it either way.
 */
async function verifyQuote(quote: Uint8Array, atSecs: number) {
  try {
    const q: any = Quote.parse(quote);
    const auth = q.authData.intoV3 ? q.authData.intoV3() : q.authData;
    const u: any = utils;
    const cert = u.extractCerts(Buffer.from(auth.certificationData.body))[0];
    const fmspc = Buffer.from(u.getFmspc(u.getIntelExtension(cert))).toString('hex').toUpperCase();
    const res = await fetch(`${OUTLAYER_API}/public/collateral?fmspc=${fmspc}&at=${atSecs}`);
    const archived = res.ok ? await res.json() : null;
    if (archived?.covers_requested_time && typeof archived.collateral === 'string') {
      return { verified: verify(quote, JSON.parse(archived.collateral), atSecs), source: `collateral as of ${new Date(atSecs * 1000).toISOString()}` };
    }
  } catch {
    // fall through to the PCCS
  }
  return { verified: await getCollateralAndVerify(quote), source: 'current collateral from Phala PCCS' };
}

function requestEvent(tx: any): { requestId: number; input: string; wasmHash: string | null } | null {
  for (const r of tx.receipts_outcome) {
    for (const log of r.outcome.logs as string[]) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
      if (ev.standard !== 'near-outlayer' || ev.event !== 'execution_requested') continue;
      const data = JSON.parse(ev.data[0].request_data);
      return { requestId: data.request_id, input: data.input_data ?? '', wasmHash: data.code_source?.WasmUrl?.hash ?? null };
    }
  }
  return null;
}

async function blockTimeMs(blockHash: string): Promise<number> {
  const b = await rpc<any>('block', { block_id: blockHash }, ARCHIVAL_RPC);
  return Math.floor(Number(b.header.timestamp_nanosec) / 1e6);
}

/**
 * Check one proof. `expected` is the challenge text the verifier issued; when
 * given, the proof must answer exactly it.
 */
export async function checkProof(txHash: string, sender: string, expected?: string): Promise<Proof> {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail = '') => checks.push({ id, label, ok, detail });
  const proof: Proof = { txHash, sender, verdict: null, holder: null, challenge: null, contract: null, blockTimeMs: null, output: null, checks, ok: false };

  const tx = await txStatus(txHash, sender);
  // Direct runs go to OutLayer; contract runs go to a contract that calls it (the event below proves the call).
  add('tx', 'Transaction reached OutLayer', tx.transaction.receiver_id === OUTLAYER || tx.receipts_outcome.some((r: any) => r.outcome.executor_id === OUTLAYER), tx.transaction.receiver_id);
  proof.contract = tx.transaction.receiver_id === OUTLAYER ? null : tx.transaction.receiver_id;
  const ev = requestEvent(tx);
  if (!ev) {
    add('request', 'OutLayer accepted the request', false, 'no execution_requested event');
    return proof;
  }

  // The enclave's output is what OutLayer's settlement receipt returns: the
  // transaction's result for a direct call, but not when a contract (the
  // statement contract) calls OutLayer and returns its own value.
  let outputBytes: Uint8Array = new Uint8Array();
  for (const r of tx.receipts_outcome) {
    const value = r.outcome.status?.SuccessValue;
    if (r.outcome.executor_id === OUTLAYER && value) outputBytes = fromBase64(value);
  }
  let output: any = null;
  try {
    output = JSON.parse(new TextDecoder().decode(outputBytes));
  } catch {}
  proof.output = output;
  add('ran', 'The enclave produced a result', output && typeof output === 'object', output ? '' : 'no output (run failed or timed out)');

  const release = ENCLAVES.find((e) => e.hash === ev.wasmHash);
  add('code', 'Ran a published Jurat enclave', !!release, release ? `${release.tag} (${ev.wasmHash})` : String(ev.wasmHash));

  let input: any = null;
  try {
    input = JSON.parse(ev.input);
  } catch {}
  // A request is either self-describing text (jurat:v1:…) or a challenge on a
  // Jurat contract (jurat:<contract>:<id>:<nonce>), whose terms live on chain.
  const text: string = input?.challenge ?? '';
  let challenge: Challenge | null = null;
  let onChain: ContractChallenge | null = null;
  const ref = parseContractText(text);
  if (ref) {
    const known = CONTRACTS[ref.contract];
    const deployed = known ? await codeHash(ref.contract).catch(() => '') : '';
    add('contract-code', 'Request lives on a published Jurat contract', !!known && deployed === known, `${ref.contract} (${deployed || 'unknown code'})`);
    add('contract-call', 'The proof went through that contract', tx.transaction.receiver_id === ref.contract, tx.transaction.receiver_id);
    onChain = known ? await getChallenge(ref.contract, ref.id).catch(() => null) : null;
    if (onChain && onChain.challenge === text) challenge = toChallenge(onChain);
  } else {
    try {
      challenge = parseChallenge(text);
    } catch {}
  }
  proof.challenge = challenge;
  add('challenge-format', 'Carries a Jurat request', !!challenge && !!release?.challenges, challenge?.text ?? (text || 'none'));
  if (expected !== undefined) add('challenge-match', 'Answers your request', challenge?.text === expected, '');
  if (onChain && output) {
    const s = onChain.statements.find((x) => x.verdict === output.result && x.holder === output.signer_id && x.wasm_hash === ev.wasmHash);
    add('statement', 'The contract recorded this statement', !!s, s ? `block ${s.block_height}` : `${onChain.statements.length} statements, none match`);
  }
  if (challenge && output) {
    add(
      'challenge-echo',
      'The enclave answered this challenge, token and threshold',
      output.challenge === challenge.text &&
        output.token_id === challenge.tokenId &&
        output.threshold === challenge.threshold &&
        input.tokenId === challenge.tokenId &&
        input.threshold === challenge.threshold,
      '',
    );
    const block = tx.transaction_outcome.block_hash;
    proof.blockTimeMs = await blockTimeMs(block);
    add('in-time', 'Sent before the challenge expired', proof.blockTimeMs <= challenge.expiresMs, new Date(proof.blockTimeMs).toISOString());
  }
  proof.verdict = typeof output?.result === 'string' ? output.result : null;
  proof.holder = typeof output?.signer_id === 'string' ? output.signer_id : null;

  // Attestation
  const res = await fetch(`${OUTLAYER_API}/attestations/by-request/${ev.requestId}`);
  if (!res.ok) {
    add('attestation', 'OutLayer published an attestation', false, `HTTP ${res.status}`);
    proof.ok = false;
    return proof;
  }
  const a: Attestation = await res.json();
  add('attestation', 'OutLayer published an attestation', a.transaction_hash === txHash, `task ${a.task_id}`);

  const quote = fromBase64(a.tdx_quote);
  try {
    const { verified, source } = await verifyQuote(quote, a.timestamp);
    // OutLayer's workers produce TDX 1.0 quotes; anything else fails the checks below.
    const td = verified.report.asTd10();
    add('intel', "Intel's signature on the enclave quote", true, `TCB ${verified.status}, ${source}`);
    add('quote-type', 'Quote is a TDX 1.0 report', !!td, verified.report.type);
    if (td) {
      add('debug', 'Enclave debug mode is off', (td.tdAttributes[0] & 1) === 0, '');
      const m = { mrtd: hex(td.mrTd), rtmr0: hex(td.rtMr0), rtmr1: hex(td.rtMr1), rtmr2: hex(td.rtMr2), rtmr3: hex(td.rtMr3) };
      const approved = await view<boolean>(WORKER_REGISTER, 'is_measurements_approved', { measurements: m });
      add('build', 'Worker is an approved OutLayer build', approved && m.rtmr3 === a.worker_measurement, a.worker_measurement.slice(0, 16) + '…');
      add('binding', 'Quote signs this exact run', (await taskHash(a)) === hex(td.reportData.subarray(0, 32)), '');
    }
  } catch (e) {
    add('intel', "Intel's signature on the enclave quote", false, String((e as Error).message ?? e));
  }
  add('input', 'Attested input is this transaction’s input', hex(await sha256(ev.input)) === a.input_hash, '');
  add('output', 'Attested output is this transaction’s result', hex(await sha256(outputBytes)) === a.output_hash, '');
  add('wasm', 'Attested code is the pinned enclave', a.wasm_hash === ev.wasmHash && a.executed_wasm_sha256 === ev.wasmHash, '');

  proof.ok = checks.every((c) => c.ok);
  return proof;
}
