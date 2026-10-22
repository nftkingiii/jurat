//! Jurat statement contract.
//!
//! A verifier opens a challenge: "prove you hold at least `threshold` of
//! `token_id` before `expires_at_ms`". The holder answers it with an empty
//! intent signed for that challenge. This contract (not the holder) builds the
//! enclave input and asks OutLayer to run the pinned Jurat wasm, so the input,
//! the code and the challenge are all fixed here. OutLayer's answer comes back
//! to `on_result`, which records a public statement only when the enclave
//! echoes this challenge, token and threshold. Amounts never reach the chain.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError,
};
use serde_json::{json, Value};

/// Gas for OutLayer's `request_execution`. OutLayer reserves 50 Tgas of it
/// for its own settlement callback (`MIN_RESPONSE_GAS`); the rest covers the
/// call and the output it hands back.
const OUTLAYER_GAS: Gas = Gas::from_tgas(60);
/// Gas for `on_result`.
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Kept back from a proof's deposit to store its statement; the unused part is
/// refunded to the prover in `on_result`.
const STATEMENT_RESERVE: NearToken = NearToken::from_millinear(10);
/// Statements one challenge may hold, so one challenge cannot grow without bound.
const MAX_STATEMENTS_PER_CHALLENGE: u32 = 5;
const MAX_TTL_MINUTES: u32 = 7 * 24 * 60;
const MAX_REASON_LEN: usize = 120;
const VERDICTS: [&str; 3] = ["confirmed", "not_confirmed", "refused"];

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    #[allow(clippy::too_many_arguments)]
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    );
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Challenges,
    Statements,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Wasm {
    /// https URL of the released jurat-enclave.wasm.
    pub url: String,
    /// Its sha256, lowercase hex. OutLayer runs only bytes with this hash.
    pub hash: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Challenge {
    pub verifier: AccountId,
    pub token_id: String,
    pub threshold: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub nonce: String,
    pub statements: Vec<u64>,
    pub confirmed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Statement {
    pub challenge_id: U64,
    /// "confirmed", "not_confirmed" or "refused".
    pub verdict: String,
    /// The account the signed intent speaks for, as the enclave read it.
    pub holder: Option<String>,
    /// Who sent the proof and paid OutLayer.
    pub prover: AccountId,
    pub token_id: String,
    pub threshold: String,
    pub wasm_hash: String,
    /// Why the enclave refused, when it did.
    pub reason: Option<String>,
    pub recorded_at_ms: U64,
    pub block_height: U64,
}

#[near(serializers = [json])]
pub struct ChallengeView {
    pub id: U64,
    /// The text the holder's signed intent must be bound to.
    pub challenge: String,
    pub verifier: AccountId,
    pub token_id: String,
    pub threshold: String,
    pub created_at_ms: U64,
    pub expires_at_ms: U64,
    pub confirmed: bool,
    pub statements: Vec<Statement>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Jurat {
    owner: AccountId,
    outlayer: AccountId,
    wasm: Wasm,
    challenges: LookupMap<u64, Challenge>,
    statements: LookupMap<u64, Statement>,
    next_challenge: u64,
    next_statement: u64,
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// Deposit beyond the storage the call used is sent back.
fn refund_excess(payer: &AccountId, attached: NearToken, storage_before: u64) {
    let used = env::storage_usage().saturating_sub(storage_before);
    let cost = env::storage_byte_cost().saturating_mul(used as u128);
    require!(attached >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
    let excess = attached.saturating_sub(cost);
    if !excess.is_zero() {
        Promise::new(payer.clone()).transfer(excess).detach();
    }
}

#[near]
impl Jurat {
    #[init]
    pub fn new(owner: AccountId, outlayer: AccountId, wasm: Wasm) -> Self {
        require!(wasm.url.starts_with("https://"), "wasm.url must be https");
        require!(is_sha256_hex(&wasm.hash), "wasm.hash must be 64 lowercase hex characters");
        Self {
            owner,
            outlayer,
            wasm,
            challenges: LookupMap::new(StorageKey::Challenges),
            statements: LookupMap::new(StorageKey::Statements),
            next_challenge: 0,
            next_statement: 0,
        }
    }

    /// Point the contract at a new enclave release. Every statement records
    /// the wasm hash it was made with, so earlier statements keep theirs.
    pub fn set_wasm(&mut self, wasm: Wasm) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        require!(wasm.url.starts_with("https://"), "wasm.url must be https");
        require!(is_sha256_hex(&wasm.hash), "wasm.hash must be 64 lowercase hex characters");
        log!("wasm changed from {} to {}", self.wasm.hash, wasm.hash);
        self.wasm = wasm;
    }

    /// Open a challenge. The caller is the verifier and pays for its storage;
    /// any deposit above that is refunded.
    #[payable]
    pub fn create_challenge(&mut self, token_id: String, threshold: String, ttl_minutes: u32) -> ChallengeView {
        require!(!token_id.is_empty() && token_id.len() <= 128, "token_id must be 1-128 characters");
        require!(is_digits(&threshold), "threshold must be an integer in the token's smallest unit");
        require!((1..=MAX_TTL_MINUTES).contains(&ttl_minutes), "ttl_minutes must be 1 to 10080");

        let before = env::storage_usage();
        let verifier = env::predecessor_account_id();
        let id = self.next_challenge;
        self.next_challenge += 1;
        let created = now_ms();
        let challenge = Challenge {
            verifier: verifier.clone(),
            token_id,
            threshold,
            created_at_ms: created,
            expires_at_ms: created + ttl_minutes as u64 * 60_000,
            nonce: hex::encode(&env::random_seed()[..8]),
            statements: Vec::new(),
            confirmed: false,
        };
        self.challenges.insert(id, challenge);
        self.challenges.flush();
        refund_excess(&verifier, env::attached_deposit(), before);
        self.get_challenge(U64(id)).unwrap()
    }

    /// Answer a challenge. `signed_data` is the holder's empty intent, signed
    /// with a nonce bound to this challenge's text. Attach OutLayer's fee
    /// (`estimate_execution_cost` on the OutLayer contract) plus 0.01 NEAR for
    /// the statement; OutLayer refunds its unused part to the caller, and
    /// `on_result` refunds the unused statement reserve.
    #[payable]
    pub fn prove(&mut self, challenge_id: U64, signed_data: Value) -> Promise {
        let ch = self.challenges.get(&challenge_id.0).expect("no such challenge").clone();
        require!(now_ms() < ch.expires_at_ms, "the challenge has expired");
        require!(
            (ch.statements.len() as u32) < MAX_STATEMENTS_PER_CHALLENGE,
            "this challenge has no statements left"
        );
        require!(
            env::prepaid_gas() >= OUTLAYER_GAS.saturating_add(CALLBACK_GAS).saturating_add(Gas::from_tgas(10)),
            "attach at least 90 Tgas"
        );
        let attached = env::attached_deposit();
        require!(attached > STATEMENT_RESERVE, "attach OutLayer's fee plus 0.01 NEAR");
        let payment = attached.saturating_sub(STATEMENT_RESERVE);
        let prover = env::predecessor_account_id();

        let input = json!({
            "signedData": signed_data,
            "tokenId": ch.token_id,
            "threshold": ch.threshold,
            "challenge": self.challenge_text(challenge_id.0, &ch),
        })
        .to_string();

        ext_outlayer::ext(self.outlayer.clone())
            .with_attached_deposit(payment)
            .with_static_gas(OUTLAYER_GAS)
            .request_execution(
                json!({ "WasmUrl": { "url": self.wasm.url, "hash": self.wasm.hash, "build_target": "wasm32-wasip2" } }),
                Some(json!({ "max_instructions": 10_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 })),
                Some(input),
                None,
                Some("Json".to_string()),
                Some(prover.clone()),
                None,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_result(challenge_id, prover, U128(payment.as_yoctonear()), self.wasm.hash.clone()),
            )
    }

    /// OutLayer's answer. Records a statement when the enclave's output
    /// matches this challenge; otherwise records nothing and refunds.
    #[private]
    pub fn on_result(
        &mut self,
        challenge_id: U64,
        prover: AccountId,
        forwarded_yocto: U128,
        wasm_hash: String,
        #[callback_result] output: Result<Value, PromiseError>,
    ) -> Option<Statement> {
        let mut refund = STATEMENT_RESERVE;
        let output = match output {
            Ok(v) => v,
            Err(_) => {
                // OutLayer refused the request itself, so the forwarded fee came back here.
                log!("OutLayer did not accept the request; refunding the prover");
                refund = refund.saturating_add(NearToken::from_yoctonear(forwarded_yocto.0 as u128));
                Promise::new(prover).transfer(refund).detach();
                return None;
            }
        };

        let ch = match self.challenges.get(&challenge_id.0) {
            Some(ch) => ch.clone(),
            None => {
                Promise::new(prover).transfer(refund).detach();
                return None;
            }
        };
        let expected = self.challenge_text(challenge_id.0, &ch);
        let text = |k: &str| output.get(k).and_then(Value::as_str).map(str::to_string);
        let verdict = text("result").unwrap_or_default();
        let matches = VERDICTS.contains(&verdict.as_str())
            && text("challenge").as_deref() == Some(expected.as_str())
            && text("token_id").as_deref() == Some(ch.token_id.as_str())
            && text("threshold").as_deref() == Some(ch.threshold.as_str());
        if !matches {
            // Null (the run failed or timed out; OutLayer refunded the prover)
            // or an output for some other request.
            log!("no statement: the enclave output does not answer challenge {}", challenge_id.0);
            Promise::new(prover).transfer(refund).detach();
            return None;
        }

        let before = env::storage_usage();
        let id = self.next_statement;
        self.next_statement += 1;
        let statement = Statement {
            challenge_id,
            verdict: verdict.clone(),
            holder: text("signer_id").map(|s| s.chars().take(64).collect()),
            prover: prover.clone(),
            token_id: ch.token_id.clone(),
            threshold: ch.threshold.clone(),
            wasm_hash,
            reason: text("reason").map(|s| s.chars().take(MAX_REASON_LEN).collect()),
            recorded_at_ms: U64(now_ms()),
            block_height: U64(env::block_height()),
        };
        self.statements.insert(id, statement.clone());
        let mut updated = ch;
        updated.statements.push(id);
        updated.confirmed |= verdict == "confirmed";
        self.challenges.insert(challenge_id.0, updated);
        self.challenges.flush();
        self.statements.flush();

        let used = env::storage_byte_cost().saturating_mul(env::storage_usage().saturating_sub(before) as u128);
        let back = STATEMENT_RESERVE.saturating_sub(used);
        if !back.is_zero() {
            Promise::new(prover).transfer(back).detach();
        }
        log!(
            "EVENT_JSON:{}",
            json!({ "standard": "jurat", "version": "1.0.0", "event": "statement",
                    "data": [{ "statement_id": id, "challenge_id": challenge_id, "verdict": verdict }] })
        );
        Some(statement)
    }

    pub fn get_challenge(&self, id: U64) -> Option<ChallengeView> {
        let ch = self.challenges.get(&id.0)?;
        Some(ChallengeView {
            id,
            challenge: self.challenge_text(id.0, ch),
            verifier: ch.verifier.clone(),
            token_id: ch.token_id.clone(),
            threshold: ch.threshold.clone(),
            created_at_ms: U64(ch.created_at_ms),
            expires_at_ms: U64(ch.expires_at_ms),
            confirmed: ch.confirmed,
            statements: ch.statements.iter().filter_map(|s| self.statements.get(s).cloned()).collect(),
        })
    }

    pub fn get_statement(&self, id: U64) -> Option<Statement> {
        self.statements.get(&id.0).cloned()
    }

    pub fn get_config(&self) -> Value {
        json!({ "owner": self.owner, "outlayer": self.outlayer, "wasm": self.wasm,
                "challenges": self.next_challenge, "statements": self.next_statement })
    }

    /// sha256 of the challenge text, first 7 bytes, hex: what the holder's
    /// intent nonce must end with. Handy for wallets and for checking.
    pub fn nonce_suffix(&self, id: U64) -> Option<String> {
        let ch = self.challenges.get(&id.0)?;
        Some(hex::encode(&env::sha256(self.challenge_text(id.0, ch).as_bytes())[..7]))
    }
}

impl Jurat {
    fn challenge_text(&self, id: u64, ch: &Challenge) -> String {
        format!("jurat:{}:{}:{}", env::current_account_id(), id, ch.nonce)
    }
}

#[cfg(test)]
mod tests;
