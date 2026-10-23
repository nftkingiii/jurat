import { ENCLAVES, OUTLAYER, PROVE_GAS, RESOURCE_LIMITS, type EnclaveRelease } from './config';
import { view } from './rpc';
import type { Challenge } from './challenge';

/** The enclave input, exactly as the holder's transaction will carry it. */
export function enclaveInput(signedData: object, challenge: Challenge): string {
  return JSON.stringify({
    signedData,
    tokenId: challenge.tokenId,
    threshold: challenge.threshold,
    challenge: challenge.text,
  });
}

/** OutLayer's own estimate, in yoctoNEAR, for our limits and this input. */
export async function estimateCost(inputLength: number): Promise<bigint> {
  const cost = await view<string>(OUTLAYER, 'estimate_execution_cost', {
    resource_limits: RESOURCE_LIMITS,
    input_len: inputLength,
  });
  return BigInt(cost);
}

/** The transaction the holder's wallet signs: one request_execution call. */
export function proveTransaction(input: string, deposit: bigint, payer: string, enclave: EnclaveRelease = ENCLAVES[0]) {
  return {
    receiverId: OUTLAYER,
    actions: [
      {
        type: 'FunctionCall' as const,
        params: {
          methodName: 'request_execution',
          args: {
            source: { WasmUrl: { url: enclave.url, hash: enclave.hash, build_target: 'wasm32-wasip2' } },
            resource_limits: RESOURCE_LIMITS,
            input_data: input,
            response_format: 'Json',
            payer_account_id: payer,
          },
          gas: PROVE_GAS,
          deposit: deposit.toString(),
        },
      },
    ],
  };
}
