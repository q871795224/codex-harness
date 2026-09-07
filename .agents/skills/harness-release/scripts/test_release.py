import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("release.py")
SPEC = importlib.util.spec_from_file_location("harness_release", SCRIPT)
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseScriptTest(unittest.TestCase):
    def test_process_lookup_includes_ancestor_processes(self):
        executable = Path("/Applications/Codex Harness.app/Contents/MacOS/codex-harness")

        with patch.object(release, "try_run") as try_run:
            release.find_processes(executable)

        try_run.assert_called_once_with("pgrep", "-a", "-f", str(executable))

    def test_check_installs_dependencies_before_cargo_test(self):
        calls = []
        with (
            patch.object(release, "require_synced_versions"),
            patch.object(release, "ensure_dependencies", side_effect=lambda: calls.append("dependencies")),
            patch.object(release, "run", side_effect=lambda *args, **kwargs: calls.append(args[0])),
        ):
            release.command_check("0.7.7")

        self.assertEqual(calls, ["dependencies", "cargo"])

    def test_capture_preserves_porcelain_leading_space(self):
        original_root = release.REPO_ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release.REPO_ROOT = root
            try:
                release.run("git", "init", "--quiet", cwd=root)
                (root / "tracked.txt").write_text("before\n")
                release.run("git", "add", "tracked.txt", cwd=root)
                release.run(
                    "git",
                    "-c",
                    "user.name=Release Test",
                    "-c",
                    "user.email=release-test@example.com",
                    "commit",
                    "--quiet",
                    "-m",
                    "initial",
                    cwd=root,
                )
                (root / "tracked.txt").write_text("after\n")
                self.assertEqual(
                    release.run("git", "status", "--porcelain", cwd=root, capture=True),
                    " M tracked.txt",
                )
            finally:
                release.REPO_ROOT = original_root

    def test_updates_all_version_sources_without_touching_dependency_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src-tauri").mkdir()
            (root / "package.json").write_text('{"name":"codex-harness","version":"0.7.5"}\n')
            (root / "src-tauri/tauri.conf.json").write_text(
                '{"productName":"Codex Harness","version":"0.7.5"}\n'
            )
            (root / "src-tauri/Cargo.toml").write_text(
                '[package]\nname = "codex-harness"\nversion = "0.7.5"\n\n'
                '[dependencies]\nsemver = "1"\n'
            )
            (root / "src-tauri/Cargo.lock").write_text(
                '[[package]]\nname = "codex-harness"\nversion = "0.7.5"\n\n'
                '[[package]]\nname = "toml_datetime"\nversion = "0.7.5+spec-1.1.0"\n'
            )

            release.update_version_files(root, "0.8.0")

            self.assertEqual(json.loads((root / "package.json").read_text())["version"], "0.8.0")
            self.assertEqual(
                json.loads((root / "src-tauri/tauri.conf.json").read_text())["version"], "0.8.0"
            )
            self.assertIn('version = "0.8.0"', (root / "src-tauri/Cargo.toml").read_text())
            lock = (root / "src-tauri/Cargo.lock").read_text()
            self.assertIn('name = "codex-harness"\nversion = "0.8.0"', lock)
            self.assertIn('version = "0.7.5+spec-1.1.0"', lock)

    def test_rejects_non_stable_semver(self):
        for value in ("0.7", "0.7.6-beta.1", "01.2.3", "latest"):
            with self.subTest(value=value), self.assertRaises(release.ReleaseError):
                release.parse_version(value)


if __name__ == "__main__":
    unittest.main()
