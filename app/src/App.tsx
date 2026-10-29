import { useEffect, useState } from 'react';
import { Request } from './tabs/Request';
import { Prove } from './tabs/Prove';
import { Check } from './tabs/Check';
import { WalletProvider } from './WalletContext';
import { WalletButton } from './WalletButton';

export type Tab = 'request' | 'prove' | 'check';

const TABS: { id: Tab; label: string }[] = [
  { id: 'request', label: 'Request' },
  { id: 'prove', label: 'Prove' },
  { id: 'check', label: 'Check' },
];

/** Links carry their own state: ?c= or ?contract=&id= opens Prove, ?tx= opens Check. */
function tabFromUrl(): Tab {
  const q = new URLSearchParams(location.search);
  if (q.get('tx')) return 'check';
  if (q.get('c') || (q.get('contract') && q.get('id'))) return 'prove';
  const t = q.get('tab');
  return t === 'prove' || t === 'check' ? t : 'request';
}

export function go(params: Record<string, string>) {
  const q = new URLSearchParams(params);
  history.pushState(null, '', `${location.pathname}?${q}`);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  useEffect(() => {
    const onPop = () => setTab(tabFromUrl());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const select = (t: Tab) => go(t === 'request' ? {} : { tab: t });

  return (
    <WalletProvider>
    <div className="shell">
      <header className="top">
        <a className="mark" href="./" onClick={(e) => { e.preventDefault(); select('request'); }}>
          <img src="/seal.svg" alt="" />
          <span>Jurat</span>
        </a>
        <div className="top-right">
          <nav className="tabs" role="tablist" aria-label="Jurat">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} data-tab={t.id} onClick={() => select(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <WalletButton />
        </div>
      </header>

      <main className="page">
        {tab === 'request' && <Request />}
        {tab === 'prove' && <Prove />}
        {tab === 'check' && <Check />}
      </main>

      <footer className="foot">
        <span>NEAR mainnet. A proof run costs about 0.002 NEAR, paid by the holder.</span>
        <a href="https://github.com/nftkingiii/jurat">Source and how it works</a>
        {/^[0-9a-f]{40}$/.test(__COMMIT__) && (
          <a className="mono" data-commit={__COMMIT__} href={`https://github.com/nftkingiii/jurat/commit/${__COMMIT__}`}>
            build {__COMMIT__.slice(0, 7)}
          </a>
        )}
      </footer>
    </div>
    </WalletProvider>
  );
}
