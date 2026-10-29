# Jurat

Prove that a NEAR confidential balance is at least some amount, without revealing the balance.

A verifier asks "do you hold at least 250 USDC?". The holder answers with their own wallet. A small program inside an Intel TDX enclave on [OutLayer](https://outlayer.ai) reads the holder's confidential balance from NEAR Intents and outputs only `confirmed`, `not_confirmed` or `refused`. Anyone can check the answer from public data: the NEAR transaction, OutLayer's attestation, and Intel's signature on it.

Built for [NEAR HACKATHON](https://nearhackathon.com), aimed at the Privacy & Private AI and Real-World Money tracks.

## The problem

NEAR [Confidential Intents](https://docs.near-intents.org/integration/market-makers/confidential-intents) and [Trezu confidential treasuries](https://github.com/NEAR-DevHub/trezu-docs) keep balances on a private chain, visible only to their owner. That protects people from being watched and targeted. It also takes away the one thing a public balance gave them: proof. Before an OTC trade, a rental, a grant payout or a visa application, the holder can only send a screenshot or say "trust me".

Jurat keeps the balance private and adds the proof.

## How it works

1. **Request.** The verifier makes a request: token, minimum amount (in the token's smallest unit) and expiry. It is plain text that describes itself:
   `jurat:v1:<expiresMs>:<nonce>:<threshold>:<tokenId>`
2. **Sign.** The holder's wallet signs an **empty** intent for `intents.near` (NEP-413). It moves nothing. Its nonce carries `sha256(request)[0..7]`, so the signature answers this one request and no other.
3. **Run.** The holder sends one transaction to `outlayer.near` (`request_execution`) with the pinned enclave release as a `WasmUrl` source (URL plus sha256). Inside the TEE the enclave:
   - refuses an intent that is not empty, or not made for this request, before any network call;
   - logs in to NEAR Intents' 1Click API with the signed intent (`/v0/auth/authenticate`) and reads the confidential balance (`/v0/account/balances`, read-only);
   - prints only the verdict, the account, the token, the threshold and the request text. The amount and the session token never leave.
4. **Check.** Anyone takes the transaction hash and checks, in their own browser or with the script below:
   - the transaction went to `outlayer.near` and ran a published Jurat enclave hash;
   - the input carries the request, and the output echoes the same request, token and threshold;
   - it was sent before the request expired;
   - OutLayer's attestation for that run: Intel's DCAP signature on the TDX quote, debug mode off, all five measurements approved on `worker.outlayer.near`, the task hash in the quote's REPORTDATA binding this exact code, input and output, and the attested input, output and wasm hashes matching the transaction.

No Jurat server sits anywhere in this path. The app is static.

## Try it

Commands assume Node 24, Python 3.10+ and, for the enclave, [wasmtime](https://wasmtime.dev) 38 or later.

### 1. Verify three real mainnet runs yourself

```bash
pip install dcap-qvl
python spike/outlayer/verify_attestation.py 93b9aab6398021efda26aa56d64ce803c1917cffd90e06ae253f00d118efa3b4 1111354 1111371 1111376
```

You should see 8 `PASS` lines per attestation and `ALL PASS`. These are the three spike runs on `outlayer.near` (threshold 0, threshold 1, stale intent), made with throwaway keys that hold nothing.

### 2. Check a run in the app

```bash
cd app
npm ci
npm run dev
```

Open the local URL, choose **Check**, and enter transaction `9pJpnKExPT7bn6HCrdWG9u3z21d1dFudMRNGdrmHih4J` sent by `juratapp.near`. Every attestation check passes, including Intel's signature verified in the browser, and the page still says **Not a valid Jurat proof**: that spike run predates requests, so it carries none. That refusal is the point; a run only counts when it answers a request.

### 3. Make a request and answer it

In the app, **Request**: choose a token and amount, then copy the link. Open it: **Prove** walks you through one step at a time (connect a NEAR wallet, sign the empty intent, register your key with NEAR Intents once if your account never has, run the proof for about 0.002 NEAR). It ends on **Check** with the result.

A named NEAR account must register its key on `intents.near` once (`add_public_key`, 1 yoctoNEAR) before NEAR Intents accepts its signature. Prove detects this and asks.

### 4. Run the enclave locally

```bash
curl -LO https://github.com/nftkingiii/jurat/releases/download/enclave-v0.2.0/jurat-enclave.wasm
sha256sum jurat-enclave.wasm   # f59eb06d922dc2cd0e1dbd30f8ec0886855f9d9ffda88f3d28d8159f42bd83a7

C="jurat:v1:1792800000000:0011223344556677:1:nep141:wrap.near"
node spike/local/make-request.mjs nep141:wrap.near 1 --challenge=$C | wasmtime run -S http jurat-enclave.wasm
node spike/local/make-request.mjs nep141:wrap.near 1 --challenge=$C --sign-for=jurat:v1:1792800000000:ffffffffffffffff:1:nep141:wrap.near | wasmtime run -S http jurat-enclave.wasm
```

The first is signed for the request: it logs in to live NEAR Intents (`auth_status` 201, `balances_status` 200) and answers `not_confirmed`, because the throwaway key holds nothing. The second is signed for a different request: `refused`, "the signed intent was not made for this challenge", with no network call.

### 5. Tests

```bash
cargo test --locked                       # enclave, from the repo root
(cd contract && cargo test --locked)      # statement contract
(cd app && npx vitest run)                # app library
(cd app && LIVE=1 npx vitest run)         # plus a live check of mainnet tx 9pJpnKEx
```

## What has been verified

| Claim | Evidence |
|---|---|
| The read path works: a signed empty intent gets a NEAR Intents session and a confidential balance read; a tampered or stale intent is refused | `spike/local/auth-balances.mjs` against live 1Click (201, 200; 401, 401, 401) |
| The enclave ran inside OutLayer on mainnet | [9pJpnKEx](https://nearblocks.io/txns/9pJpnKExPT7bn6HCrdWG9u3z21d1dFudMRNGdrmHih4J) `confirmed` (threshold 0), [E8aGixn6](https://nearblocks.io/txns/E8aGixn6j1khD1tHUSLh9L6MD3ULMND9GbTrMC52odv9) `not_confirmed` (threshold 1), [ArvXm2Nm](https://nearblocks.io/txns/ArvXm2Nmo6ChhZEnLvStovMTpYcab4AT4hcQC6rvCDWK) `refused` (stale intent) |
| OutLayer's attestations for those runs hold up, checked independently | [1111354](https://api.outlayer.ai/attestations/1111354), [1111371](https://api.outlayer.ai/attestations/1111371), [1111376](https://api.outlayer.ai/attestations/1111376); `verify_attestation.py` and the app's `checkProof` both pass every check |
| Requests are bound into the signature and echoed by the enclave | [enclave-v0.2.0](https://github.com/nftkingiii/jurat/releases/tag/enclave-v0.2.0), run under wasmtime against live NEAR Intents (step 4) |
| The released wasm matches the source | built by [CI](.github/workflows/release.yml) with rust 1.85.0 from the tagged commit, paths remapped out of the binary; sha256 in the release |
| The statement contract behaves as specified | 17 unit tests with mocked OutLayer callbacks (`contract/src/tests.rs`) |
| A challenge answered through the contract, inside OutLayer, with enclave-v0.2.0 | challenge 0 opened in [H2fG3Qbz](https://nearblocks.io/txns/H2fG3QbzsgsXNeAx84VkwDgbwf8EV1E8J5F8Znrs4vJ6), proved in [6FP7Pqoj](https://nearblocks.io/txns/6FP7PqojHNGzLmJDm3KfAmBiohjAEC2y1hwsKpefQypM): statement 0, `not_confirmed` (throwaway holder, threshold 1 yoctoNEAR of wNEAR), read back with `get_challenge`; attestation [1184714](https://api.outlayer.ai/attestations/1184714) passes every check |
| **A real, funded confidential balance proven: Confirmed** | `juratapp.near` deposited USDC into its near.com confidential balance, then recorded challenge 2 (at least 1 USDC, [Ba6hPuFR](https://nearblocks.io/txns/Ba6hPuFRbPjkmMJVFsJ55KJk1mnmczHQQxS6hbem1G8U)) and proved it ([EPSQKGKG](https://nearblocks.io/txns/EPSQKGKGiudsv77ZeehCo75Cz1FUSRX27sjHCi9tLnJw)). The enclave read the private balance and answered `confirmed`; the contract recorded the statement and marked the challenge confirmed. The amount appears nowhere. Attestation [1195207](https://api.outlayer.ai/attestations/1195207) passes every check; all 19 checks pass in the app |
| A real wallet ran the whole app flow | `juratapp.near` in Meteor: request recorded as challenge 1 ([AGxntGb5](https://nearblocks.io/txns/AGxntGb5ekmBg4BiXash3rY3jbt2Q1D6xbCmgwrEZjvR)), key registered on `intents.near` ([3VRG1t33](https://nearblocks.io/txns/3VRG1t33h7nJheg93A5PV32m7spTDVSDgaB92xxyNu7E)), NEP-413 signature, proof through the contract ([CgiCUiFQ](https://nearblocks.io/txns/CgiCUiFQ1V4r4oAqoRQ2WQM4NunkcD833VXiugXg4VXr)): the enclave logged in to NEAR Intents as `juratapp.near` and the contract recorded `not_confirmed` for at least 1 USDC (the account holds no confidential USDC); attestation [1194952](https://api.outlayer.ai/attestations/1194952) passes every check, and all 19 checks pass in the app |
| The statement contract is live on mainnet | `juratapp.near`, deployed and initialised in [EKojmXxZ](https://nearblocks.io/txns/EKojmXxZDhxmqHUkHeVGBXiezJxdY3CYcH2BsFKGndBJ); its code hash `7AEdAAvC…ExYEw` is the base58 of the built wasm's sha256 `5b83c0bd…612c`; `get_config` returns owner `juratapp.near`, `outlayer.near` and enclave-v0.2.0 |

## Not yet done

- Rebuilding the release byte-for-byte outside GitHub Actions.
- Hosting the app.

## What you must trust

- **The enclave and OutLayer.** A result is only as good as Intel TDX isolation and OutLayer's approved worker builds. The attestation proves which code produced which output from which input; it does not prove that code is correct. The enclave is small; read [enclave/src/main.rs](enclave/src/main.rs).
- **NEAR Intents' report of the balance.** The enclave believes what `/v0/account/balances` returns. Confidential balances live on a permissioned chain that the public cannot inspect, so Jurat cannot show that chain is solvent or that the balance is backed.
- **Freshness is "at the time of the run".** A confirmed statement says the balance met the threshold when the enclave read it, not afterwards.
- **What is public.** The holder's account id, the token, the threshold and the request text are public in the transaction. The amount is not.

## Repository

| Path | What |
|---|---|
| `enclave/` | The WASI P2 program OutLayer runs (Rust, held to rust 1.85) |
| `app/` | Static web app: Request, Prove, Check (Vite, React, NEAR Connect, `@phala/dcap-qvl`) |
| `contract/` | Statement contract for an on-chain registry of statements (near-sdk 5.29), live at `juratapp.near` |
| `spike/local/` | Signing an empty intent, building enclave requests |
| `spike/outlayer/` | Running the enclave on OutLayer, verifying attestations, deploying the contract |
| `.github/workflows/` | Tests on push; the enclave release on `enclave-v*` tags |

## Built on

[NEAR Intents](https://docs.near-intents.org) and its 1Click API (confidential balances, signed-intent sessions), [OutLayer](https://outlayer.ai) (TEE execution of a pinned wasm, attestations), [NEAR Connect](https://docs.near.org/tools/near-connect) (wallets), NEP-413 message signing, and [dcap-qvl](https://github.com/Phala-Network/dcap-qvl) (Intel quote verification).
