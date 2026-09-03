import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("release_runner.py")
SPEC = importlib.util.spec_from_file_location("harness_release_runner", SCRIPT)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ReleaseRunnerTest(unittest.TestCase):
    def test_write_state_replaces_the_file_with_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "current.json"
            state = {"status": "running", "updatedAt": 0}

            runner.write_state(path, state)

            saved = json.loads(path.read_text())
            self.assertEqual(saved["status"], "running")
            self.assertGreater(saved["updatedAt"], 0)
            self.assertFalse(path.with_suffix(".tmp").exists())


if __name__ == "__main__":
    unittest.main()
