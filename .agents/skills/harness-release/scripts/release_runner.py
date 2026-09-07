#!/usr/bin/env python3
"""Run the complete Codex Harness GitHub release as a detached job."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


PHASES = (
    ("prepare", "preparing"),
    ("check", "checking"),
    ("submit", "submitting"),
    ("publish", "publishing"),
)


def now_ms() -> int:
    return int(time.time() * 1000)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log_event(event: str, **fields: object) -> None:
    record = {"timestamp": timestamp(), "event": event, **fields}
    print(json.dumps(record, ensure_ascii=False, sort_keys=True), flush=True)


def write_state(path: Path, state: dict[str, object]) -> None:
    state["updatedAt"] = now_ms()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def run(*args: str, cwd: Path) -> None:
    started = time.monotonic()
    command = shlex.join(args)
    log_event("command.started", command=command, cwd=str(cwd))
    try:
        result = subprocess.run(args, cwd=cwd, check=False)
    except OSError as error:
        log_event(
            "command.finished",
            command=command,
            cwd=str(cwd),
            durationMs=round((time.monotonic() - started) * 1000),
            outcome="failed",
            error=str(error),
        )
        raise
    duration_ms = round((time.monotonic() - started) * 1000)
    log_event(
        "command.finished",
        command=command,
        cwd=str(cwd),
        durationMs=duration_ms,
        outcome="succeeded" if result.returncode == 0 else "failed",
        returnCode=result.returncode,
    )
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, args)


def finish_phase(state: dict[str, object]) -> None:
    phase = state.get("phase")
    phase_started_at = state.get("phaseStartedAt")
    if not isinstance(phase, str) or not isinstance(phase_started_at, int):
        return
    duration_ms = max(0, now_ms() - phase_started_at)
    durations = state.setdefault("phaseDurations", {})
    if isinstance(durations, dict):
        durations[phase] = duration_ms
    state["phaseDurationMs"] = duration_ms
    log_event("phase.finished", phase=phase, durationMs=duration_ms)


def set_phase(state: dict[str, object], state_path: Path, phase: str) -> None:
    if state.get("phase") != phase:
        finish_phase(state)
    started_at = now_ms()
    state.update(
        {
            "phase": phase,
            "phaseStartedAt": started_at,
            "phaseDurationMs": None,
            "step": None,
            "stepStartedAt": None,
            "stepDurationMs": None,
        }
    )
    write_state(state_path, state)
    log_event("phase.started", phase=phase)


def run_step(state: dict[str, object], state_path: Path, *args: str, cwd: Path) -> None:
    state.update(
        {
            "step": shlex.join(args),
            "stepStartedAt": now_ms(),
            "stepDurationMs": None,
        }
    )
    write_state(state_path, state)
    started = time.monotonic()
    try:
        run(*args, cwd=cwd)
    finally:
        state["stepDurationMs"] = round((time.monotonic() - started) * 1000)
        write_state(state_path, state)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--base-sha", required=True)
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
        "baseSha": args.base_sha,
        "phaseStartedAt": now_ms(),
        "phaseDurationMs": None,
        "phaseDurations": {},
        "step": None,
        "stepStartedAt": None,
        "stepDurationMs": None,
    }
    write_state(state_path, state)
    try:
        set_phase(state, state_path, "preparing-worktree")
        run_step(
            state,
            state_path,
            "git",
            "worktree",
            "add",
            "--detach",
            str(worktree),
            args.base_sha,
            cwd=workspace,
        )
        release_script = worktree / ".agents/skills/harness-release/scripts/release.py"
        if not release_script.is_file():
            raise RuntimeError(f"release script is missing from origin/main: {release_script}")

        for command, phase in PHASES:
            set_phase(state, state_path, phase)
            release_args = [sys.executable, str(release_script), command, args.version]
            if command == "prepare":
                release_args.extend(["--base-sha", args.base_sha])
            run_step(state, state_path, *release_args, cwd=worktree)

        finish_phase(state)
        state.update({"status": "succeeded", "phase": "completed", "completedAt": now_ms()})
        write_state(state_path, state)
        log_event("release.finished", outcome="succeeded", version=args.version)
        return 0
    except Exception as error:
        finish_phase(state)
        state.update(
            {
                "status": "failed",
                "error": str(error),
                "completedAt": now_ms(),
            }
        )
        write_state(state_path, state)
        log_event("release.finished", error=str(error), outcome="failed", version=args.version)
        print(f"release runner failed: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
