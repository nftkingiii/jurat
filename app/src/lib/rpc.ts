import { ARCHIVAL_RPC, RPC } from './config';

let id = 0;

export async function rpc<T = any>(method: string, params: unknown, url = RPC): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `jurat-${++id}`, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error.cause ?? body.error)}`);
  return body.result as T;
}

export async function view<T = any>(accountId: string, methodName: string, args: object): Promise<T> {
  const res = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: accountId,
    method_name: methodName,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(res.result)));
}

export async function txStatus(hash: string, sender: string) {
  return rpc<any>('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' }, ARCHIVAL_RPC);
}
