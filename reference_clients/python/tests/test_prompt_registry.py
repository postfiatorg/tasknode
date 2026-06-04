import unittest

from tasknode_pftl.prompt_registry import load_prompt, prompt_digest, render_prompt


class PromptRegistryTests(unittest.TestCase):
    def test_taskgen_personal_prompt_loads_from_repo_prompts(self):
        prompt = load_prompt("task_engine/taskgen_personal_v1.md")
        self.assertIn("pf.taskgen.input.v1", prompt)
        self.assertIn("memory", prompt.lower())
        self.assertIn("recent messages", prompt.lower())
        self.assertIn("Do not request video", prompt)
        self.assertIn("2 to 5 concrete steps", prompt)
        self.assertNotIn("network_task", prompt)
        self.assertNotIn("Board Manager", prompt)
        self.assertEqual(len(prompt_digest(prompt)), 64)

    def test_taskgen_network_prompt_loads_from_repo_prompts(self):
        prompt = load_prompt("task_engine/taskgen_network_v1.md")
        self.assertIn("pf.taskgen.input.v1", prompt)
        self.assertIn("network_task", prompt)
        self.assertIn("Board Manager", prompt)
        self.assertIn("Post Fiat", prompt)
        self.assertIn("data lake", prompt)
        self.assertIn("sybil resistant", prompt)
        self.assertIn("pf.hive.network_task_request.v1", prompt)
        self.assertIn("pf.task.request_bundle.v1", prompt)
        self.assertIn("pf.task.offer.v1", prompt)
        self.assertIn("Do not request video", prompt)
        self.assertEqual(len(prompt_digest(prompt)), 64)

    def test_prompt_template_rendering(self):
        prompt = render_prompt("Task title: {{TASK_TITLE}}", {"TASK_TITLE": "Ship docs"})
        self.assertEqual(prompt, "Task title: Ship docs")


if __name__ == "__main__":
    unittest.main()
