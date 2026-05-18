import tempfile
import unittest
from pathlib import Path

from tasknode_pftl.scenarios.local_json_task_loop import run_demo


class LocalJsonTaskLoopTests(unittest.TestCase):
    def test_demo_persists_deterministic_full_loop(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt = run_demo(store_dir=Path(tmp), reset=True)
            repeat = run_demo(store_dir=Path(tmp), reset=True)

            self.assertEqual(receipt["receipt_id"], repeat["receipt_id"])
            self.assertEqual(receipt["state_digest"], repeat["state_digest"])
            self.assertEqual(receipt["final_status"], "rewarded")
            self.assertEqual(receipt["transition_count"], 5)
            self.assertEqual(
                [transition["to"] for transition in receipt["transitions"]],
                ["proposed", "accepted", "submitted", "reviewed", "rewarded"],
            )
            self.assertEqual(receipt["reputation_before"]["reputation_points"], 42)
            self.assertEqual(receipt["reputation_after"]["reputation_points"], 50)
            self.assertTrue((Path(tmp) / "events.json").exists())
            self.assertTrue((Path(tmp) / "tasks.json").exists())
            self.assertTrue((Path(tmp) / "artifacts.json").exists())
            self.assertTrue((Path(tmp) / "reputation.json").exists())
            self.assertTrue((Path(tmp) / "receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
