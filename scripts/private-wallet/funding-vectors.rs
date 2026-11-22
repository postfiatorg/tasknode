// Compile against the fix worktree's release postfiat_types and serde_json libraries.
use postfiat_types::UnsignedTransferFunding;
use serde_json::{json, Value};

fn main() {
    let owner = format!("pf{}", "10".repeat(20));
    let issuer = format!("pf{}", "ab".repeat(20));
    let mut vectors = Vec::new();
    for (fee, sequence, amount) in [(1, 7, 9), (123_456, 567_890, 9_007_199_254_740_991u64)] {
        let mut intent = json!({
            "output_commitments":["01".repeat(32), "ef".repeat(32)],
            "ciphertext_hashes":["ca".repeat(48), "fe".repeat(48)],
            "nullifiers":["d0".repeat(32), "0d".repeat(32)]
        });
        if sequence != 7 { intent["output_commitments"].as_array_mut().unwrap().swap(0, 1); }
        let unsigned: UnsignedTransferFunding = serde_json::from_value(json!({
            "terms":{"chain_id":"postfiat-wan-devnet-2",
                "genesis_hash":"ce22ca8c932da0998b484483a09647138a30e0bf44408dd49a8d6d452787ad25521aff3ed334da07e150a7233a3e90a9",
                "protocol_version":1, "address_namespace":"postfiat.address.v1",
                "transaction_kind":"asset_burn", "signature_algorithm_id":"ML-DSA-65",
                "source":owner, "owner":owner, "issuer":issuer, "fee":fee, "sequence":sequence,
                "operation":"asset_burn", "asset_id":"a1".repeat(48), "amount":amount},
            "intent":intent
        })).unwrap();
        let digest: String = unsigned.signing_digest().iter().map(|b| format!("{b:02x}")).collect();
        vectors.push(json!({"unsigned_funding":unsigned, "signing_digest_hex":digest}));
    }
    println!("{}", serde_json::to_string_pretty(&Value::Array(vectors)).unwrap());
}
