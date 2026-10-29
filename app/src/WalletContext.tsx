// One wallet state for the whole app: the header shows it, Prove and Request
// use it, and it follows sign-ins and sign-outs that happen inside the wallet.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { connect as openWallet, currentWallet, disconnect as closeWallet, getConnector, type Connected } from './lib/wallet';
import { availableNear } from './lib/account';

interface WalletState {
  who: Connected | null;
  /** False until the app has asked the connector whether a wallet is already signed in. */
  ready: boolean;
  /** Spendable NEAR, or null while unknown. */
  available: bigint | null;
  connect: () => Promise<Connected>;
  disconnect: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [who, setWho] = useState<Connected | null>(null);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState<bigint | null>(null);

  useEffect(() => {
    currentWallet().then((w) => {
      setWho(w);
      setReady(true);
    });
    const connector = getConnector();
    connector.on('wallet:signIn', () => currentWallet().then(setWho));
    connector.on('wallet:signOut', () => setWho(null));
  }, []);

  const refreshBalance = useCallback(async () => {
    setAvailable(who ? await availableNear(who.accountId) : null);
  }, [who]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  const connect = useCallback(async () => {
    const w = await openWallet();
    setWho(w);
    return w;
  }, []);

  const disconnect = useCallback(async () => {
    await closeWallet();
    setWho(null);
  }, []);

  const value = useMemo(
    () => ({ who, ready, available, connect, disconnect, refreshBalance }),
    [who, ready, available, connect, disconnect, refreshBalance],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(WalletContext);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export const declined = (e: unknown) => /reject|denied|cancel|closed/i.test(String((e as Error)?.message ?? e));
