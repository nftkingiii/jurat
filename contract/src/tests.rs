use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const HASH: &str = "93b9aab6398021efda26aa56d64ce803c1917cffd90e06ae253f00d118efa3b4";
const T0: u64 = 1_792_000_000_000; // ms

fn jurat_account() -> AccountId {
    "jurat.near".parse().unwrap()
}

fn ctx(predecessor: AccountId, deposit: NearToken, ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(jurat_account())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(150))
        .block_timestamp(ms * 1_000_000)
        .random_seed([7; 32])
        .build());
}

fn contract() -> Jurat {
    ctx(accounts(0), NearToken::from_near(0), T0);
    Jurat::new(
        accounts(0),
        "outlayer.near".parse().unwrap(),
        Wasm { url: "https://github.com/nftkingiii/jurat/releases/download/x/jurat-enclave.wasm".into(), hash: HASH.into() },
    )
}

/// A contract with one challenge (id 0) opened by accounts(1).
fn with_challenge(threshold: &str) -> (Jurat, ChallengeView) {
    let mut c = contract();
    ctx(accounts(1), NearToken::from_millinear(10), T0);
    let view = c.create_challenge("nep141:usdc.near".into(), threshold.into(), 30);
    (c, view)
}

fn output(challenge: &str, result: &str, threshold: &str) -> Value {
    json!({
        "result": result, "signer_id": "holder.near", "token_id": "nep141:usdc.near",
        "threshold": threshold, "challenge": challenge, "auth_status": 201,
        "balances_status": 200, "reason": null,
    })
}

/// Calls `on_result` the way the runtime does: from the contract itself.
fn callback(c: &mut Jurat, out: Result<Value, PromiseError>) -> Option<Statement> {
    ctx(jurat_account(), NearToken::from_near(0), T0 + 60_000);
    c.on_result(U64(0), accounts(2), U128(7_001_000_000_000_000_000_000), HASH.into(), out)
}

#[test]
fn challenge_text_names_contract_id_and_nonce() {
    let (_, view) = with_challenge("1000000");
    assert_eq!(view.challenge, format!("jurat:jurat.near:0:{}", hex::encode([7u8; 8])));
    assert_eq!(view.verifier, accounts(1));
    assert_eq!(view.expires_at_ms.0, T0 + 30 * 60_000);
    assert!(!view.confirmed && view.statements.is_empty());
}

#[test]
fn nonce_suffix_is_the_first_7_bytes_of_the_challenge_digest() {
    let (c, view) = with_challenge("1");
    // sha256("jurat:jurat.near:0:0707070707070707")[..7], computed outside the contract.
    assert_eq!(view.challenge, "jurat:jurat.near:0:0707070707070707");
    let want = "8f9910b585a96d".to_string();
    assert_eq!(c.nonce_suffix(U64(0)), Some(want));
}

#[test]
#[should_panic(expected = "threshold must be an integer")]
fn refuses_a_non_integer_threshold() {
    with_challenge("1.5");
}

#[test]
#[should_panic(expected = "attach at least")]
fn create_challenge_needs_a_storage_deposit() {
    let mut c = contract();
    ctx(accounts(1), NearToken::from_yoctonear(1), T0);
    c.create_challenge("nep141:usdc.near".into(), "1".into(), 30);
}

