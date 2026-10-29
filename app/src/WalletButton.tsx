import { useEffect, useRef, useState } from 'react';
import { declined, useWallet } from './WalletContext';
import { nearText, shortAccount } from './lib/account';

export function WalletButton() {
  const { who, ready, available, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('mousedown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!ready) return <span className="wallet-slot" aria-hidden />;

  if (!who) {
    return (
      <div className="wallet" ref={box}>
        <button
          className="btn quiet small-btn"
          data-wallet="disconnected"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await connect();
            } catch (e) {
              if (!declined(e)) setError(String((e as Error)?.message ?? e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Opening wallet…' : 'Connect wallet'}
        </button>
        {error && <span className="wallet-error" role="alert">{error}</span>}
      </div>
    );
  }

  return (
    <div className="wallet" ref={box}>
      <button
        className="btn quiet small-btn account-chip"
        data-wallet="connected"
        data-account={who.accountId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dot" aria-hidden />
        {shortAccount(who.accountId)}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className="mono small">{who.accountId}</span>
            <span className="muted small">{available != null ? `${nearText(available)} NEAR available` : 'Balance unavailable'}</span>
          </div>
          <button
            role="menuitem"
            onClick={async () => {
              await navigator.clipboard.writeText(who.accountId);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Account copied' : 'Copy account'}
          </button>
          <a role="menuitem" href={`https://nearblocks.io/address/${who.accountId}`} target="_blank" rel="noreferrer">
            View on NearBlocks
          </a>
          <button
            role="menuitem"
            className="danger"
            onClick={async () => {
              setOpen(false);
              await disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
