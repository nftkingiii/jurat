import { useEffect, useMemo, useState } from 'react';
import { go } from '../App';
import { parseChallenge, type Challenge } from '../lib/challenge';
import { ENCLAVES, INTENTS } from '../lib/config';
import { keyRegistered, signedData, signRequest, type SignRequest } from '../lib/intent';
import { enclaveInput, estimateCost, proveTransaction } from '../lib/outlayer';
import { CONTRACTS, getChallenge, proveTx, toChallenge } from '../lib/contract';
import { fromUnits, loadTokens, type Token } from '../lib/tokens';
import { connect, currentWallet, type Connected } from '../lib/wallet';

type Step = 'connect' | 'sign' | 'register' | 'send' | 'sending';

interface Signed {
  req: SignRequest;
  data: ReturnType<typeof signedData>;
  publicKey: string;
  at: number;
}

/** Where the request comes from: self-describing link text, or a challenge on a Jurat contract. */
type Source = { kind: 'link' } | { kind: 'contract'; contract: string; id: string };

function readLink(): { source: Source | null; challenge: Challenge | null; error: string } {
  const q = new URLSearchParams(location.search);
  const contract = q.get('contract');
  const id = q.get('id');
  if (contract && id) {
    if (!CONTRACTS[contract] || !/^\d{1,20}$/.test(id)) return { source: null, challenge: null, error: 'This link names an unknown Jurat contract.' };
    return { source: { kind: 'contract', contract, id }, challenge: null, error: '' };
  }
  const text = q.get('c');
  if (!text) return { source: null, challenge: null, error: '' };
  try {
    return { source: { kind: 'link' }, challenge: parseChallenge(text), error: '' };
  } catch {
    return { source: null, challenge: null, error: 'This link does not contain a valid Jurat request.' };
  }
}

const declined = (e: unknown) => /reject|denied|cancel|closed/i.test(String((e as Error)?.message ?? e));

