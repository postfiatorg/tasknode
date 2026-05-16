import unittest

from tasknode_pftl.config import PftlConfig
from tasknode_pftl.taskgen import build_request_bundle, generate_task, project_taskgen_input


class TaskgenContractTests(unittest.TestCase):
    def test_fallback_task_is_minimal_schema(self):
        bundle = build_request_bundle(subject_wallet="rUser", allocation_wallet="rAllocation")
        task_input = project_taskgen_input(bundle, bundle_cid="bafbundle", bundle_digest="sha256:abc")
        result = generate_task(PftlConfig(openai_api_key=None), task_input)
        self.assertEqual(result.output["schema"], "pf.taskgen.output.v1")
        self.assertEqual(result.output["submission_requirement"]["type"], "text")
        self.assertEqual(result.metadata["parse_status"], "fallback")


if __name__ == "__main__":
    unittest.main()

