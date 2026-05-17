import json
import unittest

from tasknode_pftl.encryption import (
    decrypt_json_bytes,
    encrypt_json_bytes,
    generate_identity,
    identity_from_wallet_seed,
    message_key_from_x25519_public_key,
    x25519_public_key_b64_from_message_key,
)


class EncryptionRecipientTests(unittest.TestCase):
    def test_encrypt_decrypt_for_each_recipient(self):
        user = generate_identity("user")
        service = generate_identity("task_node_service")
        payload = {"ok": True, "value": "task content"}
        blob = encrypt_json_bytes(json.dumps(payload).encode("utf-8"), [user, service])

        self.assertEqual(blob["enc"], "ENC_X25519_XCHACHA20P1305")
        self.assertEqual(len(blob["recipients"]), 2)
        self.assertEqual(json.loads(decrypt_json_bytes(blob, user)), payload)
        self.assertEqual(json.loads(decrypt_json_bytes(blob, service)), payload)

    def test_missing_recipient_fails(self):
        user = generate_identity("user")
        outsider = generate_identity("outsider")
        blob = encrypt_json_bytes(b"secret", [user])
        with self.assertRaises(ValueError):
            decrypt_json_bytes(blob, outsider)

    def test_wallet_seed_identity_is_recoverable_and_message_key_roundtrips(self):
        first = identity_from_wallet_seed("user", "sEdExampleSeedMaterial", "rExample")
        second = identity_from_wallet_seed("user", "sEdExampleSeedMaterial", "rExample")

        self.assertEqual(first.public_key_b64, second.public_key_b64)
        self.assertEqual(first.private_key_b64, second.private_key_b64)
        self.assertEqual(first.message_key, message_key_from_x25519_public_key(first.public_key))
        self.assertEqual(x25519_public_key_b64_from_message_key(first.message_key), first.public_key_b64)
        self.assertTrue(first.message_key.startswith("ED"))
        self.assertEqual(len(first.message_key), 66)


if __name__ == "__main__":
    unittest.main()
