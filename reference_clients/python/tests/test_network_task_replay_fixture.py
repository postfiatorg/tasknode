import unittest

from tasknode_pftl.scenarios.network_task_replay_fixture import replay_fixture


class NetworkTaskReplayFixtureTests(unittest.TestCase):
    def test_canonical_network_task_fixture_replays_to_rewarded(self):
        receipt = replay_fixture()

        self.assertEqual(receipt["fixture_id"], "network_task_lifecycle_replay_v1")
        self.assertEqual(receipt["task_id"], "task_net_replay_000000000000000000000001")
        self.assertEqual(receipt["final_status"], "rewarded")
        self.assertEqual(receipt["reward_actual_pft"], "12000")
        self.assertEqual(receipt["transition_count"], 5)
        self.assertEqual(
            [transition["to_status"] for transition in receipt["transitions"]],
            ["proposed", "accepted", "submitted", "reward_decided", "rewarded"],
        )


if __name__ == "__main__":
    unittest.main()
