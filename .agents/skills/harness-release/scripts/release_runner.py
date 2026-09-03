#!/usr/bin/env python3
"""Run the complete Codex Harness GitHub release as a detached job."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


PHASES = (
    ("prepare", "preparing"),
    ("check", "checking"),
    ("submit", "submitting"),
    ("publish", "publishing"),
)


def now_ms() -> int:
    return int(time.time() * 1000)


def write_state(path: Path, state: dict[str, object]) -> None:
    state["updatedAt"] = now_ms()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def run(*args: str, cwd: Path) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, cwd=cwd, check=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--version", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    os.environ.setdefault("GIT_TERMINAL_PROMPT", "0")
    os.environ.setdefault("GH_PROMPT_DISABLED", "1")
    workspace = Path(args.workspace).resolve()
    worktree = Path(args.worktree)
    state_path = Path(args.state)
    state: dict[str, object] = {
        "runId": args.run_id,
        "workspaceRoot": str(workspace),
        "version": args.version,
        "status": "running",
        "phase": "starting",
        "error": None,
        "pid": os.getpid(),
        "startedAt": now_ms(),
        "updatedAt": now_ms(),
        "completedAt": None,
        "dismissed": False,
    }
    write_state(state_path, state)
    try:
        state["phase"] = "preparing-worktree"
        write_state(state_path, state)
        run("git", "fetch", "origin", "--prune", "--tags", cwd=workspace)
        run("git", "worktree", "add", "--detach", str(worktree), "origin/main", cwd=workspace)
        release_script = worktree / ".agents/skills/harness-release/scripts/release.py"
        if not release_script.is_file():
            raise RuntimeError(f"release script is missing from origin/main: {release_script}")

        for command, phase in PHASES:
            state["phase"] = phase
            write_state(state_path, state)
            run(sys.executable, str(release_script), command, args.version, cwd=worktree)

        state.update({"status": "succeeded", "phase": "completed", "completedAt": now_ms()})
        write_state(state_path, state)
        return 0
    except Exception as error:
        state.update(
            {
                "status": "failed",
                "error": str(error),
                "completedAt": now_ms(),
            }
        )
        write_state(state_path, state)
        print(f"release runner failed: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
