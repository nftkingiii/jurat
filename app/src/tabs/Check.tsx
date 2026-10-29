import { useEffect, useState } from 'react';
import { go } from '../App';
import type { Proof } from '../lib/check';
import { EXPLORER_TX } from '../lib/config';
import { fromUnits, loadTokens, type Token } from '../lib/tokens';

/** The first Confirmed proof on mainnet, so anyone can see a full check without making one. */
const EXAMPLE = { tx: 'EPSQKGKGiudsv77ZeehCo75Cz1FUSRX27sjHCi9tLnJw', from: 'juratapp.near' };

const VERDICT: Record<string, { cls: string; text: string; line: (amount: string) => string }> = {
  confirmed: { cls: 'ok', text: 'Confirmed', line: (a) => `holds at least ${a} in a NEAR confidential account.` },
  not_confirmed: { cls: 'warn', text: 'Not met', line: (a) => `does not hold ${a} in a NEAR confidential account.` },
  refused: { cls: 'bad', text: 'Refused', line: () => 'could not be checked: the enclave refused the request.' },
};

export function Check() {
  const q = new URLSearchParams(location.search);
  const [tx, setTx] = useState(q.get('tx') ?? '');
  const [from, setFrom] = useState(q.get('from') ?? '');
  const expected = q.get('c') ?? undefined;
  const [tokens, setTokens] = useState<Token[]>([]);
  const [proof, setProof] = useState<Proof | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const run = async (hash: string, sender: string) => {
    setBusy(true);
    setError('');
    setProof(null);
    setCopied(false);
    try {
      // Loaded on demand: it carries Intel's quote verifier and its polyfills.
      const { checkProof } = await import('../lib/check');
      setProof(await checkProof(hash.trim(), sender.trim(), expected));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadTokens().then(setTokens).catch(() => {});
    if (tx && from) run(tx, from);
    // The result is read once from the link; the form reruns it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const c = proof?.challenge;
  const token = tokens.find((t) => t.assetId === c?.tokenId);
  const amount = c ? (token ? `${fromUnits(c.threshold, token.decimals)} ${token.symbol}` : `${c.threshold} units of ${c.tokenId}`) : '';
  const v = proof?.verdict ? VERDICT[proof.verdict] : undefined;

  return (
    <section>
      <h1>Check a proof</h1>
      <p className="lede">Every check below runs in your browser against public data: the NEAR transaction, OutLayer's attestation, and Intel's signature.</p>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          go({ tx: tx.trim(), from: from.trim(), ...(expected ? { c: expected } : {}) });
          run(tx, from);
        }}
      >
        <div className="row">
          <label>
            Transaction hash
            <input value={tx} onChange={(e) => setTx(e.target.value)} placeholder="9pJpnKEx…" className="mono" />
          </label>
          <label>
            Sent by
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="holder.near" />
          </label>
        </div>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !tx.trim() || !from.trim()}>
            {busy ? 'Checking…' : 'Check proof'}
          </button>
          {!tx && !from && !proof && (
            <button
              type="button"
              className="btn quiet"
              data-example
              onClick={() => {
                setTx(EXAMPLE.tx);
                setFrom(EXAMPLE.from);
                go(EXAMPLE);
                run(EXAMPLE.tx, EXAMPLE.from);
              }}
            >
              Check the mainnet example
            </button>
          )}
        </div>
      </form>

      {error && <p className="notice bad" style={{ marginTop: 24 }}>Could not check this transaction: {error}</p>}

      {busy && (
        <div className="jurat" style={{ marginTop: 32 }}>
          <span className="verdict pending">Checking</span>
          <p className="muted">Reading the transaction, the attestation and Intel's collateral…</p>
        </div>
      )}

      {proof && (
        <div
          className="jurat"
          style={{ marginTop: 32 }}
          data-proof={proof.txHash}
          data-ok={String(proof.ok)}
          data-verdict={proof.ok ? (proof.verdict ?? '') : 'invalid'}
          data-holder={proof.holder ?? ''}
        >
          {proof.ok && v ? (
            <span className={`verdict ${v.cls}`}>{v.text}</span>
          ) : (
            <span className="verdict bad">Not a valid Jurat proof</span>
          )}
          <p className="statement">
            {proof.ok && v
              ? `${proof.holder ?? 'The holder'} ${v.line(amount)}`
              : 'One or more checks failed, so this transaction proves nothing about a balance.'}
          </p>
          <dl>
            {proof.holder && (<><dt>Holder</dt><dd className="mono">{proof.holder}</dd></>)}
            {c && (<><dt>Requested</dt><dd>at least {amount}, answer before {new Date(c.expiresMs).toLocaleString()}</dd></>)}
            {proof.blockTimeMs && (<><dt>Sworn</dt><dd>{new Date(proof.blockTimeMs).toLocaleString()}</dd></>)}
            {proof.contract && (<><dt>Recorded on</dt><dd className="mono">{proof.contract}</dd></>)}
            <dt>Transaction</dt>
            <dd>
              <a className="link mono" href={`${EXPLORER_TX}${proof.txHash}`} target="_blank" rel="noreferrer">
                {proof.txHash}
              </a>
            </dd>
          </dl>
          <ul className="checks">
            {proof.checks.map((ch) => (
              <li key={ch.id} data-check-id={ch.id} data-ok={String(ch.ok)}>
                <span className={ch.ok ? 'mark-ok' : 'mark-bad'} aria-hidden>{ch.ok ? '✓' : '✕'}</span>
                <span>
                  {ch.label} <span className="sr-only">{ch.ok ? '(passed)' : '(failed)'}</span>
                  {ch.detail && <div className="detail">{ch.detail}</div>}
                </span>
              </li>
            ))}
          </ul>
          <div className="actions" style={{ marginTop: 24 }}>
            <button
              className="btn quiet"
              onClick={async () => {
                await navigator.clipboard.writeText(location.href);
                setCopied(true);
              }}
            >
              {copied ? 'Link copied' : 'Copy link to this proof'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
