import { rpc } from './rpc';

/** 0.00001 NEAR per byte of storage (protocol 86). */
const BYTE_COST = 10n ** 19n;
const YOCTO = 10n ** 24n;

/** NEAR the account can spend: its balance minus what its storage locks. */
export async function availableNear(accountId: string): Promise<bigint | null> {
  try {
    const a = await rpc<{ amount: string; storage_usage: number }>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    const free = BigInt(a.amount) - BigInt(a.storage_usage) * BYTE_COST;
    return free > 0n ? free : 0n;
  } catch {
    return null;
  }
}

export function nearText(yocto: bigint, digits = 3): string {
  const whole = yocto / YOCTO;
  const frac = (yocto % YOCTO).toString().padStart(24, '0').slice(0, digits);
  return `${whole}.${frac}`;
}

/** What a step needs to have free for a moment: NEAR reserves prepaid gas up front and refunds it. */
export const NEEDS = {
  /** create_challenge: 30 Tgas reserved at ~0.001 NEAR/Tgas, plus the 0.005 storage deposit. */
  record: 4n * 10n ** 22n,
  /** prove through the contract: 100 Tgas plus OutLayer's fee and the 0.01 statement reserve. */
  proveContract: 13n * 10n ** 22n,
  /** a direct OutLayer run: 80 Tgas plus OutLayer's fee. */
  proveDirect: 9n * 10n ** 22n,
};

/** Long implicit accounts (64 hex characters) read better shortened in the middle. */
export function shortAccount(id: string): string {
  return id.length > 24 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
