#!/usr/bin/env python3
"""Build the two macOS architectures concurrently for Tauri universal builds."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


ARCHITECTURES = ("aarch64-apple-darwin", "x86_64-apple-darwin")


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log_event(event: str, **fields: object) -> None:
    record = {"timestamp": timestamp(), "event": event, **fields}
    print(json.dumps(record, ensure_ascii=False, sort_keys=True), flush=True)


def target_from_args(args: list[str]) -> str | None:
    for index, argument in enumerate(args):
        if argument == "--target" and index + 1 < len(args):
            return args[index + 1]
        if argument.startswith("--target="):
            return argument.partition("=")[2]
    return None


def replace_target(args: list[str], target: str) -> list[str]:
    result = list(args)
    for index, argument in enumerate(result):
        if argument == "--target" and index + 1 < len(result):
            result[index + 1] = target
            return result
        if argument.startswith("--target="):
            result[index] = f"--target={target}"
            return result
    raise RuntimeError("Tauri did not pass a target to the Cargo runner")


def cargo_target_dir(cwd: Path) -> Path:
    configured = os.environ.get("CARGO_TARGET_DIR")
    if not configured:
        return cwd / "target"
    path = Path(configured).expanduser()
    return path if path.is_absolute() else cwd / path


def architecture_target_dir(base: Path, target: str) -> Path:
    return base / "parallel-architectures" / target


def binary_names(cwd: Path, env: dict[str, str]) -> list[str]:
    result = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        cwd=cwd,
        env=env,
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"cargo metadata failed ({result.returncode}): {detail}")
    metadata = json.loads(result.stdout)
    names = {
        target["name"]
        for package in metadata.get("packages", [])
        for target in package.get("targets", [])
        if "bin" in target.get("kind", [])
    }
    if not names:
        raise RuntimeError("Cargo package has no binary target")
    return sorted(names)


def relay_output(target: str, stream) -> None:
    for line in iter(stream.readline, ""):
        print(f"[{target}] {line}", end="", flush=True)
    stream.close()


def build_architectures(args: list[str], cwd: Path, base: Path) -> None:
    processes: list[tuple[str, subprocess.Popen[str]]] = []
    output_threads: list[threading.Thread] = []
    for target in ARCHITECTURES:
        env = os.environ.copy()
        env["CARGO_TARGET_DIR"] = str(architecture_target_dir(base, target))
        command = ["cargo", *replace_target(args, target)]
        log_event("architecture-build.started", command=command, target=target)
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        processes.append((target, process))
        assert process.stdout is not None
        output_thread = threading.Thread(target=relay_output, args=(target, process.stdout), daemon=True)
        output_thread.start()
        output_threads.append(output_thread)

    failures: list[tuple[str, int]] = []
    for target, process in processes:
        return_code = process.wait()
        log_event("architecture-build.finished", returnCode=return_code, target=target)
        if return_code != 0:
            failures.append((target, return_code))
    for output_thread in output_threads:
        output_thread.join()
    if failures:
        detail = ", ".join(f"{target}={return_code}" for target, return_code in failures)
        raise RuntimeError(f"parallel architecture build failed: {detail}")


def copy_binaries(cwd: Path, base: Path, names: list[str]) -> None:
    for target in ARCHITECTURES:
        source_dir = architecture_target_dir(base, target) / target / "release"
        destination_dir = base / target / "release"
        destination_dir.mkdir(parents=True, exist_ok=True)
        for name in names:
            source = source_dir / name
            destination = destination_dir / name
            if not source.is_file():
                raise RuntimeError(f"Cargo did not produce {source}")
            shutil.copy2(source, destination)


def marker_path(base: Path, build_id: str) -> Path:
    return base / ".parallel-universal" / f"{build_id}.json"


def main() -> int:
    args = sys.argv[1:]
    target = target_from_args(args)
    if target not in ARCHITECTURES:
        return subprocess.call(["cargo", *args])

    build_id = os.environ.get("TAURI_PARALLEL_BUILD_ID")
    if not build_id:
        raise RuntimeError("TAURI_PARALLEL_BUILD_ID is required for a universal build")
    cwd = Path.cwd()
    base = cargo_target_dir(cwd)
    marker = marker_path(base, build_id)
    if marker.is_file():
        log_event("architecture-build.reused", buildId=build_id, target=target)
        return 0

    env = os.environ.copy()
    names = binary_names(cwd, env)
    started = time.monotonic()
    log_event(
        "universal-architecture-build.started",
        buildId=build_id,
        targets=ARCHITECTURES,
        targetDir=str(base),
    )
    build_architectures(args, cwd, base)
    copy_binaries(cwd, base, names)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"binaryNames": names}) + "\n")
    log_event(
        "universal-architecture-build.finished",
        buildId=build_id,
        durationMs=round((time.monotonic() - started) * 1000),
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log_event("universal-architecture-build.failed", error=str(error))
        raise
