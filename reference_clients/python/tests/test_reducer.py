import unittest

from tasknode_pftl.reducer import ReplayEvent, reduce_task_events


def event(schema, task_id="task_1", **payload):
    return ReplayEvent(
        pointer={"kind": payload.pop("kind", "TASK"), "cid": f"cid-{schema}"},
        payload={"schema": schema, "task_id": task_id, **payload},
        source_tx_hash=f"tx-{schema}",
        event_type=schema,
    )


class ReducerTests(unittest.TestCase):
    def test_full_status_reaches_rewarded(self):
        events = [
            event("pf.task.offer.v1", title="T", description="D", task_kind="system", reward_offer={"amount_estimate_pft": "3.20"}),
            event("pf.task.update.v1", transition="accepted", kind="TASK_UPDATE"),
            event("pf.task.submission.v1", phase="initial_submission", kind="TASK_SUBMISSION"),
            event("pf.task.update.v1", transition="verification_requested", kind="TASK_UPDATE"),
            event("pf.task.verification_response.v1", phase="verification_response", kind="TASK_SUBMISSION"),
            event("pf.reward.v1", reward_pft="3.20", kind="REWARD"),
        ]
        projection = reduce_task_events(events)["task_1"]
        self.assertEqual(projection.status, "rewarded")
        self.assertEqual(projection.reward_actual_pft, "3.20")
        self.assertEqual(len(projection.events), 6)


if __name__ == "__main__":
    unittest.main()

