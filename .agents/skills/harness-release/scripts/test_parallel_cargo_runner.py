import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("parallel_cargo_runner.py")
SPEC = importlib.util.spec_from_file_location("parallel_cargo_runner", SCRIPT)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ParallelCargoRunnerTest(unittest.TestCase):
    def test_main_builds_both_architectures_once_and_reuses_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            cargo = bin_dir / "cargo"
            cargo.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "if sys.argv[1:4] == ['metadata', '--no-deps', '--format-version']:\n"
                "    print(json.dumps({'packages': [{'targets': [{'name': 'codex-harness', 'kind': ['bin']}]}]}))\n"
                "    raise SystemExit(0)\n"
                "target = sys.argv[sys.argv.index('--target') + 1]\n"
                "output = pathlib.Path(os.environ['CARGO_TARGET_DIR']) / target / 'release' / 'codex-harness'\n"
                "output.parent.mkdir(parents=True, exist_ok=True)\n"
                "output.write_bytes(target.encode())\n"
                "with pathlib.Path(os.environ['CARGO_TEST_LOG']).open('a') as stream:\n"
                "    stream.write(target + '\\n')\n"
            )
            cargo.chmod(cargo.stat().st_mode | stat.S_IXUSR)
            log_path = root / "cargo.log"
            args = ["cargo", "build", "--target", "aarch64-apple-darwin"]
            environment = {
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "CARGO_TARGET_DIR": str(root / "target"),
                "CARGO_TEST_LOG": str(log_path),
                "TAURI_PARALLEL_BUILD_ID": "test-run",
            }
            with patch.dict(os.environ, environment, clear=False), patch.object(sys, "argv", args):
                self.assertEqual(runner.main(), 0)
                self.assertEqual(runner.main(), 0)

            self.assertEqual(
                sorted(log_path.read_text().splitlines()),
                sorted(runner.ARCHITECTURES),
            )
            marker = root / "target/.parallel-universal/test-run.json"
            self.assertEqual(json.loads(marker.read_text())["binaryNames"], ["codex-harness"])

    def test_replaces_both_supported_target_argument_forms(self):
        self.assertEqual(
            runner.replace_target(["build", "--target", "aarch64-apple-darwin"], "x86_64-apple-darwin"),
            ["build", "--target", "x86_64-apple-darwin"],
        )
        self.assertEqual(
            runner.replace_target(["build", "--target=aarch64-apple-darwin"], "x86_64-apple-darwin"),
            ["build", "--target=x86_64-apple-darwin"],
        )

    def test_copies_each_architecture_binary_to_tauri_target_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "target"
            cwd = Path(directory)
            for target in runner.ARCHITECTURES:
                source = runner.architecture_target_dir(base, target) / target / "release" / "codex-harness"
                source.parent.mkdir(parents=True)
                source.write_bytes(target.encode())

            runner.copy_binaries(cwd, base, ["codex-harness"])

            for target in runner.ARCHITECTURES:
                output = base / target / "release" / "codex-harness"
                self.assertEqual(output.read_bytes(), target.encode())


if __name__ == "__main__":
    unittest.main()