export function Prove() {
  const [link] = useState(readLink);
  const [challenge, setChallenge] = useState<Challenge | null>(link.challenge);
  const [linkError, setLinkError] = useState(link.error);
  const [loading, setLoading] = useState(link.source?.kind === 'contract');
  const source = link.source;
  const [pasted, setPasted] = useState('');
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [who, setWho] = useState<Connected | null>(null);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [step, setStep] = useState<Step>('connect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cost, setCost] = useState<bigint | null>(null);

  useEffect(() => {
    if (source?.kind === 'contract') {
      getChallenge(source.contract, source.id)
        .then((c) => (c ? setChallenge(toChallenge(c)) : setLinkError('There is no such challenge on the Jurat contract.')))
        .catch((e) => setLinkError(`Could not read the challenge from ${source.contract}: ${String(e.message ?? e)}`))
        .finally(() => setLoading(false));
    }
  }, [source]);

  useEffect(() => {
    loadTokens().then(setTokens).catch(() => setTokens([]));
    currentWallet().then((w) => {
      if (w) {
        setWho(w);
        setStep('sign');
      }
    });
  }, []);

  const token = tokens?.find((t) => t.assetId === challenge?.tokenId);
  // Until the token list loads, say nothing rather than show raw units.
  const amount = !challenge || !tokens ? '' : token ? `${fromUnits(challenge.threshold, token.decimals)} ${token.symbol}` : `${challenge.threshold} units of ${challenge.tokenId}`;
  const expired = !!challenge && Date.now() > challenge.expiresMs;
  const release = ENCLAVES[0];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(declined(e) ? 'You declined in your wallet. Nothing was signed or sent.' : String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const doConnect = () =>
    run(async () => {
      setWho(await connect());
      setStep('sign');
    });

  const doSign = () =>
    run(async () => {
      const req = await signRequest(who!.accountId, challenge!.text);
      const out = await who!.wallet.signMessage({ message: req.message, recipient: req.recipient, nonce: req.nonce });
      const s = { req, data: signedData(req, out.publicKey, out.signature), publicKey: out.publicKey, at: Date.now() };
      setSigned(s);
      setStep((await keyRegistered(who!.accountId, out.publicKey)) ? 'send' : 'register');
    });

  const doRegister = () =>
    run(async () => {
      await who!.wallet.signAndSendTransaction({
        receiverId: INTENTS,
        actions: [{ type: 'FunctionCall', params: { methodName: 'add_public_key', args: { public_key: signed!.publicKey }, gas: '50000000000000', deposit: '1' } }],
      });
      // The wallet can return before the change is final; wait for intents.near to show the key.
      let registered = false;
      for (let i = 0; i < 15 && !registered; i++) {
        registered = await keyRegistered(who!.accountId, signed!.publicKey);
        if (!registered) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!registered) throw new Error('The registration was sent but intents.near does not show the key yet. Reload this page in a minute and sign again; do not register twice.');
      // The signed intent is valid for 5 minutes; sign again if it is close to expiring.
      setStep(Date.now() - signed!.at > 4 * 60_000 ? 'sign' : 'send');
    });

  const input = useMemo(() => (signed && challenge ? enclaveInput(signed.data, challenge) : ''), [signed, challenge]);
  useEffect(() => {
    if (step === 'send' && input) estimateCost(input.length).then(setCost).catch(() => setCost(null));
  }, [step, input]);

  const doSend = () =>
    run(async () => {
      if (Date.now() - signed!.at > 4 * 60_000) {
        setStep('sign');
        throw new Error('Your signature is about to expire. Sign again, then run the proof.');
      }
      const deposit = cost ?? (await estimateCost(input.length));
      setStep('sending');
      // Through the contract it records a public statement and enforces expiry on chain.
      const tx =
        source?.kind === 'contract'
          ? proveTx(source.contract, source.id, signed!.data, deposit)
          : proveTransaction(input, deposit, who!.accountId, release);
      const outcome: any = await who!.wallet.signAndSendTransaction(tx);
      const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
      if (!hash) throw new Error('The wallet sent the transaction but did not return its hash.');
      go({ tx: hash, from: who!.accountId, c: challenge!.text });
    }).finally(() => setStep((s) => (s === 'sending' ? 'send' : s)));

  if (loading) {
    return (
      <section>
        <h1>Reading the request…</h1>
        <p className="lede">Loading the challenge from the Jurat contract on NEAR.</p>
      </section>
    );
  }

  if (!challenge) {
    return (
      <section>
        <h1>Answer a request</h1>
        <p className="lede">Open the link a verifier sent you, or paste it here.</p>
        {linkError && <p className="notice bad">{linkError}</p>}
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const url = new URL(pasted.trim());
              const c = url.searchParams.get('c');
              const contract = url.searchParams.get('contract');
              const id = url.searchParams.get('id');
              if (contract && id) location.assign(`${location.pathname}?contract=${encodeURIComponent(contract)}&id=${encodeURIComponent(id)}`);
              else if (c) location.assign(`${location.pathname}?c=${encodeURIComponent(c)}`);
              else throw new Error('no request');
            } catch {
              setError('Paste the full request link.');
            }
          }}
        >
          <label>
            Request link
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…?c=jurat:v1:…" />
          </label>
          {error && <p className="field-error">{error}</p>}
          <div className="actions">
            <button className="btn" type="submit" disabled={!pasted.trim()}>
              Open request
            </button>
          </div>
        </form>
      </section>
    );
  }

  const order: Step[] = ['connect', 'sign', 'register', 'send'];
  const at = order.indexOf(step === 'sending' ? 'send' : step);
  const state = (s: Step) => (order.indexOf(s) < at ? 'done' : order.indexOf(s) === at ? 'now' : '');

  return (
    <section>
      <h1>{amount ? `Prove you hold at least ${amount}` : 'Prove your balance'}</h1>
      <p className="lede">
        Your balance is read inside an attested enclave and never leaves it. The requester learns only whether it meets
        the amount, before {new Date(challenge.expiresMs).toLocaleString()}.
      </p>

      {expired && <p className="notice bad">This request has expired. Ask the requester for a new link.</p>}
      {!release.challenges && (
        <p className="notice">
          The published enclave ({release.tag}) predates request binding, so proofs cannot be answered yet. A new enclave
          release is needed first.
        </p>
      )}

      <ol className="steps">
        <li className={state('connect')}>
          <span className="n">1</span>
          <div className="body">
            <span className="title">{who ? `Connected as ${who.accountId}` : 'Connect the NEAR account that holds the funds'}</span>
            {step === 'connect' && (
              <div className="actions">
                <button className="btn" onClick={doConnect} disabled={busy || expired}>
                  {busy ? 'Opening wallet…' : 'Connect wallet'}
                </button>
              </div>
            )}
          </div>
        </li>
        <li className={state('sign')}>
          <span className="n">2</span>
          <div className="body">
            <span className="title">Sign an empty intent for this request</span>
            {step === 'sign' && (
              <>
                <span className="small muted">It moves nothing and is only valid for this request for 5 minutes.</span>
                <div className="actions">
                  <button className="btn" onClick={doSign} disabled={busy || expired || !release.challenges}>
                    {busy ? 'Waiting for your wallet…' : 'Sign in wallet'}
                  </button>
                </div>
              </>
            )}
          </div>
        </li>
        <li className={state('register')}>
          <span className="n">3</span>
          <div className="body">
            <span className="title">
              {step === 'register' ? 'Register your key with NEAR Intents, once' : at > 2 ? 'Key registered with NEAR Intents' : 'Register your key with NEAR Intents, if needed'}
            </span>
            {step === 'register' && (
              <>
                <span className="small muted">
                  NEAR Intents only accepts signatures from keys your account registered. This one-time transaction
                  costs 1 yoctoNEAR plus gas.
                </span>
                <div className="actions">
                  <button className="btn" onClick={doRegister} disabled={busy}>
                    {busy ? 'Waiting for your wallet…' : 'Register key'}
                  </button>
                </div>
              </>
            )}
          </div>
        </li>
        <li className={state('send')}>
          <span className="n">4</span>
          <div className="body">
            <span className="title">Run the proof in the enclave</span>
            {(step === 'send' || step === 'sending') && (
              <>
                <span className="small muted">
                  Pays OutLayer {cost != null ? `${(Number(cost) / 1e24).toFixed(4)} NEAR` : 'its fee'}
                  {source?.kind === 'contract' ? ' plus 0.01 NEAR for the public statement' : ''}; the unused part is
                  refunded. Your wallet reserves about {source?.kind === 'contract' ? '0.1' : '0.08'} NEAR of gas for a moment.
                </span>
                <div className="actions">
                  <button className="btn seal" onClick={doSend} disabled={busy || expired}>
                    {step === 'sending' ? 'Running in the enclave…' : 'Run proof'}
                  </button>
                </div>
              </>
            )}
          </div>
        </li>
      </ol>

      {error && <p className="notice bad">{error}</p>}
    </section>
  );
}
