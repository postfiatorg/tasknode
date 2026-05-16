import json
import unittest

from tasknode_pftl.encryption import decrypt_json_bytes, encrypt_json_bytes, generate_identity


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


if __name__ == "__main__":
    unittest.main()

