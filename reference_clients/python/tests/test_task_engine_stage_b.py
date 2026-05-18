import unittest

from tasknode_pftl.reducer import ReplayEvent, reduce_task_events
from tasknode_pftl.scenarios.task_engine_stage_b import (
    allocation_count_for,
    assignment_for_index,
    stage_b_case_for_index,
)


class TaskEngineStageBTests(unittest.TestCase):
    def test_default_ten_wallet_assignment_uses_two_allocation_shards(self):
        allocation_count = allocation_count_for(10, None, 5)
        self.assertEqual(allocation_count, 2)

        assignments = [
            assignment_for_index(
                index,
                authority_count=2,
                allocation_count=allocation_count,
                allocation_shard_size=5,
            )
            for index in range(10)
        ]

        self.assertEqual([item["authority_index"] for item in assignments], [0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
        self.assertEqual([item["allocation_index"] for item in assignments], [0, 0, 0, 0, 0, 1, 1, 1, 1, 1])

    def test_stage_b_cases_include_refusal_and_faulty_paths(self):
        cases = [stage_b_case_for_index(index) for index in range(10)]

        self.assertTrue(any(case.task_decision == "refuse" for case in cases))
        self.assertTrue(any(case.faulty_initial for case in cases))
        self.assertIn("mixed", {case.evidence_type for case in cases})
        self.assertIn("screenshot", {case.evidence_type for case in cases})

    def test_refused_transition_reduces_to_refused_status(self):
        projections = reduce_task_events([
            ReplayEvent(
                payload={
                    "schema": "pf.task.offer.v1",
                    "task_id": "task_refused",
                    "title": "Refused task",
                    "description": "D",
                    "task_kind": "system",
                    "reward_offer": {"amount_estimate_pft": "1.00"},
                },
                pointer={"kind": "TASK", "cid": "baf_offer", "task_id": "task_refused"},
                source_tx_hash="offer_tx",
                event_type="pf.task.offer.v1",
            ),
            ReplayEvent(
                payload={
                    "schema": "pf.task.update.v1",
                    "task_id": "task_refused",
                    "transition": "refused",
                },
                pointer={"kind": "TASK_UPDATE", "cid": "baf_refused", "task_id": "task_refused"},
                source_tx_hash="refused_tx",
                event_type="pf.task.update.v1",
            ),
        ])

        self.assertEqual(projections["task_refused"].status, "refused")


if __name__ == "__main__":
    unittest.main()
