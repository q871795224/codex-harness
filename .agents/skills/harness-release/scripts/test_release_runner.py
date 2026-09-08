import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
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

    def test_digest_pending_publish_is_recorded_as_warning_success(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "current.json"
            error = subprocess.CalledProcessError(
                1,
                ("release.py", "publish", "0.8.8"),
                output="",
                stderr=f"release failed: {runner.ASSET_DIGEST_PENDING_MESSAGE}",
            )
            exit_code = self._run_with_publish_error(state_path, Path(directory), error)

            self.assertEqual(exit_code, 0)
            saved = json.loads(state_path.read_text())
            self.assertEqual(saved["status"], "succeeded")
            self.assertTrue(saved["warning"])
            self.assertEqual(saved["error"], runner.ASSET_DIGEST_PENDING_MESSAGE)

    def test_other_failures_are_recorded_as_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "current.json"
            error = subprocess.CalledProcessError(
                1, ("release.py", "publish", "0.8.8"), output="", stderr="real error"
            )
            exit_code = self._run_with_publish_error(state_path, Path(directory), error)

            self.assertEqual(exit_code, 1)
            saved = json.loads(state_path.read_text())
            self.assertEqual(saved["status"], "failed")
            self.assertFalse(saved["warning"])

    def _run_with_publish_error(
        self, state_path: Path, directory: Path, error: subprocess.CalledProcessError
    ) -> int:
        workspace = directory / "workspace"
        workspace.mkdir()
        worktree = directory / "worktree"
        script = worktree / ".agents/skills/harness-release/scripts/release.py"
        script.parent.mkdir(parents=True)
        script.write_text("# stub\n")
        argv = [
            "release_runner.py",
            "--workspace",
            str(workspace),
            "--worktree",
            str(worktree),
            "--state",
            str(state_path),
            "--run-id",
            "run-1",
            "--version",
            "0.8.8",
            "--base-sha",
            "base-sha",
        ]

        def fake_run_step(state, path, *args, cwd) -> None:
            if "publish" in args:
                raise error

        with patch.object(sys, "argv", argv), patch.object(
            runner, "run_step", side_effect=fake_run_step
        ):
            return runner.main()


if __name__ == "__main__":
    unittest.main()
