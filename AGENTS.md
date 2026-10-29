# Jurat for agents

Jurat proves that a NEAR Confidential Intents balance is at least a threshold without revealing it. A program runs inside an OutLayer TDX enclave, logs in to NEAR Intents with the holder's signed empty intent, reads the balance and outputs only a verdict. The statement contract `juratapp.near` on mainnet records each verdict publicly.

This file is for coding agents working in this repo and for agents that use Jurat. People should start with [README.md](README.md).

## Check a proof (read-only, free)

```bash
cd app && npm ci
npm run check -- EPSQKGKGiudsv77ZeehCo75Cz1FUSRX27sjHCi9tLnJw juratapp.near          # human-readable
npm run check -- EPSQKGKGiudsv77ZeehCo75Cz1FUSRX27sjHCi9tLnJw juratapp.near --json   # the full Proof object
```

The exit code is 0 for a valid proof, 1 for an invalid one, and 2 if the check could not run. Read the decision from `ok` and `verdict` (`confirmed`, `not_confirmed` or `refused`). A `verdict` with `ok: false` proves nothing. Pass `--challenge <text>` to require that the proof answers your request.

It is the same `checkProof` the Check tab runs (`app/src/lib/check.ts`). It needs only public data: NEAR archival RPC, the OutLayer attestation API, Intel collateral and `worker.outlayer.near`.

## Read the contract (view calls, free)

| Method | Args | Returns |
|---|---|---|
| `get_challenge` | `{ "id": "2" }` | challenge with `challenge` text, `token_id`, `threshold`, `expires_at_ms`, `confirmed`, `statements[]` |
| `get_statement` | `{ "id": "0" }` | one statement: `verdict`, `holder`, `prover`, `wasm_hash`, `recorded_at_ms` |
| `get_config` | `{}` | owner, OutLayer account, pinned enclave wasm url and sha256 |

A statement on `juratapp.near` is trustworthy only if the contract's code hash is `7AEdAAvC9nc856UEijAgfUzabJMdWtCSNhSSoFXExYEw`. `checkProof` checks this.

## Write calls (spend NEAR, so ask your human first)

- `create_challenge({ token_id, threshold, ttl_minutes })`: attach 0.005 NEAR and use 30 Tgas. Unused storage is refunded. The verifier sends the holder `<app>/?contract=juratapp.near&id=<id>`.
- `prove({ challenge_id, signed_data })`: attach OutLayer's fee plus 0.01 NEAR and use 100 Tgas. Only the holder can make `signed_data`: a NEP-413 signature of an empty intent to `intents.near` whose nonce carries `sha256(challenge)[0..7]`. See `app/src/lib/intent.ts`.
- A holder's key must be registered on `intents.near` once (`add_public_key`, 1 yoctoNEAR).

Never sign for a holder, never move funds, and never put keys in prompts, logs or URLs.

## Driving the web app

The app is static and live at https://jurat.up.railway.app. `/version.json` names the commit it serves. Its URLs:

- `?tab=request`
- `?contract=juratapp.near&id=<id>` (Prove)
- `?tx=<hash>&from=<sender>` (Check).

Stable markers:

- Header: `[data-wallet="connected"|"disconnected"]`. When connected it also carries `data-account`.
- Tabs: `[data-tab]`.
- Prove: `section[data-step]` (`connect`, `sign`, `register`, `send`, `sending`) and `data-challenge`.
- Request result: `section[data-request-link]`.
- Check result: `[data-proof][data-ok][data-verdict][data-holder]`, with one `li[data-check-id][data-ok]` per check.

## Working in this repo

| Path | What | Test |
|---|---|---|
| `enclave/` | WASI P2 Rust program, rust 1.85, built for `wasm32-wasip2` | `cargo test --locked` |
| `contract/` | near-sdk 5.29 statement contract | `cd contract && cargo test --locked` |
| `app/` | Vite + React, NEAR Connect, `@phala/dcap-qvl` | `npx vitest run`; `LIVE=1 npx vitest run` for mainnet |
| `spike/` | Node and Python scripts for signing, OutLayer runs, attestation checks | see README |

Rules:

- Keep the enclave on rust 1.85, because that is OutLayer's build image.
- Releases come only from CI on an `enclave-v*` tag.
- Changing the enclave means a new release and `set_wasm` on the contract.
- Labels must stay honest. Keep "local", "mainnet" and "attested" distinct, and never show demo data as live.
