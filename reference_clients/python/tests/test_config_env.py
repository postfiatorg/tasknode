import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tasknode_pftl.config import load_env


class ConfigEnvTests(unittest.TestCase):
    def test_later_env_files_override_legacy_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            legacy = Path(tmp) / "legacy.env"
            current = Path(tmp) / "current.env"
            legacy.write_text("OPENAI_API_KEY=stale\nPFTL_RPC_URL=http://legacy\n", encoding="utf-8")
            current.write_text("OPENAI_API_KEY=fresh\n", encoding="utf-8")

            with patch.dict(os.environ, {}, clear=True):
                env = load_env([legacy, current])

            self.assertEqual(env["OPENAI_API_KEY"], "fresh")
            self.assertEqual(env["PFTL_RPC_URL"], "http://legacy")

    def test_process_environment_overrides_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "current.env"
            path.write_text("OPENAI_API_KEY=file-value\n", encoding="utf-8")

            with patch.dict(os.environ, {"OPENAI_API_KEY": "process-value"}, clear=True):
                env = load_env([path])

            self.assertEqual(env["OPENAI_API_KEY"], "process-value")


if __name__ == "__main__":
    unittest.main()
