import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("release.py")
SPEC = importlib.util.spec_from_file_location("harness_release", SCRIPT)
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseScriptTest(unittest.TestCase):
    def test_command_logging_includes_duration(self):
        completed = release.subprocess.CompletedProcess(
            args=("echo", "ok"), returncode=0, stdout="ok\n", stderr=""
        )
        output = StringIO()
        with (
            patch.object(release.subprocess, "run", return_value=completed),
            patch.object(release.time, "monotonic", side_effect=[10.0, 10.25]),
            redirect_stdout(output),
        ):
            result = release.run("echo", "ok", capture=True)

        self.assertEqual(result, "ok")
        self.assertIn('"event": "command.started"', output.getvalue())
        self.assertIn('"event": "command.finished"', output.getvalue())
        self.assertIn('"durationMs": 250', output.getvalue())

    def test_application_path_uses_configured_cargo_target_dir(self):
        with patch.dict(os.environ, {"CARGO_TARGET_DIR": "/tmp/codex-harness-target"}):
            self.assertEqual(
                release.application_path(),
                Path("/tmp/codex-harness-target/universal-apple-darwin/release/bundle/macos/Codex Harness.app"),
            )

    def test_configure_release_environment_normalizes_relative_target_dir(self):
        with patch.dict(os.environ, {"CARGO_TARGET_DIR": "release-target"}):
            target_dir = release.configure_release_environment()
            configured = os.environ["CARGO_TARGET_DIR"]

        self.assertEqual(target_dir, release.REPO_ROOT / "release-target")
        self.assertEqual(configured, str(target_dir))

    def test_prepare_uses_the_provided_base_sha_without_fetching(self):
        calls = []
        with (
            patch.object(release, "require_clean_worktree"),
            patch.object(release, "run", side_effect=lambda *args, **kwargs: calls.append(args) or {
                ("git", "rev-parse", "base-sha^{commit}"): "base-sha",
                ("git", "rev-parse", "HEAD"): "base-sha",
                ("git", "show", "base-sha:package.json"): '{"version":"0.7.6"}',
                ("git", "ls-remote", "--tags", "origin", "refs/tags/v0.7.7"): "",
                ("git", "ls-remote", "--heads", "origin", "refs/heads/release/v0.7.7"): "",
            }.get(args, "")),
            patch.object(release, "try_run", return_value=release.subprocess.CompletedProcess([], 1)),
            patch.object(release, "update_version_files"),
            patch.object(release, "require_synced_versions"),
        ):
            release.command_prepare("0.7.7", "base-sha")

        self.assertNotIn(("git", "fetch", "origin", "--prune", "--tags"), calls)
        self.assertIn(("git", "switch", "--create", "release/v0.7.7", "base-sha"), calls)

    def test_universal_build_uses_parallel_cargo_runner(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"CARGO_TARGET_DIR": directory}
        ), patch.object(release, "run") as run:
            release.build_universal_app()

        args = run.call_args.args
        self.assertEqual(
            args[:5],
            ("pnpm", "tauri", "build", "--target", "universal-apple-darwin"),
        )
        self.assertEqual(args[5], "--runner")
        self.assertEqual(Path(args[6]), release.PARALLEL_CARGO_RUNNER)

    def test_process_lookup_includes_ancestor_processes(self):
        executable = Path("/Applications/Codex Harness.app/Contents/MacOS/codex-harness")

        with patch.object(release, "try_run") as try_run:
            release.find_processes(executable)

        try_run.assert_called_once_with("pgrep", "-a", "-f", str(executable))

    def test_remote_asset_verification_retries_with_exponential_backoff(self):
        checksum = "abc123"
        command = ("gh", "release", "view", "v0.7.11", "--json", "url,tagName,assets")
        missing_digest = json.dumps({"assets": [{"name": "bundle.zip"}]})
        matching_digest = json.dumps(
            {"assets": [{"name": "bundle.zip", "digest": f"sha256:{checksum}"}]}
        )

        with (
            patch.object(
                release,
                "run",
                side_effect=[missing_digest] * 6 + [matching_digest],
            ) as run,
            patch.object(release.time, "sleep") as sleep,
        ):
            details = release.verify_remote_asset("v0.7.11", "bundle.zip", checksum)

        self.assertEqual(details["assets"][0]["digest"], f"sha256:{checksum}")
        self.assertEqual(run.call_count, 7)
        self.assertEqual([call.args for call in run.call_args_list], [command] * 7)
        self.assertEqual([call.kwargs for call in run.call_args_list], [{"capture": True}] * 7)
        self.assertEqual(
            [call.args[0] for call in sleep.call_args_list], [1, 2, 4, 8, 16, 32]
        )

    def test_remote_asset_digest_pending_raises_friendly_message(self):
        checksum = "abc123"
        missing_digest = json.dumps({"assets": [{"name": "bundle.zip"}]})

        with (
            patch.object(release, "run", return_value=missing_digest),
            patch.object(release.time, "sleep"),
        ):
            with self.assertRaises(release.ReleaseError) as context:
                release.verify_remote_asset("v0.7.11", "bundle.zip", checksum)

        self.assertEqual(str(context.exception), release.ASSET_DIGEST_PENDING_MESSAGE)

    def test_remote_asset_digest_mismatch_raises_details(self):
        checksum = "abc123"
        mismatched = json.dumps(
            {"assets": [{"name": "bundle.zip", "digest": "sha256:other"}]}
        )

        with (
            patch.object(release, "run", return_value=mismatched),
            patch.object(release.time, "sleep"),
        ):
            with self.assertRaises(release.ReleaseError) as context:
                release.verify_remote_asset("v0.7.11", "bundle.zip", checksum)

        self.assertIn("remote release asset verification failed", str(context.exception))

    def test_check_installs_dependencies_before_cargo_test(self):
        calls = []
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"CARGO_TARGET_DIR": directory}
        ), patch.object(release, "require_synced_versions"), patch.object(
            release, "ensure_dependencies", side_effect=lambda: calls.append("dependencies")
        ), patch.object(release, "run", side_effect=lambda *args, **kwargs: calls.append(args[0])):
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

    def test_prepend_path_adds_missing_directory_once(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}):
            release._prepend_path(Path("/custom/bin"))
            release._prepend_path(Path("/custom/bin"))
            self.assertEqual(os.environ["PATH"], "/custom/bin:/usr/bin:/bin")

    def test_bootstrap_tool_path_finds_pnpm_and_cargo(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            nvm_bin = home / ".nvm/versions/node/v22.0.0/bin"
            nvm_bin.mkdir(parents=True)
            (nvm_bin / "pnpm").write_text("")
            (nvm_bin / "cargo").write_text("")

            with (
                patch.object(release.Path, "home", return_value=home),
                # Force "not found" until a dir is prepended: report found only
                # once a dir containing the tool is on PATH.
                patch.object(
                    release.shutil,
                    "which",
                    side_effect=lambda tool: (
                        str(nvm_bin / tool) if str(nvm_bin) in os.environ.get("PATH", "") else None
                    ),
                ),
                patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}),
            ):
                release.bootstrap_tool_path()
                path_entries = os.environ["PATH"].split(os.pathsep)
                self.assertIn(str(nvm_bin), path_entries)
                self.assertEqual(release.shutil.which("pnpm"), str(nvm_bin / "pnpm"))
                self.assertEqual(release.shutil.which("cargo"), str(nvm_bin / "cargo"))

    def test_bootstrap_tool_path_noop_when_tools_already_present(self):
        original_path = os.environ.get("PATH", "")
        with (
            patch.object(release.shutil, "which", return_value="/usr/local/bin/tool"),
            patch.dict(os.environ, {"PATH": original_path}),
        ):
            release.bootstrap_tool_path()
            self.assertEqual(os.environ["PATH"], original_path)


if __name__ == "__main__":
    unittest.main()
