//! Jurat enclave program.
//!
//! Runs inside OutLayer's TEE. Reads one JSON request on stdin:
//!   { "signedData": <empty intent signed by the holder>,
//!     "tokenId": "nep141:usdc.near", "threshold": "1000000000",
//!     "challenge": "jurat:<contract>:<id>:<nonce>" }
//! logs in to 1Click with the holder's signed empty intent, reads the
//! confidential balance, and prints only whether the threshold is met.
//! The balance amount, the session token and other assets never leave.
//!
//! A challenge binds the run to one verifier's request: the signed intent's
//! nonce must carry sha256(challenge) in its 7 random bytes, so a signature
//! made for one challenge cannot answer another, and the challenge is echoed
//! in the output for the calling contract to match.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use wasi_http_client::Client;

const ONECLICK: &str = "https://1click.chaindefuser.com";

/// Versioned intent nonce: magic(4) | version(1) | salt(4) | deadline(8) |
/// start time(8) | random(7). Jurat puts the challenge digest in `random`.
const NONCE_LEN: usize = 32;
const NONCE_RANDOM: std::ops::Range<usize> = 25..32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    signed_data: Value,
    token_id: String,
    threshold: String,
    #[serde(default)]
    challenge: Option<String>,
}

#[derive(Serialize)]
struct Statement {
    /// "confirmed", "not_confirmed" or "refused"
    result: &'static str,
    signer_id: Option<String>,
    token_id: String,
    threshold: String,
    challenge: Option<String>,
    auth_status: Option<u16>,
    balances_status: Option<u16>,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    access_token: String,
}

#[derive(Deserialize)]
struct Balances {
    balances: Vec<BalanceEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceEntry {
    token_id: String,
    available: String,
}

/// The signed intent as JSON. NEP-413 keeps it in `payload.message`; the
/// other standards sign the intent string as `payload`.
fn intent(signed: &Value) -> Option<Value> {
    let text = match &signed["payload"] {
        Value::String(s) => s.clone(),
        Value::Object(p) => p.get("message")?.as_str()?.to_string(),
        _ => return None,
    };
    serde_json::from_str(&text).ok()
}

/// The account the signed empty intent speaks for.
fn signer_id(signed: &Value) -> Option<String> {
    let intent = intent(signed)?;
    if intent["intents"].as_array().map_or(true, |a| !a.is_empty()) {
        return None; // only an empty intent is accepted as an ownership proof
    }
    intent["signer_id"].as_str().map(str::to_string)
}

/// The intent nonce: `payload.nonce` for NEP-413, inside the intent otherwise.
fn nonce(signed: &Value) -> Option<Vec<u8>> {
    let encoded = match &signed["payload"] {
        Value::Object(p) => p.get("nonce")?.as_str()?.to_string(),
        _ => intent(signed)?["nonce"].as_str()?.to_string(),
    };
    STANDARD.decode(encoded).ok().filter(|n| n.len() == NONCE_LEN)
}

/// True when the nonce's random bytes are the first 7 bytes of sha256(challenge).
fn nonce_binds(signed: &Value, challenge: &str) -> bool {
    let digest = Sha256::digest(challenge.as_bytes());
    nonce(signed).is_some_and(|n| n[NONCE_RANDOM] == digest[..NONCE_RANDOM.len()])
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Compares two non-negative integers written in base 10, of any length.
fn at_least(amount: &str, threshold: &str) -> bool {
    let a = amount.trim_start_matches('0');
    let t = threshold.trim_start_matches('0');
    a.len() > t.len() || (a.len() == t.len() && a >= t)
}

fn check(req: Request) -> Statement {
    let mut st = Statement {
        result: "refused",
        signer_id: signer_id(&req.signed_data),
        token_id: req.token_id.clone(),
        threshold: req.threshold.clone(),
        challenge: req.challenge.clone(),
        auth_status: None,
        balances_status: None,
        reason: None,
    };
    if st.signer_id.is_none() {
        st.reason = Some("signedData is not a signed empty intent".into());
        return st;
    }
    if !is_digits(&req.threshold) {
        st.reason = Some("threshold must be an integer in the token's smallest unit".into());
        return st;
    }
    if let Some(challenge) = &req.challenge {
        if !nonce_binds(&req.signed_data, challenge) {
            st.reason = Some("the signed intent was not made for this challenge".into());
            return st;
        }
    }

    let client = Client::new();
    let body = serde_json::to_vec(&serde_json::json!({ "signedData": req.signed_data })).unwrap();
    let auth = match client
        .post(&format!("{ONECLICK}/v0/auth/authenticate"))
        .header("Content-Type", "application/json")
        .body(&body)
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            st.reason = Some(format!("authenticate request failed: {e}"));
            return st;
        }
    };
    st.auth_status = Some(auth.status());
    if !(200..300).contains(&auth.status()) {
        st.reason = Some("1Click refused the signed intent".into());
        return st;
    }
    let session: Session = match auth.body().ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(s) => s,
        None => {
            st.reason = Some("unexpected authenticate response".into());
            return st;
        }
    };

    let bal = match client
        .get(&format!("{ONECLICK}/v0/account/balances"))
        .header("Authorization", format!("Bearer {}", session.access_token))
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            st.reason = Some(format!("balances request failed: {e}"));
            return st;
        }
    };
    st.balances_status = Some(bal.status());
    if bal.status() != 200 {
        st.reason = Some("1Click refused the balance read".into());
        return st;
    }
    let balances: Balances = match bal.body().ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(b) => b,
        None => {
            st.reason = Some("unexpected balances response".into());
            return st;
        }
    };

    let held = balances
        .balances
        .iter()
        .find(|b| b.token_id == req.token_id)
        .map(|b| b.available.as_str())
        .unwrap_or("0");
    st.result = if is_digits(held) && at_least(held, &req.threshold) {
        "confirmed"
    } else {
        "not_confirmed"
    };
    st
}

