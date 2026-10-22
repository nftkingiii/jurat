"""Independently verify OutLayer TEE attestations for Jurat enclave runs.

For each attestation id it checks, without trusting OutLayer's dashboard:
  1. the Intel TDX quote: signature chain to Intel via dcap-qvl (the library the
     register-contract uses on chain), TCB status, and that debug mode is off;
  2. identity: all five measurements (MRTD, RTMR0-3) are an approved build on
     worker.outlayer.near (is_measurements_approved);
  3. binding: the Task Hash recomputed from the attestation fields equals the
     first 32 bytes of the quote's REPORTDATA, which Intel signed;
  4. input and output: their sha256 recomputed from our own NEAR transaction
     match the attested input_hash and output_hash;
  5. code: wasm_hash equals the sha256 of the released jurat-enclave.wasm.

Usage: python verify_attestation.py <expected wasm sha256> <attestation id>...
Needs: pip install dcap-qvl
"""

import asyncio
import base64
import hashlib
import json
import struct
import sys
import urllib.request

import dcap_qvl

API = "https://api.outlayer.ai/attestations/"
RPC = "https://rpc.mainnet.fastnear.com"
REGISTER = "worker.outlayer.near"


def get_json(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", "User-Agent": "jurat-verify"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def rpc(method, params):
    out = get_json(RPC, {"jsonrpc": "2.0", "id": "jurat", "method": method, "params": params})
    if "error" in out:
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


def view(account, method, args):
    res = rpc("query", {
        "request_type": "call_function", "finality": "final", "account_id": account,
        "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
    })
    return json.loads(bytes(res["result"]).decode())


def task_hash(a):
    # The V1 layout from out-layer/outlayer worker/src/tdx_attestation.rs
    # (generate_task_attestation). The docs page lists only the fields up to
    # block_height; V1 also binds caller, project, secrets, time and payment.
    # Absent optional fields are skipped; timestamp is always present.
    h = hashlib.sha256()
    h.update(a["task_type"].encode())
    h.update(struct.pack("<q", a["task_id"]))
    for key in ("repo_url", "commit_hash", "build_target", "wasm_hash", "input_hash", "output_hash"):
        if a.get(key):
            h.update(a[key].encode())
    if a.get("block_height") is not None:
        h.update(struct.pack("<Q", a["block_height"]))
    for key in ("caller_account_id", "project_id", "secrets_ref"):
        if a.get(key):
            h.update(a[key].encode())
    h.update(struct.pack("<q", a["timestamp"]))
    if a.get("attached_usd") is not None:
        h.update(a["attached_usd"].encode())
    return h.hexdigest()


def tx_input_output(a):
    tx = rpc("EXPERIMENTAL_tx_status", {
        "tx_hash": a["transaction_hash"], "sender_account_id": a["caller_account_id"], "wait_until": "FINAL",
    })
    input_data = None
    for r in tx["receipts_outcome"]:
        for log in r["outcome"]["logs"]:
            if log.startswith("EVENT_JSON:"):
                event = json.loads(log[len("EVENT_JSON:"):])
                if event.get("event") == "execution_requested":
                    input_data = json.loads(event["data"][0]["request_data"])["input_data"]
    output = base64.b64decode(tx["status"]["SuccessValue"])
    return input_data, output


def sha(b):
    return hashlib.sha256(b).hexdigest()


async def check(att_id, expected_wasm):
    a = get_json(API + str(att_id))
    results = {}

    verified = await dcap_qvl.get_collateral_and_verify(base64.b64decode(a["tdx_quote"]))
    td = json.loads(verified.to_json())["report"]["TD10"]
    results["1 quote signature (Intel DCAP)"] = f"ok, TCB status {verified.status}" + (
        f", advisories {verified.advisory_ids}" if verified.advisory_ids else "")
    results["1 debug mode off"] = not (bytes.fromhex(td["td_attributes"])[0] & 1)

    measurements = {"mrtd": td["mr_td"], "rtmr0": td["rt_mr0"], "rtmr1": td["rt_mr1"],
                    "rtmr2": td["rt_mr2"], "rtmr3": td["rt_mr3"]}
    results["2 measurements approved on worker.outlayer.near"] = view(
        REGISTER, "is_measurements_approved", {"measurements": measurements})
    results["2 rtmr3 equals attested worker_measurement"] = td["rt_mr3"] == a["worker_measurement"]

    signed = td["report_data"][:64]
    results["3 task hash signed by the quote"] = task_hash(a) == signed

    input_data, output = tx_input_output(a)
    results["4 input_hash = sha256(tx input_data)"] = input_data is not None and sha(input_data.encode()) == a["input_hash"]
    results["4 output_hash = sha256(tx result)"] = sha(output) == a["output_hash"]

    results["5 wasm_hash = released jurat-enclave.wasm"] = a["wasm_hash"] == a["executed_wasm_sha256"] == expected_wasm

    print(f"attestation {att_id} | tx {a['transaction_hash']} | block {a['block_height']}")
    print(f"  output: {output.decode()}")
    ok = True
    for k, v in results.items():
        good = v is True or (isinstance(v, str) and v.startswith("ok"))
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {k}: {v}")
    return ok


async def main():
    expected_wasm, ids = sys.argv[1], sys.argv[2:]
    oks = [await check(i, expected_wasm) for i in ids]
    print("ALL PASS" if all(oks) else "SOME CHECKS FAILED")
    sys.exit(0 if all(oks) else 1)


asyncio.run(main())
