//! Jurat enclave program (spike).
//!
//! Runs inside OutLayer's TEE. Reads one JSON request on stdin:
//!   { "signedData": <empty intent signed by the holder>,
//!     "tokenId": "nep141:usdc.near", "threshold": "1000000000" }
//! logs in to 1Click with the holder's signed empty intent, reads the
//! confidential balance, and prints only whether the threshold is met.
//! The balance amount, the session token and other assets never leave.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};
use wasi_http_client::Client;

const ONECLICK: &str = "https://1click.chaindefuser.com";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    signed_data: Value,
    token_id: String,
    threshold: String,
}

#[derive(Serialize)]
struct Statement {
    /// "confirmed", "not_confirmed" or "refused"
    result: &'static str,
    signer_id: Option<String>,
    token_id: String,
    threshold: String,
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

/// The account the signed empty intent speaks for. NEP-413 keeps the intent in
/// `payload.message`; the other standards sign the intent string as `payload`.
fn signer_id(signed: &Value) -> Option<String> {
    let intent = match &signed["payload"] {
        Value::String(s) => s.clone(),
        Value::Object(p) => p.get("message")?.as_str()?.to_string(),
        _ => return None,
    };
    let intent: Value = serde_json::from_str(&intent).ok()?;
    if intent["intents"].as_array().map_or(true, |a| !a.is_empty()) {
        return None; // only an empty intent is accepted as an ownership proof
    }
    intent["signer_id"].as_str().map(str::to_string)
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

fn main() {
    let mut input = String::new();
    let statement = match io::stdin().read_to_string(&mut input) {
        Ok(_) => match serde_json::from_str::<Request>(&input) {
            Ok(req) => check(req),
            Err(e) => Statement {
                result: "refused",
                signer_id: None,
                token_id: String::new(),
                threshold: String::new(),
                auth_status: None,
                balances_status: None,
                reason: Some(format!("bad input: {e}")),
            },
        },
        Err(e) => Statement {
            result: "refused",
            signer_id: None,
            token_id: String::new(),
            threshold: String::new(),
            auth_status: None,
            balances_status: None,
            reason: Some(format!("cannot read input: {e}")),
        },
    };
    print!("{}", serde_json::to_string(&statement).unwrap());
    io::stdout().flush().ok();
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
