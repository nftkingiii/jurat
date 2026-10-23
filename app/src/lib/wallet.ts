// NEAR Connect (the wallet connector NEAR's docs recommend): wallet code runs
// in sandboxed iframes loaded from a shared manifest.

import { NearConnector } from '@hot-labs/near-connect';

let connector: NearConnector | null = null;

export function getConnector(): NearConnector {
  connector ??= new NearConnector({
    network: 'mainnet',
    features: { signMessage: true, signAndSendTransaction: true },
  });
  return connector;
}

export interface Connected {
  accountId: string;
  wallet: Awaited<ReturnType<NearConnector['wallet']>>;
}

export async function currentWallet(): Promise<Connected | null> {
  try {
    const { wallet, accounts } = await getConnector().getConnectedWallet();
    return accounts[0] ? { accountId: accounts[0].accountId, wallet } : null;
  } catch {
    return null;
  }
}

export async function connect(): Promise<Connected> {
  const wallet = await getConnector().connect();
  const accounts = await wallet.getAccounts();
  if (!accounts[0]) throw new Error('The wallet did not share an account');
  return { accountId: accounts[0].accountId, wallet };
}

export async function disconnect(): Promise<void> {
  await getConnector().disconnect();
}