fn refused(reason: String) -> Statement {
    Statement {
        result: "refused",
        signer_id: None,
        token_id: String::new(),
        threshold: String::new(),
        challenge: None,
        auth_status: None,
        balances_status: None,
        reason: Some(reason),
    }
}

fn main() {
    let mut input = String::new();
    let statement = match io::stdin().read_to_string(&mut input) {
        Ok(_) => match serde_json::from_str::<Request>(&input) {
            Ok(req) => check(req),
            Err(e) => refused(format!("bad input: {e}")),
        },
        Err(e) => refused(format!("cannot read input: {e}")),
    };
    print!("{}", serde_json::to_string(&statement).unwrap());
    io::stdout().flush().ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A raw_ed25519-style signed intent whose nonce carries `random`.
    fn signed_with_random(random: &[u8]) -> Value {
        let mut n = vec![0u8; NONCE_LEN];
        n[NONCE_RANDOM].copy_from_slice(random);
        let payload = serde_json::json!({
            "signer_id": "abc", "intents": [], "nonce": STANDARD.encode(&n),
        });
        serde_json::json!({ "standard": "raw_ed25519", "payload": payload.to_string() })
    }

    #[test]
    fn compares_long_integers() {
        assert!(at_least("1000000000000000000000000", "999999999999999999999999"));
        assert!(at_least("0005", "5"));
        assert!(!at_least("4", "5"));
        assert!(!at_least("0", "1"));
        assert!(at_least("0", "0"));
    }

    #[test]
    fn reads_signer_from_raw_and_nep413() {
        let raw = serde_json::json!({ "payload": "{\"signer_id\":\"abc\",\"intents\":[]}" });
        assert_eq!(signer_id(&raw).as_deref(), Some("abc"));
        let nep = serde_json::json!({ "payload": { "message": "{\"signer_id\":\"bob.near\",\"intents\":[]}" } });
        assert_eq!(signer_id(&nep).as_deref(), Some("bob.near"));
    }

    #[test]
    fn refuses_non_empty_intents() {
        let moving = serde_json::json!({ "payload": "{\"signer_id\":\"abc\",\"intents\":[{\"intent\":\"transfer\"}]}" });
        assert_eq!(signer_id(&moving), None);
    }

    #[test]
    fn nonce_must_carry_the_challenge_digest() {
        let challenge = "jurat:jurat.near:7:0011223344556677";
        let digest = Sha256::digest(challenge.as_bytes());
        let bound = signed_with_random(&digest[..7]);
        assert!(nonce_binds(&bound, challenge));
        assert!(!nonce_binds(&bound, "jurat:jurat.near:8:0011223344556677"));
        assert!(!nonce_binds(&signed_with_random(&[0; 7]), challenge));
    }

    #[test]
    fn reads_nep413_nonce_from_payload() {
        let challenge = "jurat:jurat.near:1:ab";
        let mut n = vec![0u8; NONCE_LEN];
        n[NONCE_RANDOM].copy_from_slice(&Sha256::digest(challenge.as_bytes())[..7]);
        let nep = serde_json::json!({ "payload": {
            "nonce": STANDARD.encode(&n),
            "message": "{\"signer_id\":\"bob.near\",\"intents\":[]}",
        } });
        assert!(nonce_binds(&nep, challenge));
    }

    #[test]
    fn a_challenge_run_refuses_an_unbound_intent_before_any_call() {
        let st = check(Request {
            signed_data: signed_with_random(&[9; 7]),
            token_id: "nep141:wrap.near".into(),
            threshold: "0".into(),
            challenge: Some("jurat:jurat.near:1:ab".into()),
        });
        assert_eq!(st.result, "refused");
        assert_eq!(st.auth_status, None);
        assert_eq!(st.challenge.as_deref(), Some("jurat:jurat.near:1:ab"));
    }
}
