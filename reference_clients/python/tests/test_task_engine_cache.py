import unittest

from tasknode_pftl.engine.cache import attach_task_queue_cache, summarize_task_queue
from tasknode_pftl.taskgen import build_request_bundle, project_taskgen_input


class TaskEngineCacheTests(unittest.TestCase):
    def test_summarize_task_queue_groups_and_caps_history(self):
        rows = [
            {"task_id": "open_1", "status": "accepted", "title": "Open", "reward_offer_pft": "1.0"},
            {"task_id": "verify_1", "status": "verification_requested", "title": "Verify", "reward_offer_pft": "1.0"},
            *[
                {"task_id": f"refused_{index}", "status": "refused", "title": "Refused", "reward_offer_pft": "1.0"}
                for index in range(12)
            ],
            *[
                {"task_id": f"rewarded_{index}", "status": "rewarded", "title": "Rewarded", "reward_actual_pft": "1.0"}
                for index in range(14)
            ],
        ]

        summary = summarize_task_queue(rows)

        self.assertEqual(summary["summary"]["outstanding"], 1)
        self.assertEqual(summary["summary"]["pending_verification"], 1)
        self.assertEqual(len(summary["groups"]["refused"]), 10)
        self.assertEqual(len(summary["groups"]["rewarded"]), 12)

    def test_attach_task_queue_cache_marks_unavailable_without_blocking_bundle(self):
        bundle = build_request_bundle(subject_wallet="rUser", allocation_wallet="rAllocation")

        attach_task_queue_cache(bundle, database_url="postgres://invalid")
        task_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:abc")

        self.assertEqual(task_input["task_queue"]["status"], "cache_unavailable")
        self.assertEqual(task_input["task_queue"]["summary"]["outstanding"], 0)


if __name__ == "__main__":
    unittest.main()
