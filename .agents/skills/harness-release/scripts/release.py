#!/usr/bin/env python3
"""Deterministic release phases for Codex Harness."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - release publishing only runs on macOS
    fcntl = None


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[4]
DEFAULT_CARGO_TARGET_DIR = Path.home() / ".codex-harness/release-cache/cargo-target"
UNIVERSAL_TARGET = "universal-apple-darwin"
PARALLEL_CARGO_RUNNER = SCRIPT_PATH.with_name("parallel_cargo_runner.py")
VERSION_FILES = (
    Path("package.json"),
    Path("src-tauri/Cargo.toml"),
    Path("src-tauri/Cargo.lock"),
    Path("src-tauri/tauri.conf.json"),
)
REMOTE_ASSET_VERIFY_RETRIES = 6
REMOTE_ASSET_VERIFY_INITIAL_WAIT_SECONDS = 1
MAIN_CHECK_ATTEMPTS = 73
MAIN_CHECK_WAIT_SECONDS = 10

ASSET_DIGEST_PENDING_MESSAGE = (
    "GitHub 仍在生成发布文件的校验摘要，暂时无法完成回读确认。"
    "发布产物已上传成功，稍后可打开 GitHub Release 页面查看。"
)


class ReleaseError(RuntimeError):
    pass


def now_ms() -> int:
    return int(time.time() * 1000)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log_event(event: str, **fields: object) -> None:
    record = {"timestamp": timestamp(), "event": event, **fields}
    print(json.dumps(record, ensure_ascii=False, sort_keys=True), flush=True)


def run(*args: str, cwd: Path = REPO_ROOT, capture: bool = False) -> str:
    started = time.monotonic()
    command = shlex.join(args)
    log_event("command.started", command=command, cwd=str(cwd))
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            check=False,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except OSError as error:
        log_event(
            "command.finished",
            command=command,
            cwd=str(cwd),
            durationMs=round((time.monotonic() - started) * 1000),
            outcome="failed",
            error=str(error),
        )
        raise ReleaseError(f"command failed to start: {command}\n{error}") from error
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
        detail = (result.stderr or result.stdout or "").strip()
        raise ReleaseError(f"command failed ({result.returncode}): {' '.join(args)}\n{detail}")
    return (result.stdout or "").rstrip()


def cargo_target_dir(root: Path = REPO_ROOT) -> Path:
    configured = os.environ.get("CARGO_TARGET_DIR")
    if configured:
        path = Path(configured).expanduser()
        return path if path.is_absolute() else root / path
    return DEFAULT_CARGO_TARGET_DIR


def configure_release_environment() -> Path:
    target_dir = cargo_target_dir()
    os.environ["CARGO_TARGET_DIR"] = str(target_dir)
    log_event("build.environment", cargoTargetDir=str(target_dir))
    return target_dir


@contextmanager
def cargo_target_lock():
    target_dir = configure_release_environment()
    target_dir.mkdir(parents=True, exist_ok=True)
    lock_path = target_dir / ".release.lock"
    with lock_path.open("w") as lock:
        if fcntl is not None:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def application_path(root: Path = REPO_ROOT) -> Path:
    return cargo_target_dir(root) / UNIVERSAL_TARGET / "release" / "bundle" / "macos" / "Codex Harness.app"


def try_run(*args: str, cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, check=False, text=True, capture_output=True)


def _prepend_path(directory: Path) -> None:
    resolved = str(directory)
    entries = os.environ.get("PATH", "").split(os.pathsep)
    if resolved not in entries:
        os.environ["PATH"] = os.pathsep.join([resolved, *entries])


def _nvm_bin_dirs(home: Path) -> list[Path]:
    versions_dir = home / ".nvm/versions/node"
    if not versions_dir.is_dir():
        return []
    return [bin_dir for version in sorted(versions_dir.iterdir()) if (bin_dir := version / "bin").is_dir()]


def bootstrap_tool_path() -> None:
    # The release runner spawns release.py without an interactive shell, so PATH
    # misses toolchain dirs that only shell rc files add (nvm, cargo). Top up PATH
    # with well-known locations so `pnpm`/`cargo` resolve without manual symlinks.
    home = Path.home()
    candidates = [
        home / ".cargo/bin",
        home / ".volta/bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        *_nvm_bin_dirs(home),
    ]
    needed = [tool for tool in ("pnpm", "cargo") if shutil.which(tool) is None]
    for directory in candidates:
        if not needed:
            break
        if not directory.is_dir():
            continue
        _prepend_path(directory)
        needed = [tool for tool in needed if shutil.which(tool) is None]


def parse_version(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value)
    if not match:
        raise ReleaseError(f"invalid stable SemVer: {value}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def normalized_version(value: str) -> str:
    major, minor, patch = parse_version(value)
    return f"{major}.{minor}.{patch}"


def json_version(path: Path) -> str:
    return str(json.loads(path.read_text())["version"])


def current_version(root: Path = REPO_ROOT) -> str:
    return json_version(root / "package.json")


def origin_main_version(ref: str = "origin/main") -> str:
    package = json.loads(run("git", "show", f"{ref}:package.json", capture=True))
    return str(package["version"])


def replace_first(pattern: str, replacement: str, text: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ReleaseError(f"could not update {label}")
    return updated


def update_version_files(root: Path, version: str) -> None:
    version = normalized_version(version)
    for relative in (Path("package.json"), Path("src-tauri/tauri.conf.json")):
        path = root / relative
        data = json.loads(path.read_text())
        data["version"] = version
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    cargo_toml = root / "src-tauri/Cargo.toml"
    cargo_toml.write_text(
        replace_first(
            r'^(version\s*=\s*)"[^"]+"',
            rf'\g<1>"{version}"',
            cargo_toml.read_text(),
            "src-tauri/Cargo.toml package version",
        )
    )

    cargo_lock = root / "src-tauri/Cargo.lock"
    cargo_lock.write_text(
        replace_first(
            r'(^\[\[package\]\]\nname = "codex-harness"\nversion = )"[^"]+"',
            rf'\g<1>"{version}"',
            cargo_lock.read_text(),
            "src-tauri/Cargo.lock codex-harness version",
        )
    )


def require_clean_worktree() -> None:
    if run("git", "status", "--porcelain", capture=True):
        raise ReleaseError("worktree is not clean")


def require_synced_versions(version: str) -> None:
    expected = normalized_version(version)
    versions = {
        "package.json": json_version(REPO_ROOT / "package.json"),
        "src-tauri/tauri.conf.json": json_version(REPO_ROOT / "src-tauri/tauri.conf.json"),
    }
    for relative in ("src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
        text = (REPO_ROOT / relative).read_text()
        if relative.endswith("Cargo.toml"):
            match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        else:
            match = re.search(
                r'^\[\[package\]\]\nname = "codex-harness"\nversion = "([^"]+)"',
                text,
                re.MULTILINE,
            )
        versions[relative] = match.group(1) if match else "missing"
    mismatched = {path: value for path, value in versions.items() if value != expected}
    if mismatched:
        raise ReleaseError(f"version sources are not synchronized at {expected}: {mismatched}")


def command_prepare(version: str, base_sha: str | None = None) -> None:
    version = normalized_version(version)
    require_clean_worktree()
    if base_sha is None:
        run("git", "fetch", "origin", "--prune", "--tags")
        base_sha = run("git", "rev-parse", "origin/main", capture=True)
    else:
        resolved_sha = run("git", "rev-parse", f"{base_sha}^{{commit}}", capture=True)
        head_sha = run("git", "rev-parse", "HEAD", capture=True)
        if resolved_sha != base_sha or head_sha != base_sha:
            raise ReleaseError(f"release worktree is not at fetched base commit {base_sha}")
    base_version = origin_main_version(base_sha)
    if parse_version(version) < parse_version(base_version):
        raise ReleaseError(f"release version {version} must not be older than origin/main {base_version}")
    if version == base_version:
        require_matching_release_tag(version, base_sha)
        run("git", "switch", "--detach", base_sha)
        require_synced_versions(version)
        print(json.dumps({"phase": "prepared", "version": version, "resumed": True, "commit": base_sha}))
        return
    tag = f"v{version}"
    if try_run("git", "rev-parse", "--verify", tag).returncode == 0:
        raise ReleaseError(f"local tag already exists: {tag}")
    if run("git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}", capture=True):
        raise ReleaseError(f"remote tag already exists: {tag}")
    branch = f"release/{tag}"
    if try_run("git", "show-ref", "--verify", f"refs/heads/{branch}").returncode == 0:
        raise ReleaseError(f"local branch already exists: {branch}")
    if run("git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}", capture=True):
        raise ReleaseError(f"remote branch already exists: {branch}")
    run("git", "switch", "--create", branch, base_sha)
    update_version_files(REPO_ROOT, version)
    require_synced_versions(version)
    print(json.dumps({"phase": "prepared", "version": version, "branch": branch}))


def ensure_dependencies() -> None:
    if not (REPO_ROOT / "node_modules").exists():
        run("pnpm", "install", "--frozen-lockfile")


def command_check(version: str) -> None:
    configure_release_environment()
    require_synced_versions(version)
    ensure_dependencies()
    with cargo_target_lock():
        run("cargo", "test", cwd=REPO_ROOT / "src-tauri")
    print(json.dumps({"phase": "checked", "version": normalized_version(version)}))


def wait_for_required_checks(pr_url: str) -> None:
    for _ in range(24):
        result = try_run("gh", "pr", "checks", pr_url, "--required", "--json", "name,state")
        if result.returncode in (0, 8) and result.stdout.strip() not in ("", "[]"):
            break
        time.sleep(5)
    else:
        raise ReleaseError("required checks did not appear within 120 seconds")
    run(
        "gh",
        "pr",
        "checks",
        pr_url,
        "--required",
        "--watch",
        "--fail-fast",
        "--interval",
        "10",
    )


def wait_for_main_checks(head: str) -> None:
    for attempt in range(MAIN_CHECK_ATTEMPTS):
        checks = json.loads(run(
            "gh", "api", f"repos/{{owner}}/{{repo}}/commits/{head}/check-runs?per_page=100",
            capture=True,
        ))
        required = [item for item in checks["check_runs"] if item["name"] == "test-and-build"]
        latest = max(required, key=lambda item: item["id"]) if required else None
        if latest and latest["conclusion"] == "success":
            return
        if latest and latest["conclusion"] is not None:
            raise ReleaseError(f"origin/main {head} test-and-build failed: {latest['conclusion']}")
        if attempt + 1 < MAIN_CHECK_ATTEMPTS:
            print(f"waiting for origin/main {head} test-and-build; retrying in {MAIN_CHECK_WAIT_SECONDS}s", flush=True)
            time.sleep(MAIN_CHECK_WAIT_SECONDS)
    raise ReleaseError(f"timed out waiting for origin/main {head} test-and-build")


def command_submit(version: str) -> None:
    version = normalized_version(version)
    require_synced_versions(version)
    changed = set(filter(None, run("git", "status", "--porcelain", capture=True).splitlines()))
    changed_paths = {line[3:] for line in changed}
    if not changed_paths:
        head = run("git", "rev-parse", "HEAD", capture=True)
        run("git", "fetch", "origin", "main")
        if head != run("git", "rev-parse", "origin/main", capture=True):
            raise ReleaseError("same-version release must resume from origin/main")
        require_matching_release_tag(version, head)
        wait_for_main_checks(head)
        print(json.dumps({"phase": "submitted", "version": version, "resumed": True, "mergeCommit": head}))
        return
    expected = {str(path) for path in VERSION_FILES}
    if changed_paths != expected:
        raise ReleaseError(f"expected only synchronized version files, found: {sorted(changed_paths)}")
    run("git", "add", *(str(path) for path in VERSION_FILES))
    run("git", "diff", "--cached", "--check")
    run("git", "commit", "-m", f"release: v{version}")
    branch = run("git", "branch", "--show-current", capture=True)
    if branch != f"release/v{version}":
        raise ReleaseError(f"unexpected release branch: {branch}")
    run("git", "push", "--set-upstream", "origin", branch)
    body = (
        f"## Summary\n\n- Release Codex Harness v{version}.\n\n"
        "## Validation\n\n- `(cd src-tauri && cargo test)`\n"
        "- required `test-and-build` runs `pnpm test` and `pnpm build`\n"
    )
    pr_url = run(
        "gh",
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        f"release: v{version}",
        "--body",
        body,
        capture=True,
    )
    wait_for_required_checks(pr_url)
    head_sha = run("git", "rev-parse", "HEAD", capture=True)
    run("gh", "pr", "merge", pr_url, "--squash", "--match-head-commit", head_sha)
    details = json.loads(
        run("gh", "pr", "view", pr_url, "--json", "state,mergeCommit,url,number", capture=True)
    )
    if details.get("state") != "MERGED" or not details.get("mergeCommit", {}).get("oid"):
        raise ReleaseError(f"release PR was not merged: {details}")
    merge_sha = details["mergeCommit"]["oid"]
    run("git", "fetch", "origin", "main")
    if run("git", "rev-parse", "origin/main", capture=True) != merge_sha:
        raise ReleaseError("origin/main does not match the release PR merge commit")
    run("git", "switch", "--detach", merge_sha)
    print(
        json.dumps(
            {
                "phase": "submitted",
                "version": version,
                "pr": details["url"],
                "prNumber": details["number"],
                "mergeCommit": merge_sha,
            }
        )
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_app(app: Path, version: str) -> list[str]:
    info_path = app / "Contents/Info.plist"
    executable = app / "Contents/MacOS/codex-harness"
    if not info_path.exists() or not executable.exists():
        raise ReleaseError(f"invalid app bundle: {app}")
    with info_path.open("rb") as stream:
        info = plistlib.load(stream)
    if str(info.get("CFBundleShortVersionString")) != version:
        raise ReleaseError(f"app version mismatch: {info.get('CFBundleShortVersionString')}")
    run("codesign", "--verify", "--deep", "--strict", str(app))
    signature = try_run("codesign", "-dv", "--verbose=2", str(app))
    if signature.returncode != 0 or "Authority=Codex Harness Local Code Signing" not in signature.stderr:
        raise ReleaseError("app is not signed with Codex Harness Local Code Signing")
    archs = run("lipo", "-archs", str(executable), capture=True).split()
    if not {"arm64", "x86_64"}.issubset(archs):
        raise ReleaseError(f"app is not universal: {archs}")
    return archs


def find_processes(executable: Path):
    return try_run("pgrep", "-a", "-f", str(executable))


def install_app(app: Path, version: str) -> tuple[Path, Path | None]:
    applications = Path.home() / "Applications"
    applications.mkdir(parents=True, exist_ok=True)
    destination = applications / "Codex Harness.app"
    backup = None
    if destination.exists():
        executable = destination / "Contents/MacOS/codex-harness"
        running = find_processes(executable)
        if running.returncode == 0:
            for pid in running.stdout.split():
                run("kill", "-TERM", pid)
            for _ in range(15):
                if find_processes(executable).returncode != 0:
                    break
                time.sleep(1)
            else:
                raise ReleaseError("installed app did not stop within 15 seconds")
        backup = applications / f"Codex Harness.app.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        if backup.exists():
            raise ReleaseError(f"backup path already exists: {backup}")
        shutil.move(str(destination), str(backup))
    try:
        run("ditto", str(app), str(destination))
        verify_app(destination, version)
    except Exception:
        if destination.exists():
            shutil.rmtree(destination)
        if backup and backup.exists():
            shutil.move(str(backup), str(destination))
        raise
    run("open", str(destination))
    executable = destination / "Contents/MacOS/codex-harness"
    for _ in range(15):
        if find_processes(executable).returncode == 0:
            break
        time.sleep(1)
    else:
        raise ReleaseError("installed app process did not start within 15 seconds")
    return destination, backup


def tag_message(tag: str) -> str:
    previous = try_run("git", "describe", "--tags", "--abbrev=0", "HEAD^")
    revision = f"{previous.stdout.strip()}..HEAD" if previous.returncode == 0 else "HEAD"
    subjects = run("git", "log", "--format=%s", revision, capture=True).splitlines()
    bullets = "\n".join(f"- {subject}" for subject in subjects[:20])
    return f"Codex Harness {tag}\n\n{bullets}".rstrip()


def build_universal_app() -> None:
    if not PARALLEL_CARGO_RUNNER.is_file():
        raise ReleaseError(f"parallel Cargo runner is missing: {PARALLEL_CARGO_RUNNER}")
    build_id = f"{now_ms()}-{os.getpid()}"
    previous_build_id = os.environ.get("TAURI_PARALLEL_BUILD_ID")
    os.environ["TAURI_PARALLEL_BUILD_ID"] = build_id
    log_event(
        "universal-build.configured",
        buildId=build_id,
        cargoTargetDir=str(cargo_target_dir()),
        runner=str(PARALLEL_CARGO_RUNNER),
    )
    try:
        with cargo_target_lock():
            run(
                "pnpm",
                "tauri",
                "build",
                "--target",
                UNIVERSAL_TARGET,
                "--runner",
                str(PARALLEL_CARGO_RUNNER),
            )
    finally:
        if previous_build_id is None:
            os.environ.pop("TAURI_PARALLEL_BUILD_ID", None)
        else:
            os.environ["TAURI_PARALLEL_BUILD_ID"] = previous_build_id


def verify_remote_asset(tag: str, asset_name: str, checksum: str) -> dict[str, object]:
    expected_digest = f"sha256:{checksum}"
    details: dict[str, object] | None = None
    asset: dict[str, object] | None = None
    for attempt in range(REMOTE_ASSET_VERIFY_RETRIES + 1):
        details = json.loads(
            run("gh", "release", "view", tag, "--json", "url,tagName,assets", capture=True)
        )
        asset = next((item for item in details["assets"] if item["name"] == asset_name), None)
        if asset and asset.get("digest") == expected_digest:
            return details
        if attempt < REMOTE_ASSET_VERIFY_RETRIES:
            delay = REMOTE_ASSET_VERIFY_INITIAL_WAIT_SECONDS * (2**attempt)
            print(
                f"remote release asset verification incomplete; retrying in {delay}s",
                flush=True,
            )
            time.sleep(delay)
    if asset and not asset.get("digest"):
        raise ReleaseError(ASSET_DIGEST_PENDING_MESSAGE)
    raise ReleaseError(f"remote release asset verification failed: {asset}")


def require_matching_release_tag(version: str, head: str) -> bool:
    tag = f"v{version}"
    if try_run("git", "rev-parse", "--verify", f"refs/tags/{tag}").returncode == 0:
        peeled = run("git", "rev-parse", f"refs/tags/{tag}^{{}}", capture=True)
        if peeled != head:
            raise ReleaseError(f"existing tag {tag} points to {peeled}, expected {head}; choose a newer version")
    remote = run("git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}", capture=True)
    refs = dict(line.split()[::-1] for line in remote.splitlines())
    if refs and refs.get(f"refs/tags/{tag}^{{}}") != head:
        raise ReleaseError(f"remote tag {tag} does not peel to {head}; choose a newer version")
    return bool(refs)


def restore_published_app(version: str, head: str, details: dict[str, object]) -> None:
    tag = f"v{version}"
    asset_name = f"Codex-Harness-v{version}-macos-universal.zip"
    if not any(item["name"] == asset_name for item in details["assets"]):
        raise ReleaseError(f"existing release {tag} is missing {asset_name}; restore the original asset before retrying")
    with tempfile.TemporaryDirectory(prefix="harness-release-restore-") as directory:
        root = Path(directory)
        run("gh", "release", "download", tag, "--pattern", asset_name, "--dir", directory)
        archive = root / asset_name
        checksum = sha256(archive)
        try:
            details = verify_remote_asset(tag, asset_name, checksum)
        except ReleaseError as error:
            if str(error) == ASSET_DIGEST_PENDING_MESSAGE:
                raise ReleaseError("existing asset digest is still pending; retry restoration later") from error
            raise
        run("ditto", "-x", "-k", str(archive), directory)
        app = root / "Codex Harness.app"
        verify_app(app, version)
        destination, backup = install_app(app, version)
        print(json.dumps({
            "phase": "published", "version": version, "commit": head, "tag": tag,
            "release": details["url"], "sha256": checksum, "resumed": True,
            "installed": str(destination), "backup": str(backup) if backup else None,
        }))


def command_publish(version: str, github: bool = True) -> None:
    version = normalized_version(version)
    if sys.platform != "darwin":
        raise ReleaseError("publishing Codex Harness requires macOS")
    configure_release_environment()
    require_clean_worktree()
    run("git", "fetch", "origin", "main", "--tags")
    head = run("git", "rev-parse", "HEAD", capture=True)
    if head != run("git", "rev-parse", "origin/main", capture=True):
        raise ReleaseError("publish must run from the merged origin/main commit")
    require_synced_versions(version)
    tag = f"v{version}"
    remote_tag_exists = require_matching_release_tag(version, head)
    if github:
        # Listing must succeed: authentication/network errors are not an absent release.
        releases = json.loads(run("gh", "api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases", capture=True))
        existing = next((item for page in releases for item in page if item["tag_name"] == tag), None)
        if existing:
            if not remote_tag_exists:
                raise ReleaseError(f"existing release {tag} has no matching remote tag")
            if existing["draft"]:
                raise ReleaseError(f"existing release {tag} is a draft; finish or remove the draft before retrying")
            details = json.loads(run("gh", "release", "view", tag, "--json", "url,tagName,assets", capture=True))
            restore_published_app(version, head, details)
            return

    ensure_dependencies()
    build_universal_app()
    app = application_path()
    archs = verify_app(app, version)
    zip_path = app.parent / f"Codex-Harness-v{version}-macos-universal.zip"
    if zip_path.exists():
        zip_path.unlink()
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(zip_path))
    checksum = sha256(zip_path)
    destination, backup = install_app(app, version)

    if try_run("git", "rev-parse", "--verify", tag).returncode != 0:
        run("git", "tag", "--annotate", tag, "--message", tag_message(tag))
    details = None
    if github:
        remote_tag = run("git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}", capture=True)
        if not remote_tag:
            run("git", "push", "origin", f"refs/tags/{tag}")
        peeled_remote_tag = run(
            "git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}^{{}}", capture=True
        ).split()
        if not peeled_remote_tag or peeled_remote_tag[0] != head:
            raise ReleaseError(f"remote tag {tag} does not peel to {head}")
        release = try_run("gh", "release", "view", tag, "--json", "url,tagName,assets")
    else:
        release = None
    notes = (
        "## Install\n\n"
        f"Download `{zip_path.name}`, unzip it, and move `Codex Harness.app` to `~/Applications`.\n\n"
        "## Build and verification\n\n"
        f"- Built from `{head}`.\n"
        f"- App bundle version: `{version}`.\n"
        f"- Architectures: `{', '.join(archs)}`.\n"
        "- Code signature and installed process verified.\n\n"
        "## SHA-256\n\n"
        f"`{checksum}`  `{zip_path.name}`"
    )
    if github and release and release.returncode != 0:
        run(
            "gh",
            "release",
            "create",
            tag,
            str(zip_path),
            "--verify-tag",
            "--title",
            f"Codex Harness {tag}",
            "--generate-notes",
            "--notes",
            notes,
        )
    if github:
        details = verify_remote_asset(tag, zip_path.name, checksum)
    print(
        json.dumps(
            {
                "phase": "published" if github else "installed",
                "version": version,
                "commit": head,
                "tag": tag,
                "release": details["url"] if details else None,
                "asset": str(zip_path),
                "sha256": checksum,
                "installed": str(destination),
                "backup": str(backup) if backup else None,
            }
        )
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subcommands = result.add_subparsers(dest="command", required=True)
    for name in ("prepare", "check", "submit", "publish"):
        command = subcommands.add_parser(name)
        command.add_argument("version", help="stable SemVer, for example 0.7.6")
        if name == "prepare":
            command.add_argument(
                "--base-sha",
                help="fetched origin/main commit used by the release runner",
            )
        if name == "publish":
            command.add_argument(
                "--local",
                action="store_true",
                help="install and create only a local tag; do not publish to GitHub",
            )
    return result


def main() -> int:
    args = parser().parse_args()
    bootstrap_tool_path()
    try:
        if args.command == "publish":
            command_publish(args.version, github=not args.local)
        elif args.command == "prepare":
            command_prepare(args.version, args.base_sha)
        else:
            {
                "check": command_check,
                "submit": command_submit,
            }[args.command](args.version)
    except ReleaseError as error:
        print(f"release failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
