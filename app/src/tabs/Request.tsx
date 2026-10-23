import { useEffect, useMemo, useState } from 'react';
import { makeChallenge, type Challenge } from '../lib/challenge';
import { loadTokens, toUnits, type Token } from '../lib/tokens';

const EXPIRY = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '24 hours', minutes: 24 * 60 },
  { label: '7 days', minutes: 7 * 24 * 60 },
];

export function Request() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [made, setMade] = useState<{ challenge: Challenge; token: Token; amount: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  const link = made ? `${location.origin}${location.pathname}?c=${encodeURIComponent(made.challenge.text)}` : '';

  if (made) {
    return (
      <section>
        <h1>Your request is ready</h1>
        <p className="lede">Send this link to the person whose funds you want confirmed. They answer it with their own wallet; you never see their balance.</p>
        <div className="jurat">
          <p className="statement">
            Show that you hold at least {made.amount} {made.token.symbol} in a NEAR confidential account.
          </p>
          <dl>
            <dt>Answer before</dt>
            <dd>{new Date(made.challenge.expiresMs).toLocaleString()}</dd>
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
          if (!token || !units.value) return;
          setMade({ challenge: makeChallenge(token.assetId, units.value, minutes), token, amount: amount.trim() });
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
        <div className="actions">
          <button className="btn" type="submit" disabled={!token || !units.value}>
            Make request link
          </button>
        </div>
      </form>
    </section>
  );
}
