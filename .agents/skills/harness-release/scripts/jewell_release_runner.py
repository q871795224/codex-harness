#!/usr/bin/env python3
"""Publish a signed Jewell APK to the Jewell GitHub Release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path


REPOSITORY = "q871795224/jewell"
EXPECTED_REMOTE = "github.com/q871795224/jewell"
TARGET_BRANCH = "master"
VERSION_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


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


def command(*args: str, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    rendered = shlex.join(args)
    log_event("command.started", command=rendered, cwd=str(cwd))
    try:
        result = subprocess.run(args, cwd=cwd, check=False, capture_output=True, text=True, env=env)
    except OSError as error:
        log_event(
            "command.finished",
            command=rendered,
            cwd=str(cwd),
            durationMs=round((time.monotonic() - started) * 1000),
            outcome="failed",
            error=str(error),
        )
        raise
    if result.stdout:
        print(result.stdout, end="", flush=True)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr, flush=True)
    log_event(
        "command.finished",
        command=rendered,
        cwd=str(cwd),
        durationMs=round((time.monotonic() - started) * 1000),
        outcome="succeeded" if result.returncode == 0 else "failed",
        returnCode=result.returncode,
    )
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, args, output=result.stdout, stderr=result.stderr)
    return result


def capture(
    *args: str,
    cwd: Path,
    env: dict[str, str] | None = None,
    allow_failure: bool = False,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=cwd, check=False, capture_output=True, text=True, env=env)
    if not allow_failure and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, args, output=result.stdout, stderr=result.stderr)
    return result


def git(cwd: Path, *args: str) -> str:
    return capture("git", *args, cwd=cwd).stdout.strip()


def github_release(cwd: Path, tag: str) -> dict[str, object] | None:
    result = capture(
        "gh",
        "api",
        "--paginate",
        "--slurp",
        f"repos/{REPOSITORY}/releases",
        cwd=cwd,
    )
    try:
        pages = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"GitHub Release 列表响应无效：{error}") from error
    if not isinstance(pages, list):
        raise RuntimeError("GitHub Release 列表响应无效")
    for page in pages:
        if not isinstance(page, list):
            raise RuntimeError("GitHub Release 列表响应无效")
        for release in page:
            if isinstance(release, dict) and release.get("tag_name") == tag:
                return release
    return None


def set_phase(state: dict[str, object], state_path: Path, phase: str) -> None:
    previous = state.get("phase")
    previous_started = state.get("phaseStartedAt")
    if isinstance(previous, str) and isinstance(previous_started, int):
        duration = max(0, now_ms() - previous_started)
        durations = state.setdefault("phaseDurations", {})
        if isinstance(durations, dict):
            durations[previous] = duration
        state["phaseDurationMs"] = duration
        log_event("phase.finished", phase=previous, durationMs=duration)
    state.update(
        {
            "phase": phase,
            "phaseStartedAt": now_ms(),
            "phaseDurationMs": None,
            "step": None,
            "stepStartedAt": None,
            "stepDurationMs": None,
        }
    )
    write_state(state_path, state)
    log_event("phase.started", phase=phase)


def run_step(
    state: dict[str, object],
    state_path: Path,
    *args: str,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    state.update({"step": shlex.join(args), "stepStartedAt": now_ms(), "stepDurationMs": None})
    write_state(state_path, state)
    started = time.monotonic()
    try:
        return command(*args, cwd=cwd, env=env)
    finally:
        state["stepDurationMs"] = round((time.monotonic() - started) * 1000)
        write_state(state_path, state)


def release_versions(current: str) -> tuple[str, str]:
    match = VERSION_PATTERN.fullmatch(current)
    if not match:
        raise RuntimeError(f"master 上的版本不是稳定 SemVer：{current}")
    major, minor, patch = (int(value) for value in match.groups())
    return f"{major}.{minor}.{patch + 1}", f"{major}.{minor + 1}.0"


def version_tuple(version: str) -> tuple[int, int, int]:
    match = VERSION_PATTERN.fullmatch(version)
    if not match:
        raise RuntimeError(f"不是稳定 SemVer：{version}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def package_version(raw: str, label: str) -> str:
    try:
        package = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{label} package.json 无效：{error}") from error
    if package.get("name") != "jewell":
        raise RuntimeError(f"{label} 不是 Jewell 仓库")
    version = package.get("version")
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise RuntimeError(f"{label} package.json 缺少稳定 SemVer version")
    return version


def normalized_remote(remote: str) -> str:
    value = remote.strip().rstrip("/")
    if value.endswith(".git"):
        value = value[:-4]
    for prefix in ("https://", "http://", "ssh://git@", "git@"):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    return value.replace(":", "/", 1)


def prepend_path(directory: Path) -> None:
    resolved = str(directory)
    entries = os.environ.get("PATH", "").split(os.pathsep)
    if resolved not in entries:
        os.environ["PATH"] = os.pathsep.join([resolved, *entries])


def nvm_bin_dirs(home: Path) -> list[Path]:
    versions_dir = home / ".nvm/versions/node"
    if not versions_dir.is_dir():
        return []
    return [
        bin_dir
        for version in sorted(versions_dir.iterdir())
        if (bin_dir := version / "bin").is_dir()
    ]


def bootstrap_tool_path() -> None:
    home = Path.home()
    candidates = [
        home / ".cargo/bin",
        home / ".volta/bin",
        home / ".local/bin",
        home / ".npm-global/bin",
        home / ".asdf/shims",
        home / ".local/share/mise/shims",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        *nvm_bin_dirs(home),
    ]
    needed = [tool for tool in ("gh", "npm", "node") if shutil.which(tool) is None]
    for directory in candidates:
        if not needed:
            break
        if not directory.is_dir():
            continue
        prepend_path(directory)
        needed = [tool for tool in needed if shutil.which(tool) is None]


def validate_workspace(workspace: Path, version: str, base_sha: str, resume: bool) -> str:
    if normalized_remote(git(workspace, "remote", "get-url", "origin")) != EXPECTED_REMOTE:
        raise RuntimeError("当前 origin 不是 Jewell GitHub 仓库")
    if git(workspace, "status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError("Jewell 工作区有未提交改动；请先提交或暂存完毕，再启动发布")
    branch = git(workspace, "branch", "--show-current")
    if not branch:
        raise RuntimeError("当前 checkout 未关联分支，无法合并到 master")
    run("git", "fetch", "origin", "--prune", "--tags", cwd=workspace)
    current_base_sha = git(workspace, "rev-parse", f"origin/{TARGET_BRANCH}")
    if current_base_sha != base_sha:
        raise RuntimeError("origin/master 已更新，请重新打开发布菜单并刷新版本")
    current_version = package_version(git(workspace, "show", f"{base_sha}:package.json"), "origin/master")
    if resume and version != current_version:
        raise RuntimeError("只能恢复 origin/master 当前版本对应的失败发布")
    if not resume and version not in release_versions(current_version):
        raise RuntimeError(f"{version} 不是 Jewell {current_version} 的可选发布版本")
    tag = f"v{version}"
    if resume:
        remote_tag = capture(
            "git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}",
            cwd=workspace, allow_failure=True,
        )
        if remote_tag.returncode != 0 or not remote_tag.stdout.strip():
            raise RuntimeError(f"无法在 GitHub 找到失败发布的 tag {tag}")
        tagged_commit = git(workspace, "rev-parse", f"refs/tags/{tag}^{{}}")
        if tagged_commit != current_base_sha:
            raise RuntimeError(f"GitHub tag {tag} 与 origin/master 不一致，停止恢复")
    source_sha = git(workspace, "rev-parse", "HEAD")
    source_version = package_version(git(workspace, "show", f"{source_sha}:package.json"), "当前分支")
    if not resume and version_tuple(source_version) > version_tuple(version):
        raise RuntimeError(
            f"当前分支版本 {source_version} 高于所选发布版本 {version}，请刷新版本后重试"
        )
    if not resume:
        local_tag = capture(
            "git", "show-ref", "--verify", "--quiet", f"refs/tags/{tag}",
            cwd=workspace, allow_failure=True,
        )
        if local_tag.returncode == 0:
            raise RuntimeError(f"本机已存在 tag {tag}，请先核对之前的发布记录")
        remote_tag = capture(
            "git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}",
            cwd=workspace, allow_failure=True,
        )
        if remote_tag.returncode != 0:
            raise RuntimeError(f"无法查询 GitHub tag {tag}：{remote_tag.stderr.strip()}")
        if remote_tag.stdout.strip():
            raise RuntimeError(f"GitHub 已存在 tag {tag}，请先核对之前的发布记录")
    for required in ("gh", "npm", "node"):
        if shutil.which(required) is None:
            raise RuntimeError(f"找不到 {required}，请检查 Harness 启动环境的 PATH")
    auth = capture("gh", "auth", "status", "--hostname", "github.com", cwd=workspace, allow_failure=True)
    if auth.returncode != 0:
        raise RuntimeError("GitHub CLI 尚未登录；请先运行 gh auth login")
    release = github_release(workspace, tag)
    if release is not None and not resume:
        raise RuntimeError(f"GitHub 已存在 release {tag}，请先核对之前的发布记录")
    android = workspace / "android"
    if not (android / "app/jewell-release.jks").is_file() or not (android / "keystore.properties").is_file():
        raise RuntimeError("原版 Android 签名文件缺失；请恢复签名文件后重试")
    return source_sha


def install_signing_links(workspace: Path, worktree: Path) -> list[Path]:
    mappings = (
        (workspace / "android/app/jewell-release.jks", worktree / "android/app/jewell-release.jks"),
        (workspace / "android/keystore.properties", worktree / "android/keystore.properties"),
    )
    installed: list[Path] = []
    try:
        for source, destination in mappings:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(source.resolve())
            installed.append(destination)
    except OSError:
        remove_signing_links(installed)
        raise
    return installed


def remove_signing_links(paths: list[Path]) -> None:
    for path in paths:
        try:
            if path.is_symlink() or path.exists():
                path.unlink()
        except OSError as error:
            log_event("signing.cleanup.failed", path=str(path), error=str(error))


def android_environment(workspace: Path) -> dict[str, str]:
    env = os.environ.copy()
    toolchain = workspace / ".android-toolchain"
    defaults = {
        "JAVA_HOME": toolchain / "jdk/Contents/Home",
        "ANDROID_HOME": toolchain / "sdk",
        "ANDROID_SDK_ROOT": toolchain / "sdk",
        "GRADLE_USER_HOME": toolchain / "gradle",
        "ANDROID_USER_HOME": toolchain / "android-user",
    }
    for key, value in defaults.items():
        if not env.get(key) and value.exists():
            env[key] = str(value)
    if not env.get("ANDROID_HOME") and env.get("ANDROID_SDK_ROOT"):
        env["ANDROID_HOME"] = env["ANDROID_SDK_ROOT"]
    if not env.get("ANDROID_SDK_ROOT") and env.get("ANDROID_HOME"):
        env["ANDROID_SDK_ROOT"] = env["ANDROID_HOME"]
    return env


def find_build_tool(build_tools: list[Path], name: str) -> Path | None:
    candidates = [name, f"{name}.exe", f"{name}.bat"]
    for directory in build_tools:
        for candidate in candidates:
            path = directory / candidate
            if path.is_file():
                return path
    return None


def validate_apk(apk: Path, version: str, env: dict[str, str]) -> str:
    if not apk.is_file() or apk.stat().st_size == 0:
        raise RuntimeError(f"APK 未生成或为空：{apk}")
    with zipfile.ZipFile(apk) as archive:
        if "AndroidManifest.xml" not in archive.namelist() or archive.testzip() is not None:
            raise RuntimeError("APK 内容校验失败")
    sdk = env.get("ANDROID_HOME") or env.get("ANDROID_SDK_ROOT")
    build_tools = sorted((Path(sdk) / "build-tools").glob("*"), reverse=True) if sdk else []
    aapt = find_build_tool(build_tools, "aapt")
    apksigner = find_build_tool(build_tools, "apksigner")
    if aapt:
        badging = capture(str(aapt), "dump", "badging", str(apk), cwd=apk.parent)
        match = re.search(r"package: name='([^']+)' versionCode='[^']*' versionName='([^']*)'", badging.stdout)
        if not match or match.group(1) != "com.local.jewell" or match.group(2) != version:
            raise RuntimeError("APK 的包名或版本与 Jewell 发布版本不一致")
    else:
        log_event("apk.metadata.validation", outcome="unavailable", detail="找不到 aapt")
    if apksigner:
        signature = capture(str(apksigner), "verify", "--print-certs", str(apk), cwd=apk.parent)
        if "certificate SHA-256 digest:" not in signature.stdout:
            raise RuntimeError("APK 签名校验未返回证书摘要")
    else:
        log_event("apk.signature.validation", outcome="unavailable", detail="找不到 apksigner")
    digest = hashlib.sha256()
    with apk.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bootstrap_tool_path()
    os.environ.setdefault("GIT_TERMINAL_PROMPT", "0")
    os.environ.setdefault("GH_PROMPT_DISABLED", "1")
    workspace = Path(args.workspace).resolve()
    worktree = Path(args.worktree)
    state_path = Path(args.state)
    tag = f"v{args.version}"
    tag_created = False
    remote_published = args.resume
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
        "warning": False,
        "baseSha": args.base_sha,
        "phaseStartedAt": now_ms(),
        "phaseDurationMs": None,
        "phaseDurations": {},
        "step": None,
        "stepStartedAt": None,
        "stepDurationMs": None,
    }
    write_state(state_path, state)
    signing_links: list[Path] = []
    try:
        set_phase(state, state_path, "preparing-worktree")
        source_sha = validate_workspace(workspace, args.version, args.base_sha, args.resume)
        if args.resume:
            existing_release = github_release(workspace, tag)
            if existing_release is not None:
                if existing_release.get("draft"):
                    raise RuntimeError(f"GitHub Release {tag} 是 draft，停止自动恢复")
                expected_asset = f"jewell-v{args.version}.apk"
                asset_names = {asset.get("name") for asset in existing_release.get("assets", [])}
                if expected_asset in asset_names:
                    state.update({"status": "succeeded", "phase": "completed", "completedAt": now_ms(), "step": None})
                    write_state(state_path, state)
                    log_event("release.recovered", outcome="succeeded", version=args.version, url=existing_release.get("html_url"), asset=expected_asset)
                    return 0
        if worktree.exists():
            raise RuntimeError(f"发布 worktree 已存在：{worktree}")
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

        set_phase(state, state_path, "preparing")
        if not args.resume and source_sha != args.base_sha:
            run_step(state, state_path, "git", "merge", "--no-ff", "--no-edit", source_sha, cwd=worktree)
        npm = "npm.cmd" if os.name == "nt" else "npm"
        run_step(
            state,
            state_path,
            npm,
            "version",
            args.version,
            "--no-git-tag-version",
            "--allow-same-version",
            cwd=worktree,
        )

        set_phase(state, state_path, "checking")
        run_step(state, state_path, npm, "ci", cwd=worktree)
        run_step(state, state_path, npm, "run", "check", cwd=worktree)
        status = git(worktree, "status", "--porcelain", "--untracked-files=all")
        unexpected = [
            line[3:]
            for line in status.splitlines()
            if line[3:] not in ("package.json", "package-lock.json")
        ]
        if unexpected:
            raise RuntimeError(f"检查流程修改了其他文件，停止发布：{', '.join(unexpected)}")
        run_step(state, state_path, "git", "add", "--", "package.json", "package-lock.json", cwd=worktree)
        staged = git(worktree, "diff", "--cached", "--name-only")
        if staged:
            run_step(state, state_path, "git", "commit", "-m", f"release: v{args.version}", cwd=worktree)
        tag = f"v{args.version}"
        if not args.resume:
            run_step(state, state_path, "git", "tag", "-a", tag, "-m", f"Jewell {tag}", cwd=worktree)
            tag_created = True

        signing_links = install_signing_links(workspace, worktree)
        env = android_environment(workspace)
        set_phase(state, state_path, "building")
        run_step(state, state_path, npm, "run", "android:apk", cwd=worktree, env=env)
        apk = worktree / "releases" / f"jewell-v{args.version}.apk"
        digest = validate_apk(apk, args.version, env)
        local_release_dir = workspace / "releases"
        local_release_dir.mkdir(parents=True, exist_ok=True)
        local_apk = local_release_dir / apk.name
        shutil.copy2(apk, local_apk)
        log_event("apk.verified", path=str(local_apk), size=local_apk.stat().st_size, sha256=digest)

        if not args.resume:
            set_phase(state, state_path, "submitting")
            commit = git(worktree, "rev-parse", "HEAD")
            run_step(
                state,
                state_path,
                "git",
                "push",
                "--atomic",
                "origin",
                f"{commit}:refs/heads/{TARGET_BRANCH}",
                f"refs/tags/{tag}",
                cwd=worktree,
            )
            remote_published = True

        set_phase(state, state_path, "publishing")
        existing_release = github_release(workspace, tag)
        if existing_release is not None:
            if existing_release.get("draft"):
                raise RuntimeError(f"GitHub Release {tag} 是 draft，停止自动恢复")
            existing_assets = {asset.get("name") for asset in existing_release.get("assets", [])}
            if local_apk.name not in existing_assets:
                run_step(
                    state, state_path, "gh", "release", "upload", tag, str(local_apk),
                    "--repo", REPOSITORY, cwd=workspace,
                )
        else:
            run_step(
                state,
                state_path,
                "gh",
                "release",
                "create",
                tag,
                str(local_apk),
                "--repo",
                REPOSITORY,
                "--title",
                f"Jewell {tag}",
                "--generate-notes",
                "--verify-tag",
                cwd=workspace,
            )
        release = github_release(workspace, tag)
        if release is None:
            raise RuntimeError(f"GitHub Release {tag} 已创建，但未能回读确认")
        if release.get("draft"):
            raise RuntimeError(f"GitHub Release {tag} 仍是 draft")
        asset_names = {asset.get("name") for asset in release.get("assets", [])}
        if local_apk.name not in asset_names:
            raise RuntimeError(f"GitHub Release 已创建，但未确认到 APK 附件：{local_apk.name}")
        log_event("release.verified", tag=tag, url=release.get("html_url"), asset=local_apk.name, sha256=digest)

        previous_phase = state.get("phase")
        previous_started = state.get("phaseStartedAt")
        if isinstance(previous_phase, str) and isinstance(previous_started, int):
            duration = max(0, now_ms() - previous_started)
            durations = state.setdefault("phaseDurations", {})
            if isinstance(durations, dict):
                durations[previous_phase] = duration
            state["phaseDurationMs"] = duration
            log_event("phase.finished", phase=previous_phase, durationMs=duration)
        state.update({"status": "succeeded", "phase": "completed", "completedAt": now_ms(), "step": None})
        write_state(state_path, state)
        log_event("release.finished", outcome="succeeded", version=args.version, url=release.get("html_url"))
        return 0
    except Exception as error:
        if tag_created and not remote_published:
            remote_tag = capture(
                "git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}",
                cwd=workspace, allow_failure=True,
            )
            if remote_tag.returncode == 0 and not remote_tag.stdout.strip():
                removed = capture("git", "tag", "-d", tag, cwd=workspace, allow_failure=True)
                log_event("tag.cleanup", tag=tag, removed=removed.returncode == 0)
        previous_phase = state.get("phase")
        previous_started = state.get("phaseStartedAt")
        if isinstance(previous_phase, str) and isinstance(previous_started, int):
            duration = max(0, now_ms() - previous_started)
            durations = state.setdefault("phaseDurations", {})
            if isinstance(durations, dict):
                durations[previous_phase] = duration
            state["phaseDurationMs"] = duration
            log_event("phase.finished", phase=previous_phase, durationMs=duration)
        message = str(error)
        state.update({"status": "failed", "error": message, "completedAt": now_ms(), "step": None})
        write_state(state_path, state)
        log_event("release.finished", error=message, outcome="failed", version=args.version)
        print(f"Jewell release runner failed: {message}", file=sys.stderr, flush=True)
        return 1
    finally:
        remove_signing_links(signing_links)


if __name__ == "__main__":
    raise SystemExit(main())
