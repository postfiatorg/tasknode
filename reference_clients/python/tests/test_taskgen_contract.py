import unittest
from unittest.mock import patch

from tasknode_pftl.config import PftlConfig
from tasknode_pftl.taskgen import build_request_bundle, generate_task, project_taskgen_input


class TaskgenContractTests(unittest.TestCase):
    def test_fallback_task_is_minimal_schema(self):
        bundle = build_request_bundle(subject_wallet="rUser", allocation_wallet="rAllocation")
        task_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:abc")
        result = generate_task(PftlConfig(openai_api_key=None), task_input, allow_fallback=True)
        self.assertEqual(result.output["schema"], "pf.taskgen.output.v1")
        self.assertEqual(result.output["submission_requirement"]["type"], "text")
        self.assertEqual(result.metadata["parse_status"], "fallback")

    def test_taskgen_fails_closed_without_openai_key(self):
        bundle = build_request_bundle(subject_wallet="rUser", allocation_wallet="rAllocation")
        task_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:abc")
        with self.assertRaisesRegex(RuntimeError, "OPENAI_API_KEY is required"):
            generate_task(PftlConfig(openai_api_key=None), task_input)

    def test_chat_latest_request_omits_temperature(self):
        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "id": "chatcmpl_test",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"schema":"pf.taskgen.output.v1","title":"T","description":"D","task_kind":"system",'
                                    '"submission_requirement":{"type":"text","criteria":"C"},'
                                    '"verification_policy":{"followup_required":true,"mode":"standard_followup","verification_type":"text"},'
                                    '"reward_offer":{"amount_estimate_pft":"1.00"},'
                                    '"deadline":{"accept_by":"soon","deadline_at":null}}'
                                )
                            }
                        }
                    ],
                }

        bundle = build_request_bundle(subject_wallet="rUser", allocation_wallet="rAllocation")
        task_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:abc")

        with patch("tasknode_pftl.taskgen.requests.post", return_value=FakeResponse()) as post:
            result = generate_task(PftlConfig(openai_api_key="test-key"), task_input)

        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "chat-latest")
        self.assertNotIn("temperature", payload)
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertTrue(payload["response_format"]["json_schema"]["strict"])
        self.assertEqual(result.metadata["parse_status"], "ok")

    def test_taskgen_reward_is_sanitized_to_reference_range(self):
        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "id": "chatcmpl_test",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"schema":"pf.taskgen.output.v1","title":"T","description":"D","task_kind":"system",'
                                    '"submission_requirement":{"type":"text","criteria":"C"},'
                                    '"verification_policy":{"followup_required":true,"mode":"standard_followup","verification_type":"text"},'
                                    '"reward_offer":{"amount_estimate_pft":"450"},'
                                    '"deadline":{"accept_by":"soon","deadline_at":null}}'
                                )
                            }
                        }
                    ],
                }

        bundle = build_request_bundle(subject_wallet="rUser", allocation_wallet="rAllocation")
        task_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:abc")

        with patch("tasknode_pftl.taskgen.requests.post", return_value=FakeResponse()):
            result = generate_task(PftlConfig(openai_api_key="test-key"), task_input)

        self.assertEqual(result.output["reward_offer"]["amount_estimate_pft"], "3.20")


if __name__ == "__main__":
    unittest.main()
