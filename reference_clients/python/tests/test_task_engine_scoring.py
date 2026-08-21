import unittest
from unittest.mock import patch

from tasknode_pftl.config import PftlConfig
from tasknode_pftl.engine.scoring import generate_verification_request, score_submission


TASK_OFFER = {
    "task_id": "task_test",
    "title": "Validate evidence",
    "description": "Submit a concrete artifact.",
    "submission_requirement": {"type": "url", "criteria": "Submit a public URL."},
    "verification_policy": {"followup_required": True, "mode": "standard_followup", "verification_type": "text"},
    "reward_offer": {"amount_estimate_pft": "1.50"},
}


class TaskEngineScoringTests(unittest.TestCase):
    def test_verification_request_requires_provider_key(self):
        with self.assertRaisesRegex(RuntimeError, "OPENAI_API_KEY is required"):
            generate_verification_request(
                config=PftlConfig(openai_api_key=None),
                task_offer=TASK_OFFER,
                initial_submission={"schema": "pf.task.submission.v1"},
                processed_evidence={"artifacts": []},
            )

    def test_verification_request_uses_model_json(self):
        class FakeResponse:
            ok = True

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "id": "chatcmpl_verify",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"assessment":"legitimate","verification_ask":"What exact visible detail proves completion?",'
                                    '"verification_type":"text","reason":"This checks the artifact detail."}'
                                )
                            }
                        }
                    ],
                }

        with patch("tasknode_pftl.engine.scoring.requests.post", return_value=FakeResponse()) as post:
            result = generate_verification_request(
                config=PftlConfig(openai_api_key="test-key"),
                task_offer=TASK_OFFER,
                initial_submission={"schema": "pf.task.submission.v1"},
                processed_evidence={"artifacts": [{"excerpt": "real artifact"}]},
            )

        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["response_format"]["type"], "json_schema")
        self.assertEqual(result.output["assessment"], "legitimate")
        self.assertEqual(result.metadata["parse_status"], "ok")

    def test_scoring_clamps_reward_to_offer(self):
        class FakeResponse:
            ok = True

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "id": "chatcmpl_score",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"decision":"reward","reward_pft":"10.00","completion":100,'
                                    '"evidence_quality":95,"reason":"Evidence is sufficient.",'
                                    '"user_feedback":"Reward approved."}'
                                )
                            }
                        }
                    ],
                }

        with patch("tasknode_pftl.engine.scoring.requests.post", return_value=FakeResponse()):
            result = score_submission(
                config=PftlConfig(openai_api_key="test-key"),
                task_offer=TASK_OFFER,
                initial_submission={"schema": "pf.task.submission.v1"},
                verification_request={"verification_ask": "detail?"},
                verification_response={"response_text": "detail"},
                processed_evidence={"artifacts": [{"excerpt": "real artifact"}]},
            )

        self.assertEqual(result.output["reward_pft"], "1.50")
        self.assertEqual(result.output["decision"], "reward")


if __name__ == "__main__":
    unittest.main()
