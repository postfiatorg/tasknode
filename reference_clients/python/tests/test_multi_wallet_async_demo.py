import unittest

from tasknode_pftl.scenarios.multi_wallet_async_demo import (
    allocation_count_for,
    apply_demo_reward_policy,
    assignment_for_index,
)


class MultiWalletAsyncDemoTest(unittest.TestCase):
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

    def test_reward_policy_override_is_scoped_to_copy(self):
        original = {
            "title": "Original task",
            "reward_offer": {
                "amount_estimate_pft": "3.20",
            },
        }

        updated = apply_demo_reward_policy(original, 0.75)

        self.assertEqual(updated["reward_offer"]["amount_estimate_pft"], "0.75")
        self.assertEqual(original["reward_offer"]["amount_estimate_pft"], "3.20")


if __name__ == "__main__":
    unittest.main()
