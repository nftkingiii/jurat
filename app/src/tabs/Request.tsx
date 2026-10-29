import { useEffect, useMemo, useState } from 'react';
import { makeChallenge, type Challenge } from '../lib/challenge';
import { loadTokens, toUnits, type Token } from '../lib/tokens';
import { createChallengeTx, DEFAULT_CONTRACT, toChallenge, type ContractChallenge } from '../lib/contract';
import { EXPLORER_TX } from '../lib/config';
import { declined, useWallet } from '../WalletContext';
import { NEEDS, nearText } from '../lib/account';

const EXPIRY = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '24 hours', minutes: 24 * 60 },
  { label: '7 days', minutes: 7 * 24 * 60 },
];

export function Request() {
  const { who, connect, available, refreshBalance } = useWallet();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [made, setMade] = useState<{ challenge: Challenge; token: Token; amount: string; onChain?: { id: string; tx: string } } | null>(null);
  const [copied, setCopied] = useState(false);
  // On chain: the contract enforces the expiry and keeps every statement public.
  const [record, setRecord] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadTokens()
      .then((t) => {
        setTokens(t);
        setAssetId(t[0]?.assetId ?? '');
      })
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  const token = tokens?.find((t) => t.assetId === assetId);
  const units = useMemo(() => {
    if (!token || !amount) return { value: '', error: '' };
    try {
      return { value: toUnits(amount, token.decimals), error: '' };
    } catch (e) {
      return { value: '', error: (e as Error).message };
    }
  }, [amount, token]);

  const link = !made
    ? ''
    : made.onChain
      ? `${location.origin}${location.pathname}?contract=${DEFAULT_CONTRACT}&id=${made.onChain.id}`
      : `${location.origin}${location.pathname}?c=${encodeURIComponent(made.challenge.text)}`;

  const submit = async () => {
    if (!token || !units.value) return;
    setError('');
    if (!record) {
      setMade({ challenge: makeChallenge(token.assetId, units.value, minutes), token, amount: amount.trim() });
      return;
    }
    setBusy(true);
    try {
      const w = who ?? (await connect());
      const outcome: any = await w.wallet.signAndSendTransaction(createChallengeTx(DEFAULT_CONTRACT, token.assetId, units.value, minutes));
      const value = outcome?.status?.SuccessValue;
      if (!value) throw new Error('The contract did not return the new challenge.');
      const c: ContractChallenge = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (x) => x.charCodeAt(0))));
      const tx = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? '';
      setMade({ challenge: toChallenge(c), token, amount: amount.trim(), onChain: { id: c.id, tx } });
      refreshBalance();
    } catch (e) {
      setError(declined(e) ? 'You declined in your wallet. Nothing was recorded.' : String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <section data-request-link={link} data-challenge={made.challenge.text}>
        <h1>Your request is ready</h1>
        <p className="lede">Send this link to the person whose funds you want confirmed. They answer it with their own wallet; you never see their balance.</p>
        <div className="jurat">
          <p className="statement">
            Show that you hold at least {made.amount} {made.token.symbol} in a NEAR confidential account.
          </p>
          <dl>
            <dt>Answer before</dt>
            <dd>{new Date(made.challenge.expiresMs).toLocaleString()}</dd>
            {made.onChain && (
              <>
                <dt>Recorded</dt>
                <dd>
                  challenge {made.onChain.id} on {DEFAULT_CONTRACT}
                  {made.onChain.tx && (
                    <>
                      {' · '}
                      <a className="link" href={`${EXPLORER_TX}${made.onChain.tx}`} target="_blank" rel="noreferrer">
                        transaction
                      </a>
                    </>
                  )}
                </dd>
              </>
            )}
            <dt>Link</dt>
            <dd className="mono">{link}</dd>
          </dl>
        </div>
        <div className="actions" style={{ marginTop: 24 }}>
          <button
            className="btn seal"
            onClick={async () => {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <button className="btn quiet" onClick={() => { setMade(null); setCopied(false); }}>
            New request
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 24 }}>
          When they finish, they get a check link to send back. Anyone can open it in the Check tab and verify the
          result from public data.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Ask for proof of funds, without seeing the balance</h1>
      <p className="lede">
        Choose a token and an amount. The holder proves their NEAR confidential balance is at least that much, inside
        an attested enclave. Only yes or no leaves it.
      </p>

      {loadError && <p className="notice bad">Could not load tokens from NEAR Intents: {loadError}</p>}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="row">
          <label>
            Token
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)} disabled={!tokens}>
              {!tokens && <option>Loading…</option>}
              {tokens?.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
          <label>
            At least
            <input
              inputMode="decimal"
              placeholder="1000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!units.error}
              aria-describedby="amount-error"
            />
            {units.error && <span id="amount-error" className="field-error">{units.error}</span>}
          </label>
        </div>
        <label>
          They have until
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.minutes} value={x.minutes}>
                {x.label} from now
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
          <span>
            Record it on NEAR
            <span className="hint">
              {' '}The Jurat contract enforces the deadline and keeps the answer public. Your wallet signs once and holds
              about 0.004 NEAR of storage; the rest is refunded.
              {record && (who ? ` It is recorded from ${who.accountId}.` : ' You connect a wallet when you submit.')}
            </span>
          </span>
        </label>
        {record && who && available != null && available < NEEDS.record && (
          <p className="notice bad">
            {who.accountId} has {nearText(available)} NEAR free; recording needs about {nearText(NEEDS.record, 2)}. Add NEAR,
            or untick recording to make a link only.
          </p>
        )}
        {error && <p className="notice bad">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={!token || !units.value || busy}>
            {busy ? 'Waiting for your wallet…' : record ? 'Record request and make link' : 'Make request link'}
          </button>
        </div>
      </form>
    </section>
  );
}
