// Everything a Jurat proof is pinned to. Changing ENCLAVE is a new release:
// statements made with an older hash stay checkable against that hash.

export const RPC = 'https://rpc.mainnet.fastnear.com';
/** Transactions and blocks older than about two days are only on archival nodes. */
export const ARCHIVAL_RPC = 'https://archival-rpc.mainnet.fastnear.com';
export const ONECLICK = 'https://1click.chaindefuser.com';
export const OUTLAYER = 'outlayer.near';
export const OUTLAYER_API = 'https://api.outlayer.ai';
export const WORKER_REGISTER = 'worker.outlayer.near';
export const INTENTS = 'intents.near';
export const EXPLORER_TX = 'https://nearblocks.io/txns/';

export interface EnclaveRelease {
  tag: string;
  url: string;
  hash: string;
  /** Echoes and checks challenges (needed for a Jurat proof). */
  challenges: boolean;
}

const release = (tag: string, hash: string, challenges: boolean): EnclaveRelease => ({
  tag,
  url: `https://github.com/nftkingiii/jurat/releases/download/${tag}/jurat-enclave.wasm`,
  hash,
  challenges,
});

/** Releases a checker accepts, newest first. The first is what Prove runs. */
export const ENCLAVES: EnclaveRelease[] = [
  release('enclave-v0.2.0', 'f59eb06d922dc2cd0e1dbd30f8ec0886855f9d9ffda88f3d28d8159f42bd83a7', true),
  release('enclave-v0.1.0-spike.1', '93b9aab6398021efda26aa56d64ce803c1917cffd90e06ae253f00d118efa3b4', false),
];

export const RESOURCE_LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
/** OutLayer reserves 50 Tgas for its callback; 80 Tgas keeps the up-front reservation small. */
export const PROVE_GAS = '80000000000000';
