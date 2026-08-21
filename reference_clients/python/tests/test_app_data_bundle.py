import unittest

from tasknode_pftl.app_data import build_context_doc_payload, build_request_bundle_from_fixture
from tasknode_pftl.taskgen import project_taskgen_input


class Fixture:
    account_id = "acct_test"
    conversation = {"id": "chat_task_sample", "title": "task_sample"}
    request_message = {
        "id": "msg_req_user",
        "body": "whatever you think is right",
        "created_at": "2026-05-18 00:05:29.767+00",
        "metadata": {
            "requestId": "req_test",
            "bundleId": "bundle_test",
            "requestText": "Request a task using my current context document, account memory, recent messages, and the additional task details I just provided.",
            "userDetailText": "whatever you think is right",
            "requestedTaskKind": "personal",
            "source": "user_chat",
            "sourceConversationTitle": "task_sample",
        },
    }
    receipt_message = {"id": "msg_req_assistant"}
    context_document = {
        "id": "ctx_test",
        "revision_id": "ctx_rev_1",
        "title": "Task Node Context",
        "revision": 8,
        "body": "<p>Context body with <strong>HTML</strong>.</p>",
        "body_sha256": "abc123",
        "word_count": 5,
        "created_at": "2026-05-17 20:00:00+00",
        "updated_at": "2026-05-17 21:00:00+00",
    }
    recent_messages = [
        {"id": "m1", "role": "user", "body": "what should go into tasks", "created_at": "2026-05-17 23:38:05+00"},
        {"id": "m2", "role": "assistant", "body": "focus on an operational flow", "created_at": "2026-05-17 23:38:06+00"},
    ]
    recent_memory = [
        {
            "id": "mem_1",
            "kind": "turn_memory",
            "conversation_id": "chat_1",
            "conversation_title": "Other chat",
            "user_request_summary": "User asked about tasks.",
            "system_response_summary": "System recommended a minimal task flow.",
            "memory_text": "The user wants a portable task system.",
            "created_at": "2026-05-17 23:00:00+00",
        }
    ]
    deep_memory = []

    @property
    def request_metadata(self):
        return self.request_message["metadata"]

    @property
    def request_id(self):
        return self.request_metadata["requestId"]

    @property
    def bundle_id(self):
        return self.request_metadata["bundleId"]


class AppDataBundleTests(unittest.TestCase):
    def test_builds_request_bundle_from_real_shape(self):
        bundle = build_request_bundle_from_fixture(
            Fixture(),
            subject_wallet="rUser",
            allocation_wallet="rAlloc",
            authority_wallet="rAuth",
        )

        self.assertEqual(bundle["schema"], "pf.task.request_bundle.v1")
        self.assertEqual(bundle["bundle_id"], "bundle_test")
        self.assertEqual(bundle["request"]["request_id"], "req_test")
        self.assertEqual(bundle["request"]["user_detail_text"], "whatever you think is right")
        self.assertEqual(bundle["client"]["conversation_title"], "task_sample")
        self.assertEqual(len(bundle["recent_chat"]["messages"]), 2)
        self.assertEqual(len(bundle["memory"]["recent_memory"]), 1)
        self.assertIn("Context body", bundle["context"]["primary_context_doc"]["summary"])

        taskgen_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:bundle")
        self.assertEqual(taskgen_input["request"]["user_detail_text"], "whatever you think is right")
        self.assertEqual(len(taskgen_input["memory"]["recent_memory"]), 1)
        self.assertIn("The user wants a portable task system.", taskgen_input["chat"]["relevant_history_summary"])

    def test_context_payload_preserves_body(self):
        payload = build_context_doc_payload(Fixture(), subject_wallet="rUser")

        self.assertEqual(payload["schema"], "pf.context.doc.v1")
        self.assertEqual(payload["context_id"], "ctx_test")
        self.assertIn("<strong>HTML</strong>", payload["content"])


if __name__ == "__main__":
    unittest.main()