#[test]
#[should_panic(expected = "wasm.hash must be 64 lowercase hex")]
fn refuses_a_bad_wasm_hash() {
    ctx(accounts(0), NearToken::from_near(0), T0);
    Jurat::new(accounts(0), "outlayer.near".parse().unwrap(), Wasm { url: "https://x/y.wasm".into(), hash: "ABC".into() });
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_changes_the_wasm() {
    let mut c = contract();
    ctx(accounts(1), NearToken::from_near(0), T0);
    c.set_wasm(Wasm { url: "https://x/y.wasm".into(), hash: HASH.into() });
}

#[test]
#[should_panic(expected = "the challenge has expired")]
fn prove_refuses_an_expired_challenge() {
    let (mut c, _) = with_challenge("1");
    ctx(accounts(2), NearToken::from_millinear(20), T0 + 31 * 60_000);
    let _ = c.prove(U64(0), json!({}));
}

#[test]
#[should_panic(expected = "attach OutLayer's fee plus 0.01 NEAR")]
fn prove_needs_the_fee_and_the_reserve() {
    let (mut c, _) = with_challenge("1");
    ctx(accounts(2), NearToken::from_millinear(10), T0 + 1_000);
    let _ = c.prove(U64(0), json!({}));
}

#[test]
fn prove_with_fee_and_gas_returns_the_outlayer_call() {
    let (mut c, _) = with_challenge("1");
    ctx(accounts(2), NearToken::from_millinear(18), T0 + 1_000);
    let _ = c.prove(U64(0), json!({ "standard": "raw_ed25519" }));
}

#[test]
fn records_a_confirmed_statement_for_a_matching_output() {
    let (mut c, view) = with_challenge("1000000");
    let st = callback(&mut c, Ok(output(&view.challenge, "confirmed", "1000000"))).expect("statement");
    assert_eq!(st.verdict, "confirmed");
    assert_eq!(st.holder.as_deref(), Some("holder.near"));
    assert_eq!(st.prover, accounts(2));
    assert_eq!(st.wasm_hash, HASH);
    let after = c.get_challenge(U64(0)).unwrap();
    assert!(after.confirmed);
    assert_eq!(after.statements, vec![st]);
}

#[test]
fn records_not_confirmed_without_confirming_the_challenge() {
    let (mut c, view) = with_challenge("1000000");
    let st = callback(&mut c, Ok(output(&view.challenge, "not_confirmed", "1000000"))).unwrap();
    assert_eq!(st.verdict, "not_confirmed");
    assert!(!c.get_challenge(U64(0)).unwrap().confirmed);
}

#[test]
fn records_a_refusal_with_its_reason() {
    let (mut c, view) = with_challenge("1");
    let mut out = output(&view.challenge, "refused", "1");
    out["reason"] = json!("the signed intent was not made for this challenge");
    let st = callback(&mut c, Ok(out)).unwrap();
    assert_eq!(st.verdict, "refused");
    assert_eq!(st.reason.as_deref(), Some("the signed intent was not made for this challenge"));
}

#[test]
fn ignores_an_output_for_another_challenge() {
    let (mut c, _) = with_challenge("1");
    assert!(callback(&mut c, Ok(output("jurat:jurat.near:9:0707070707070707", "confirmed", "1"))).is_none());
    assert!(c.get_challenge(U64(0)).unwrap().statements.is_empty());
}

#[test]
fn ignores_an_output_for_another_threshold_or_token() {
    let (mut c, view) = with_challenge("1000000");
    assert!(callback(&mut c, Ok(output(&view.challenge, "confirmed", "1"))).is_none());
    let mut other_token = output(&view.challenge, "confirmed", "1000000");
    other_token["token_id"] = json!("nep141:wrap.near");
    assert!(callback(&mut c, Ok(other_token)).is_none());
    assert!(!c.get_challenge(U64(0)).unwrap().confirmed);
}

#[test]
fn ignores_a_failed_or_refused_outlayer_call() {
    let (mut c, _) = with_challenge("1");
    assert!(callback(&mut c, Ok(Value::Null)).is_none());
    assert!(callback(&mut c, Err(PromiseError::Failed)).is_none());
    assert!(c.get_challenge(U64(0)).unwrap().statements.is_empty());
}

#[test]
fn ignores_an_unknown_verdict() {
    let (mut c, view) = with_challenge("1");
    assert!(callback(&mut c, Ok(output(&view.challenge, "maybe", "1"))).is_none());
}

#[test]
#[should_panic(expected = "this challenge has no statements left")]
fn a_challenge_holds_at_most_five_statements() {
    let (mut c, view) = with_challenge("1");
    for _ in 0..5 {
        callback(&mut c, Ok(output(&view.challenge, "not_confirmed", "1"))).unwrap();
    }
    ctx(accounts(2), NearToken::from_millinear(18), T0 + 1_000);
    let _ = c.prove(U64(0), json!({}));
}
