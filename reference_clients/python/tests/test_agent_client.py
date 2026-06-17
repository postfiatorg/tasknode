from datetime import datetime, timedelta, timezone
import inspect
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

from xrpl.core.keypairs import is_valid_message

from tasknode_pftl import agent_client as agent_client_module
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


def config_response(wallet, service):
    return {
        "phase": "config",
        "taskId": "task_test",
        "submissionMode": "initial_submission",
        "tasknodeEncryptionPubkey": service.public_key_b64,
        "tasknodeServiceAddress": TASKNODE_AGENT_DESTINATION,
        "wallets": {
            "user": wallet.address,
            "authority": TASKNODE_AGENT_DESTINATION,
            "allocation": "rAllocation11111111111111111111111111111",
        },
        "pointer": {"kind": "TASK_UPDATE", "schema": 1, "flags": 1},
    }


def context_response(*, pointer_count=0, revision=0, latest_pointer=None):
    return {
        "document": {
            "id": "ctx_agent",
            "title": "Agent Context",
            "body": "<p>existing</p>",
            "revision": revision,
        },
        "history": {
            "revision": pointer_count,
            "pointerCount": pointer_count,
            "latestContextPointer": latest_pointer,
        },
    }


def prepared_context_response(wallet, *, cid="bafkreicontext", revision=1):
    return {
        "phase": "prepared",
        "cid": cid,
        "txJson": prepared_pointer_tx(wallet, kind="CONTEXT", cid=cid),
        "pointer": {"kind": "CONTEXT", "schema": 1, "cid": cid},
        "context": {"id": "ctx_agent", "revision": revision, "wordCount": 2},
        "transaction": {"destination": TASKNODE_AGENT_DESTINATION},
    }


class AgentClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.session_store = os.path.join(self.tmp.name, "agent_sessions.json")
        self.wallet = wallet_from_seed("agent", SMOKE_MNEMONIC)
        self.service = generate_identity("task_node_service")

    def tearDown(self):
        self.tmp.cleanup()

    def client(self, *, http, **kwargs):
        return TaskNodeAgentClient(seed=SMOKE_MNEMONIC, http=http, session_store_path=self.session_store, **kwargs)

    def test_seed_required_when_no_env_or_arg(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "TASKNODE_AGENT_WALLET_SEED"):
                TaskNodeAgentClient(http=FakeSession([]))

    def test_env_seed_does_not_read_shared_wallet_file(self):
        # H2: constructing from an env seed must not fall back to any seed file.
        def guard(path, *args, **kwargs):
            raise AssertionError(f"constructor must not read a seed file: {path}")

        with patch.dict(os.environ, {"TASKNODE_AGENT_WALLET_SEED": SMOKE_MNEMONIC}, clear=True):
            with patch("builtins.open", side_effect=guard):
                client = TaskNodeAgentClient(http=FakeSession([]), session_store_path=self.session_store)
        self.assertEqual(client.address, self.wallet.address)

    def test_module_exposes_no_shared_wallet_file_loader(self):
        source = inspect.getsource(agent_client_module)

        self.assertFalse(hasattr(agent_client_module, "DEFAULT_SECRET_FILE"))
        self.assertFalse(hasattr(agent_client_module, "load_agent_wallet"))
        self.assertFalse(hasattr(agent_client_module, "load_agent_wallets"))
        self.assertNotIn("DEFAULT_SECRET_FILE", source)
        self.assertNotIn("load_agent_wallet", source)
        self.assertNotIn("tasknode_agent_" + "wallets.json", source)

    def future_expiry(self):
        return (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")

    def write_session_store(self, token="cached_token", expires_at=None, account_id="acct_cached"):
        payload = {
            self.wallet.address: {
                "session_token": token,
                "expires_at": expires_at or self.future_expiry(),
                "account_id": account_id,
            }
        }
        with open(self.session_store, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.chmod(self.session_store, 0o600)
        return payload

    def test_wallet_login_signs_challenge_and_reads_tasks(self):
        message = "tasknode.wallet_login.v1:unit-test"

        def verify(call):
            body = call["json"]
            self.assertEqual(body["address"], self.wallet.address)
            self.assertTrue(
                is_valid_message(
                    bytes.fromhex(message_to_hex(message)),
                    bytes.fromhex(body["signature"]),
                    body["publicKey"],
                )
            )
            return FakeResponse(200, {"ok": True, "accountId": "acct_agent", "session": {"expiresAt": "2099-01-01T00:00:00Z"}})

        http = FakeSession([
            FakeResponse(200, {"ok": True, "challenge": {"id": "ch_1", "message": message}}),
            verify,
            FakeResponse(200, {"ok": True, "networkTasks": {"status": "profile_required", "gates": []}}),
        ])
        client = self.client(http=http)

        body = client.tasks()

        self.assertEqual(client.account_id, "acct_agent")
        self.assertEqual(body["networkTasks"]["status"], "profile_required")
        self.assertEqual([call["path"] for call in http.calls], ["/api/auth/wallet/start", "/api/auth/wallet/verify", "/api/tasks"])

    def test_hive_project_tasks_and_task_detail_are_read_only(self):
        self.write_session_store()
        http = FakeSession([
            FakeResponse(200, {
                "ok": True,
                "document": {
                    "projects": {
                        "project_one": {
                            "id": "project_one",
                            "title": "Project One",
                            "tasks": [
                                {"taskId": "task_one", "title": "Read task one"},
                                {"taskId": "task_two", "title": "Read task two", "projectId": "explicit_project"},
                            ],
                        }
                    }
                },
            }),
            FakeResponse(200, {
                "ok": True,
                "task": {"taskId": "task_one"},
                "evaluationPackets": [{"id": "evalpkt_one"}],
            }),
        ])
        client = self.client(http=http)

        tasks = client.hive_project_tasks()
        detail = client.hive_task_detail("task_one")

        self.assertEqual(tasks[0]["projectId"], "project_one")
        self.assertEqual(tasks[0]["projectTitle"], "Project One")
        self.assertEqual(tasks[1]["projectId"], "explicit_project")
        self.assertEqual(detail["evaluationPackets"][0]["id"], "evalpkt_one")
        self.assertEqual(
            [(call["method"], call["path"]) for call in http.calls],
            [("GET", "/api/hive/projects"), ("GET", "/api/hive/task-detail")],
        )
        self.assertEqual(http.calls[1]["params"], {"taskId": "task_one"})

    def test_request_reauthenticates_once_on_expired_session(self):
        challenge = {"id": "ch_1", "message": "login one"}
        challenge_two = {"id": "ch_2", "message": "login two"}
        http = FakeSession([
            FakeResponse(200, {"ok": True, "challenge": challenge}),
            FakeResponse(200, {"ok": True, "accountId": "acct_agent"}),
            FakeResponse(401, {"ok": False, "error": "session_expired"}),
            FakeResponse(200, {"ok": True, "challenge": challenge_two}),
            FakeResponse(200, {"ok": True, "accountId": "acct_agent"}),
            FakeResponse(200, {"ok": True, "items": []}),
        ])
        client = self.client(http=http)

        result = client.tasks()

        self.assertEqual(result["items"], [])
        self.assertEqual([call["path"] for call in http.calls].count("/api/auth/wallet/start"), 2)

    def test_second_process_reuses_cached_session_without_login_call(self):
        self.write_session_store(token="cached_session_token", account_id="acct_cached")
        http = FakeSession([
            FakeResponse(200, {"ok": True, "networkTasks": {"status": "available_for_routing", "gates": []}}),
        ])
        client = self.client(http=http)

        result = client.tasks()

        self.assertEqual(client.account_id, "acct_cached")
        self.assertEqual(result["networkTasks"]["status"], "available_for_routing")
        self.assertEqual([call["path"] for call in http.calls], ["/api/tasks"])

    def test_401_discards_cached_session_reauthenticates_once_and_overwrites_cache(self):
        self.write_session_store(token="old_session_token", account_id="acct_cached")
        message = "tasknode.wallet_login.v1:reauth"

        def verify(call):
            return FakeResponse(
                200,
                {
                    "ok": True,
                    "accountId": "acct_agent",
                    "session": {"expiresAt": self.future_expiry()},
                },
                headers={"set-cookie": "tasknode_session=new_session_token; HttpOnly; SameSite=Lax; Path=/"},
            )

        http = FakeSession([
            FakeResponse(401, {"ok": False, "error": "session_expired"}),
            FakeResponse(200, {"ok": True, "challenge": {"id": "ch_reauth", "message": message}}),
            verify,
            FakeResponse(200, {"ok": True, "items": []}),
        ])
        client = self.client(http=http)

        result = client.tasks()

        with open(self.session_store, "r", encoding="utf-8") as handle:
            cached = json.load(handle)
        self.assertEqual(result["items"], [])
        self.assertEqual([call["path"] for call in http.calls].count("/api/auth/wallet/start"), 1)
        self.assertEqual([call["path"] for call in http.calls].count("/api/auth/wallet/verify"), 1)
        self.assertEqual(cached[self.wallet.address]["session_token"], "new_session_token")
        self.assertEqual(cached[self.wallet.address]["account_id"], "acct_agent")
        self.assertEqual(stat.S_IMODE(os.stat(self.session_store).st_mode), 0o600)

    def test_429_backs_off_once_and_retries_request(self):
        sleeps = []
        http = FakeSession([
            FakeResponse(429, {"ok": False, "retryAfterSeconds": 2}),
            FakeResponse(200, {"ok": True, "items": []}),
        ])
        client = self.client(http=http, sleep_fn=sleeps.append)
        client.account_id = "acct_agent"

        result = client.tasks()

        self.assertEqual(result["items"], [])
        self.assertEqual(sleeps, [2.0])
        self.assertEqual([call["path"] for call in http.calls], ["/api/tasks", "/api/tasks"])

    def test_accept_task_uses_config_prepare_and_returns_verified_signature_without_submit(self):
        prepared = {"phase": "prepared", "txJson": prepared_pointer_tx(self.wallet, kind="TASK_UPDATE")}
        http = FakeSession([
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, prepared),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.accept_task("task_test", reason="Unit test accept", submit=False)

        self.assertTrue(result.submit_skipped)
        self.assertEqual(result.payload["schema"], "pf.task.update.v1")
        self.assertEqual(result.payload["transition"], "accepted")
        self.assertTrue(result.signed.verified)
        self.assertEqual(verify_signed_transaction_blob(result.signed.tx_blob, expected_address=self.wallet.address)["pointers"][0]["kind"], "TASK_UPDATE")
        self.assertEqual(len(http.calls), 2)
        self.assertEqual(client._submitted_once, set())

    def test_accept_task_submit_true_blocks_duplicate_submit_phase(self):
        prepared = {"phase": "prepared", "txJson": prepared_pointer_tx(self.wallet, kind="TASK_UPDATE")}
        http = FakeSession([
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, prepared),
            FakeResponse(200, {"phase": "submitted", "txHash": "SUBMIT1"}),
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, prepared),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.accept_task("task_test", reason="Unit test accept", submit=True)

        self.assertFalse(result.submit_skipped)
        self.assertIn(("task_action", "task_test", "accept"), client._submitted_once)
        with self.assertRaises(TaskNodeApiError) as raised:
            client.accept_task("task_test", reason="Unit test accept", submit=True)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.body["error"], "agent_double_submit_blocked")
        self.assertEqual(
            [call["json"]["phase"] for call in http.calls],
            ["config", "prepare", "submit", "config", "prepare"],
        )

    def test_submission_and_verification_response_sign_without_submit(self):
        submission_tx = prepared_pointer_tx(self.wallet, kind="TASK_SUBMISSION", task_id="task_test", cid="bafkreisubmission")
        verification_tx = prepared_pointer_tx(self.wallet, kind="TASK_SUBMISSION", task_id="task_test", cid="bafkreiverification")
        http = FakeSession([
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, {"phase": "prepared", "txJson": submission_tx}),
            FakeResponse(200, config_response(self.wallet, self.service)),
            FakeResponse(200, {"phase": "prepared", "txJson": verification_tx}),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        submission = client.submit_evidence("task_test", evidence_text="done", submit=False)
        response = client.respond_verification("task_test", response_text="confirmed", submit=False)

        self.assertEqual(submission.payload["schema"], "pf.task.submission.v1")
        self.assertEqual(response.payload["schema"], "pf.task.verification_response.v1")
        self.assertTrue(submission.signed.verified)
        self.assertTrue(response.signed.verified)

    def test_request_task_signs_bundle_and_event_prepare_without_submit(self):
        request_bundle = {"bundle_id": "bundle_1", "request": {"request_id": "req_1"}}
        config = {
            "phase": "config",
            "requestId": "req_1",
            "bundleId": "bundle_1",
            "requestText": "Request a task.",
            "userDetailText": "local unit test",
            "requestedTaskKind": "personal",
            "requestBundle": request_bundle,
            "tasknodeEncryptionPubkey": self.service.public_key_b64,
            "tasknodeServiceAddress": TASKNODE_AGENT_DESTINATION,
            "wallets": {"user": self.wallet.address, "authority": TASKNODE_AGENT_DESTINATION},
        }
        http = FakeSession([
            FakeResponse(200, config),
            FakeResponse(200, {"phase": "bundle_prepared", "bundleCid": "bafkreibundle", "bundleDigest": "sha256:abc"}),
            FakeResponse(200, {"phase": "prepared", "txJson": prepared_pointer_tx(self.wallet, kind="TASK", cid="bafkreirequest")}),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.request_task(user_detail_text="local unit test", submit=False)

        self.assertEqual(result.payload["schema"], "pf.task.request.v1")
        self.assertTrue(result.signed.verified)
        self.assertEqual([call["json"]["phase"] for call in http.calls], ["config", "prepare_bundle", "prepare"])
        self.assertEqual([call["json"].get("requestId") for call in http.calls[1:]], ["req_1", "req_1"])
        self.assertEqual([call["json"].get("bundleId") for call in http.calls[1:]], ["bundle_1", "bundle_1"])

    def test_publish_context_signs_without_submit(self):
        http = FakeSession([
            FakeResponse(200, {"phase": "config", "tasknodeEncryptionPubkey": self.service.public_key_b64}),
            FakeResponse(200, {"phase": "prepared", "txJson": prepared_pointer_tx(self.wallet, kind="CONTEXT", cid="bafkreicontext")}),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.publish_context(title="Agent", body="<p>Context</p>", submit=False)

        self.assertEqual(result.payload["schema"], "tasknode.context.v1")
        self.assertTrue(result.signed.verified)

    def test_ensure_context_published_publishes_fresh_account_and_verifies(self):
        http = FakeSession([
            FakeResponse(200, context_response(pointer_count=0, revision=0)),
            FakeResponse(200, {"ok": True, "document": {"revision": 1}}),
            FakeResponse(200, {"phase": "config", "tasknodeEncryptionPubkey": self.service.public_key_b64}),
            FakeResponse(200, prepared_context_response(self.wallet, revision=1)),
            FakeResponse(200, {"phase": "submitted", "cid": "bafkreicontext", "txHash": "ABC123"}),
            FakeResponse(
                200,
                context_response(
                    pointer_count=1,
                    revision=1,
                    latest_pointer={"cid": "bafkreicontext", "txHash": "ABC123"},
                ),
            ),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.ensure_context_published(title="Agent", body="<p>Context</p>")

        self.assertEqual(
            result,
            {
                "published": True,
                "revision": 1,
                "cid": "bafkreicontext",
                "pointerTx": "ABC123",
                "pointerCount": 1,
            },
        )
        self.assertEqual(
            [call["path"] for call in http.calls],
            [
                "/api/context",
                "/api/context/edit/save",
                "/api/context/manifest/ink",
                "/api/context/manifest/ink",
                "/api/context/manifest/ink",
                "/api/context",
            ],
        )
        self.assertEqual([call["json"].get("phase") for call in http.calls[2:5]], ["config", "prepare", "submit"])

    def test_ensure_context_published_noops_when_pointer_exists(self):
        pointer = {"cid": "bafkreiexisting", "txHash": "EXISTING123"}
        http = FakeSession([
            FakeResponse(200, context_response(pointer_count=1, revision=4, latest_pointer=pointer)),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.ensure_context_published(title="Agent", body="<p>Context</p>")

        self.assertEqual(
            result,
            {
                "published": False,
                "reason": "already_published",
                "pointerCount": 1,
                "revision": 4,
                "latestContextPointer": pointer,
            },
        )
        self.assertEqual([call["path"] for call in http.calls], ["/api/context"])

    def test_ensure_context_published_force_republishes_existing_pointer(self):
        http = FakeSession([
            FakeResponse(200, context_response(pointer_count=1, revision=4, latest_pointer={"cid": "old"})),
            FakeResponse(200, {"ok": True, "document": {"revision": 5}}),
            FakeResponse(200, {"phase": "config", "tasknodeEncryptionPubkey": self.service.public_key_b64}),
            FakeResponse(200, prepared_context_response(self.wallet, cid="bafkreiforced", revision=5)),
            FakeResponse(200, {"phase": "submitted", "cid": "bafkreiforced", "txHash": "FORCED123"}),
            FakeResponse(
                200,
                context_response(
                    pointer_count=2,
                    revision=5,
                    latest_pointer={"cid": "bafkreiforced", "txHash": "FORCED123"},
                ),
            ),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        result = client.ensure_context_published(title="Agent", body="<p>Forced</p>", force=True)

        self.assertTrue(result["published"])
        self.assertEqual(result["cid"], "bafkreiforced")
        self.assertEqual(result["pointerTx"], "FORCED123")
        self.assertEqual(result["pointerCount"], 2)
        self.assertEqual([call["json"].get("phase") for call in http.calls[2:5]], ["config", "prepare", "submit"])

    def test_ensure_context_published_raises_when_post_publish_read_has_no_pointer(self):
        http = FakeSession([
            FakeResponse(200, context_response(pointer_count=0, revision=0)),
            FakeResponse(200, {"ok": True, "document": {"revision": 1}}),
            FakeResponse(200, {"phase": "config", "tasknodeEncryptionPubkey": self.service.public_key_b64}),
            FakeResponse(200, prepared_context_response(self.wallet, revision=1)),
            FakeResponse(200, {"phase": "submitted", "cid": "bafkreicontext", "txHash": "ABC123"}),
            FakeResponse(200, context_response(pointer_count=0, revision=1)),
        ])
        client = self.client(http=http)
        client.account_id = "acct_agent"

        with self.assertRaises(TaskNodeApiError) as raised:
            client.ensure_context_published(title="Agent", body="<p>Context</p>")

        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(raised.exception.body["error"], "context_publish_not_pinned")
        self.assertEqual([call["json"].get("phase") for call in http.calls[2:5]], ["config", "prepare", "submit"])

    def test_tasknode_encrypted_payload_matches_app_envelope(self):
        payload = {"schema": "unit", "ok": True}
        encrypted = tasknode_encrypted_payload(payload, wallet=self.wallet, tasknode_encryption_pubkey=self.service.public_key_b64)

        self.assertEqual(encrypted["version"], 1)
        self.assertEqual(encrypted["enc"], "ENC_X25519_XCHACHA20P1305")
        self.assertTrue(encrypted["content_hash"])
        self.assertEqual(len(encrypted["recipients"]), 2)

    def test_sign_prepared_transaction_rejects_account_mismatch(self):
        tx = prepared_pointer_tx(self.wallet)
        tx["Account"] = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"

        with self.assertRaises(ValueError):
            sign_prepared_transaction(tx, self.wallet, expected_address=self.wallet.address)

    def test_synthetic_signing_proof_verifies_task_update_submission_and_verification_response(self):
        proofs = [
            build_synthetic_signed_pointer(self.wallet, kind="TASK_UPDATE", task_id="task_accept_proof"),
            build_synthetic_signed_pointer(self.wallet, kind="TASK_SUBMISSION", task_id="task_submission_proof"),
            build_synthetic_signed_pointer(self.wallet, kind="TASK_SUBMISSION", task_id="task_verification_response_proof"),
        ]

        self.assertTrue(all(proof["ok"] for proof in proofs))
        self.assertEqual([proof["verification"]["pointers"][0]["kind"] for proof in proofs], ["TASK_UPDATE", "TASK_SUBMISSION", "TASK_SUBMISSION"])

if __name__ == "__main__":
    unittest.main()
