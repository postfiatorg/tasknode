import unittest

from tasknode_pftl.prompt_registry import load_prompt, prompt_digest, render_prompt


class PromptRegistryTests(unittest.TestCase):
    def test_taskgen_prompt_loads_from_repo_prompts(self):
        prompt = load_prompt("task_engine/taskgen_minimal_v1.md")
        self.assertIn("pf.taskgen.input.v1", prompt)
        self.assertIn("memory", prompt.lower())
        self.assertIn("recent messages", prompt.lower())
        self.assertEqual(len(prompt_digest(prompt)), 64)

    def test_prompt_template_rendering(self):
        prompt = render_prompt("Task title: {{TASK_TITLE}}", {"TASK_TITLE": "Ship docs"})
        self.assertEqual(prompt, "Task title: Ship docs")


if __name__ == "__main__":
    unittest.main()
