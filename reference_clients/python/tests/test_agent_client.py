from datetime import datetime, timedelta, timezone
import os
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

from xrpl.core.keypairs import is_valid_message

from tasknode_pftl.agent_client import (
    TASKNODE_AGENT_DESTINATION,
    TaskNodeApiError,
    TaskNodeAgentClient,
    build_synthetic_signed_pointer,
    message_to_hex,
    sign_prepared_transaction,
    tasknode_encrypted_payload,
    verify_signed_transaction_blob,
)
from tasknode_pftl.encryption import generate_identity
from tasknode_pftl.pointers import Pointer, build_memo
from tasknode_pftl.wallets import wallet_from_seed


SMOKE_MNEMONIC = (
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
)


class FakeResponse:
    def __init__(self, status_code=200, body=None, headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.text = ""

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, json=None, params=None, timeout=None):
        path = urlparse(url).path
        call = {
            "method": method,
            "path": path,
            "json": json,
            "params": params,
            "timeout": timeout,
        }
        self.calls.append(call)
        if not self.responses:
            raise AssertionError(f"unexpected request: {method} {path}")
        response = self.responses.pop(0)
        if callable(response):
            response = response(call)
        return response


def future_expiry():
    return (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")


def prepared_pointer_tx(wallet, *, kind="TASK_UPDATE", task_id="task_test", cid="bafkreitestcid"):
    memo = build_memo(Pointer(cid=cid, kind=kind, schema=1, task_id=task_id))
    return {
        "TransactionType": "Payment",
        "Account": wallet.address,
        "Destination": TASKNODE_AGENT_DESTINATION,
        "Amount": "1",
        "Fee": "12",
        "Sequence": 1,
        "LastLedgerSequence": 1000,
        "NetworkID": 21338,
        "Memos": [
            {
                "Memo": {
                    "MemoType": memo["memo_type"].upper(),
                    "MemoFormat": memo["memo_format"].upper(),
                    "MemoData": memo["memo_data"].upper(),
                }
            }
        ],
    }


def config_response(wallet, service, *, task_id="task_test", submission_mode="initial_submission"):
    return {
        "phase": "config",
        "taskId": task_id,
        "submissionMode": submission_mode,
        "tasknodeEncryptionPubkey": service.public_key_b64,
        "tasknodeServiceAddress": TASKNODE_AGENT_DESTINATION,
        "wallets": {
            "user": wallet.address,
            "authority": TASKNODE_AGENT_DESTINATION,
            "allocation": "rAllocation11111111111111111111111111111",
        },
        "pointer": {"kind": "TASK_UPDATE", "schema": 1, "flags": 1},
    }


class AgentClientTests(unittest.TestCase):
    def setUp(self):
        self.wallet = wallet_from_seed("agent", SMOKE_MNEMONIC)
        self.service = generate_identity("task_node_service")

    def client(self, *, http, seed=SMOKE_MNEMONIC, logged_in=True, **kwargs):
        client = TaskNodeAgentClient("https://tasknode.example", seed=seed, http=http, **kwargs)
        if logged_in:
            client.account_id = "acct_agent"
            client.session_expires_at = future_expiry()
        return client

    def test_seed_must_come_from_env_or_explicit_constructor_arg(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "TASKNODE_AGENT_WALLET_SEED"):
                TaskNodeAgentClient("https://tasknode.example", http=FakeSession([]))

        with patch.dict(os.environ, {"TASKNODE_AGENT_WALLET_SEED": SMOKE_MNEMONIC}, clear=True):
            with patch("builtins.open", side_effect=AssertionError("client must not read a seed file")):
                client = TaskNodeAgentClient("https://tasknode.example", http=FakeSession([]))
        self.assertEqual(client.address, self.wallet.address)

    def test_explicit_seed_overrides_env_without_file_fallback(self):
        with patch.dict(os.environ, {"TASKNODE_AGENT_WALLET_SEED": "bad env value"}, clear=True):
            client = TaskNodeAgentClient("https://tasknode.example", seed=SMOKE_MNEMONIC, http=FakeSession([]))
        self.assertEqual(client.address, self.wallet.address)

    def test_wallet_login_signs_challenge_without_sending_secret(self):
        message = "tasknode.wallet_login.v1:unit-test"
        forbidden = {SMOKE_MNEMONIC, "mnemonic", "seed", "privateKey", "private_key"}

        def verify(call):
            body = call["json"]
            encoded_body = str(body)
            for token in forbidden:
                self.assertNotIn(token, encoded_body)
            self.assertEqual(body["address"], self.wallet.address)
            self.assertTrue(
                is_valid_message(
                    bytes.fromhex(message_to_hex(message)),
                    bytes.fromhex(body["signature"]),
                    body["publicKey"],
                )
            )
            return FakeResponse(
                200,
                {"ok": True, "accountId": "acct_agent", "session": {"expiresAt": future_expiry()}},
            )

        http = FakeSession([
            FakeResponse(200, {"ok": True, "challenge": {"id": "ch_1", "message": message}}),
            verify,
        ])
        client = self.client(http=http, logged_in=False)

        login = client.login()

        self.assertEqual(login["accountId"], "acct_agent")
        self.assertEqual([call["path"] for call in http.calls], ["/api/auth/wallet/start", "/api/auth/wallet/verify"])

    def test_api_errors_redact_secret_like_fields(self):
        http = FakeSession([
            FakeResponse(400, {"ok": False, "error": "denied", "seed": SMOKE_MNEMONIC, "privateKey": "secret"}),
        ])
        client = self.client(http=http, logged_in=False)

        with self.assertRaises(TaskNodeApiError) as raised:
            client.login()

        self.assertNotIn(SMOKE_MNEMONIC, str(raised.exception))
        self.assertEqual(raised.exception.body["seed"], "[redacted]")
        self.assertEqual(raised.exception.body["privateKey"], "[redacted]")

    def test_request_reauthenticates_exactly_once_on_401(self):
        http = FakeSession([
            FakeResponse(401, {"ok": False, "error": "session_expired"}),
            FakeResponse(200, {"ok": True, "challenge": {"id": "ch_reauth", "message": "login again"}}),
            FakeResponse(200, {"ok": True, "accountId": "acct_agent", "session": {"expiresAt": future_expiry()}}),
            FakeResponse(200, {"ok": True, "items": []}),
        ])
        client = self.client(http=http)

        result = client.list_tasks()

        self.assertEqual(result["items"], [])
        paths = [call["path"] for call in http.calls]
        self.assertEqual(paths.count("/api/auth/wallet/start"), 1)
        self.assertEqual(paths.count("/api/auth/wallet/verify"), 1)
        self.assertEqual(paths.count("/api/tasks"), 2)

    def test_repeated_401_after_relogin_raises(self):
        http = FakeSession([
            FakeResponse(401, {"ok": False, "error": "session_expired"}),
            FakeResponse(200, {"ok": True, "challenge": {"id": "ch_reauth", "message": "login again"}}),
            FakeResponse(200, {"ok": True, "accountId": "acct_agent", "session": {"expiresAt": future_expiry()}}),
            FakeResponse(401, {"ok": False, "error": "still_expired"}),
        ])
        client = self.client(http=http)

        with self.assertRaises(TaskNodeApiError) as raised:
            client.list_tasks()

        self.assertEqual(raised.exception.status_code, 401)
        paths = [call["path"] for call in http.calls]
        self.assertEqual(paths.count("/api/auth/wallet/start"), 1)
        self.assertEqual(paths.count("/api/tasks"), 2)

    def test_429_backs_off_once_and_retries(self):
        sleeps = []
        http = FakeSession([
            FakeResponse(429, {"ok": False, "retryAfterSeconds": 2}),
            FakeResponse(200, {"ok": True, "items": []}),
        ])
        client = self.client(http=http, sleep_fn=sleeps.append)

        result = client.list_tasks()

        self.assertEqual(result["items"], [])
        self.assertEqual(sleeps, [2.0])
        self.assertEqual([call["path"] for call in http.calls], ["/api/tasks", "/api/tasks"])

    def test_read_methods_call_expected_endpoints(self):
        http = FakeSession([
            FakeResponse(200, {"ok": True, "tasks": []}),
            FakeResponse(200, {"ok": True, "task": {"id": "task_1"}}),
            FakeResponse(200, {"ok": True, "projects": []}),
            FakeResponse(200, {"ok": True, "items": []}),
            FakeResponse(200, {"ok": True, "reply": "heard"}),
        ])
        client = self.client(http=http)

        client.list_tasks()
        client.task_detail("task_1")
        client.hive_projects()
        client.hive_context()
        client.hive_say("status")

        self.assertEqual([call["path"] for call in http.calls], [
            "/api/tasks",
            "/api/tasks/detail",
            "/api/hive/projects",
            "/api/hive/context",
            "/api/hive/context",
        ])
        self.assertEqual(http.calls[1]["params"], {"taskId": "task_1"})
        self.assertEqual(http.calls[4]["json"]["message"], "status")

    def test_accept_task_submit_false_previews_without_submit_phase(self):
        http = FakeSession([
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, {"phase": "prepared", "cid": "bafkreia", "txJson": prepared_pointer_tx(self.wallet)}),
        ])
        client = self.client(http=http)

        result = client.accept_task("task_test")

        self.assertTrue(result.submit_skipped)
        self.assertTrue(result.signed.verified)
        self.assertEqual([call["json"]["phase"] for call in http.calls], ["config", "prepare"])

    def test_accept_task_submit_true_publishes_once_and_blocks_duplicate(self):
        http = FakeSession([
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, {"phase": "prepared", "cid": "bafkreia", "txJson": prepared_pointer_tx(self.wallet)}),
            FakeResponse(200, {"ok": True, "txHash": "ABC123"}),
        ])
        client = self.client(http=http)

        result = client.accept_task("task_test", submit=True)

        self.assertEqual(result.submitted["txHash"], "ABC123")
        self.assertEqual([call["json"]["phase"] for call in http.calls], ["config", "prepare", "submit"])
        with self.assertRaisesRegex(TaskNodeApiError, "already used"):
            client.accept_task("task_test", submit=True)
        self.assertEqual(len(http.calls), 3)

    def test_submit_evidence_and_verification_default_to_preview(self):
        http = FakeSession([
            FakeResponse(200, config_response(self.wallet, self.service, task_id="task_evidence")),
            FakeResponse(
                200,
                {
                    "phase": "prepared",
                    "cid": "bafkreievidence",
                    "txJson": prepared_pointer_tx(self.wallet, task_id="task_evidence"),
                },
            ),
            FakeResponse(200, config_response(self.wallet, self.service, task_id="task_verify")),
            FakeResponse(
                200,
                {
                    "phase": "prepared",
                    "cid": "bafkreiverify",
                    "txJson": prepared_pointer_tx(self.wallet, task_id="task_verify"),
                },
            ),
        ])
        client = self.client(http=http)

        evidence = client.submit_evidence("task_evidence", "completed the requested work")
        response = client.respond_verification("task_verify", {"response": "confirmed", "notes": "see artifact"})

        self.assertTrue(evidence.submit_skipped)
        self.assertEqual(evidence.payload["submission"]["value"], "completed the requested work")
        self.assertTrue(response.submit_skipped)
        self.assertEqual(response.payload["response_text"], "confirmed")
        self.assertEqual([call["json"]["phase"] for call in http.calls], ["config", "prepare", "config", "prepare"])

    def test_request_task_submit_false_does_not_publish_pointer(self):
        request_bundle = {"schema": "tasknode.task_request_bundle.v1", "request": "small task"}
        http = FakeSession([
            FakeResponse(
                200,
                {
                    "requestId": "req_1",
                    "bundleId": "bundle_1",
                    "requestText": "Request a task",
                    "requestedTaskKind": "personal",
                    "requestBundle": request_bundle,
                    "tasknodeEncryptionPubkey": self.service.public_key_b64,
                    "tasknodeServiceAddress": TASKNODE_AGENT_DESTINATION,
                    "wallets": {"authority": TASKNODE_AGENT_DESTINATION},
                },
            ),
            FakeResponse(200, {"phase": "bundle_prepared", "bundleCid": "bafkreibundle", "bundleDigest": "abc"}),
            FakeResponse(200, {"phase": "prepared", "cid": "bafkreirequest", "txJson": prepared_pointer_tx(self.wallet, kind="TASK", task_id="")}),
        ])
        client = self.client(http=http)

        result = client.request_task(message="please route a small task")

        self.assertTrue(result.submit_skipped)
        self.assertEqual([call["json"]["phase"] for call in http.calls], ["config", "prepare_bundle", "prepare"])

    def test_signed_transaction_helpers_reuse_pointer_crypto(self):
        tx_json = prepared_pointer_tx(self.wallet, kind="TASK_SUBMISSION", task_id="task_sign")

        signed = sign_prepared_transaction(tx_json, self.wallet, expected_address=self.wallet.address)
        verification = verify_signed_transaction_blob(signed.tx_blob, expected_address=self.wallet.address)
        synthetic = build_synthetic_signed_pointer(self.wallet, kind="TASK_UPDATE", task_id="task_synthetic")

        self.assertTrue(signed.verified)
        self.assertTrue(verification["verified"])
        self.assertEqual(verification["pointers"][0]["task_id"], "task_sign")
        self.assertTrue(synthetic["ok"])

    def test_tasknode_encrypted_payload_uses_existing_encryption_helper(self):
        encrypted = tasknode_encrypted_payload(
            {"schema": "pf.task.update.v1", "task_id": "task_encrypted"},
            wallet=self.wallet,
            tasknode_encryption_pubkey=self.service.public_key_b64,
        )

        self.assertEqual(encrypted["version"], 1)
        self.assertIn("ciphertext", encrypted)
        self.assertIn("content_hash", encrypted)


if __name__ == "__main__":
    unittest.main()
