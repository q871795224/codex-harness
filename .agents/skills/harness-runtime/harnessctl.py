#!/usr/bin/env python3
"""Local authenticated client for Codex Harness. Never reads or writes its databases."""
import argparse
import json
import os
from pathlib import Path
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class ClientError(Exception):
    def __init__(self, message, *, request_id=None, uncertain=False):
        super().__init__(message)
        self.request_id = request_id
        self.uncertain = uncertain


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_object(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ClientError("需要 JSON 对象")
    return value


def resolve_source(home, explicit=None):
    config = home / ".codex-harness/management-client.json"
    configured = read_object(config).get("sourceRepo") if config.exists() and not explicit and not os.environ.get("CODEX_HARNESS_REPO") else None
    for value in [explicit, os.environ.get("CODEX_HARNESS_REPO"), configured,
                  str(home / "sgw/person-project/codex-harness")]:
        if not value:
            continue
        root = Path(value).expanduser().resolve()
        if (root / ".harness/README.md").is_file() and (root / "src-tauri/src/lib.rs").is_file():
            return {"path": str(root), "instructions": str(root / "AGENTS.md"),
                    "routing": str(root / ".harness/README.md"), "sourceVersion": read_object(root / "package.json").get("version"),
                    "note": "源码版本不代表运行中或已安装的应用版本"}
        if value == explicit:
            raise ClientError("指定路径不是 Codex Harness 源码仓库")
    raise ClientError("未找到 Harness 仓库；用 --repo PATH、CODEX_HARNESS_REPO 或 source --set PATH 指定")


def call(endpoint_file, method, params, request_id=None):
    request_id = request_id or str(uuid.uuid4())
    try:
        endpoint = read_object(endpoint_file)
    except FileNotFoundError:
        raise ClientError("管理入口不存在；应用未运行或版本尚不支持。可用 harnessctl source 进入源码 fallback") from None
    except (ValueError, TypeError):
        raise ClientError("管理入口文件无效") from None
    if endpoint.get("protocolVersion") != 1:
        raise ClientError("管理协议不兼容；请核对应用版本并读取源码接口")
    parsed = urllib.parse.urlsplit(endpoint.get("baseUrl", ""))
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment or not parsed.port):
        raise ClientError("管理端点必须是本机 loopback HTTP 地址")
    token = endpoint.get("token")
    if not isinstance(token, str) or len(token) < 32:
        raise ClientError("管理端点缺少有效认证信息")
    body = json.dumps({"requestId": request_id, "method": method, "params": params}, ensure_ascii=False).encode()
    request = urllib.request.Request(endpoint["baseUrl"].rstrip("/") + "/management/call", data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    # Never send the local credential to a configured proxy or redirect target.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=70) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ClientError("管理响应过大，请查询实际状态", request_id=request_id, uncertain=True)
            result = json.loads(raw)
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read(65536)).get("error", f"HTTP {error.code}")
        except (ValueError, AttributeError):
            message = f"管理入口返回 HTTP {error.code}"
        raise ClientError(message, request_id=request_id, uncertain=error.code in {409, 504}) from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
        raise ClientError("管理连接失败或超时；结果未知，请查询实际状态，不要自动重复写入", request_id=request_id, uncertain=True) from None
    except ValueError:
        raise ClientError("管理响应不是有效 JSON；请查询实际状态", request_id=request_id, uncertain=True) from None
    if not isinstance(result, dict) or result.get("requestId") != request_id or "result" not in result:
        raise ClientError("管理响应无法关联到本次请求", request_id=request_id, uncertain=True)
    return result


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--endpoint-file", type=Path, help="默认 ~/.codex-harness/management-server.json")
    p.add_argument("--repo", help="源码 fallback 的仓库路径")
    p.add_argument("--request-id", help="复用写请求标识以避免当前应用实例内重复执行")
    groups = p.add_subparsers(dest="group", required=True)
    for name in ["status", "capabilities"]:
        groups.add_parser(name)
    source = groups.add_parser("source")
    source.add_argument("--set", dest="set_source", metavar="PATH")
    raw = groups.add_parser("call", help="调用 capabilities 中列出的操作")
    raw.add_argument("method")
    inputs = raw.add_mutually_exclusive_group()
    inputs.add_argument("--params", default="{}", help="JSON 对象")
    inputs.add_argument("--params-file", type=Path)
    for group, actions in {
        "workspaces": ["list", "add", "hide", "show"],
        "sessions": ["list", "create", "select", "rename", "archive", "restore"],
        "plugins": ["list", "read", "create", "enable", "disable", "configure", "delete"],
        "skills": ["list", "enable", "disable"], "mcp": ["list", "reload"], "config": ["read", "set"],
    }.items():
        sub = groups.add_parser(group).add_subparsers(dest="action", required=True)
        for action in actions:
            command = sub.add_parser(action)
            if group == "workspaces" and action != "list": command.add_argument("path")
            if group == "sessions" and action in {"select", "rename", "archive", "restore"}: command.add_argument("id")
            if group == "sessions" and action == "rename": command.add_argument("name")
            if group == "skills" or (group == "sessions" and action == "create"):
                if group == "skills" or action == "create": command.add_argument("--cwd", required=group == "skills")
                command.add_argument("--provider", choices=["codex", "claude"], default="codex")
            if group == "skills" and action != "list": command.add_argument("path")
            if group == "plugins":
                if action in {"read", "enable", "disable", "configure", "delete"}: command.add_argument("instance_id")
                if action == "create":
                    command.add_argument("plugin_id")
                    command.add_argument("--scope", choices=["global", "workspace", "thread"], default="global")
                    command.add_argument("--scope-key")
                if action in {"configure", "create"}: command.add_argument("--file", type=Path, required=action == "configure")
                if action == "list":
                    command.add_argument("--provider", choices=["codex", "claude"])
                    command.add_argument("--workspace-root")
                    command.add_argument("--thread-id")
            if group == "config" and action == "set":
                command.add_argument("key")
                command.add_argument("value")
    models = groups.add_parser("models").add_subparsers(dest="action", required=True)
    models.add_parser("list").add_argument("--provider", choices=["codex", "claude"], default="codex")
    settings = groups.add_parser("settings", help="Harness应用设置；Codex默认值使用config").add_subparsers(dest="action", required=True)
    settings.add_parser("list")
    settings.add_parser("read").add_argument("name")
    update = settings.add_parser("update")
    update.add_argument("name"); update.add_argument("--file", type=Path, required=True); update.add_argument("--expected-file", type=Path)
    projects = groups.add_parser("projects", help="项目元数据").add_subparsers(dest="action", required=True)
    projects.add_parser("list")
    projects.add_parser("get").add_argument("project_id")
    update = projects.add_parser("update"); update.add_argument("project_id"); update.add_argument("--file", type=Path, required=True); update.add_argument("--expected-file", type=Path)
    router = groups.add_parser("router", help="Router缓存、Prompt、反馈与显式纠正").add_subparsers(dest="action", required=True)
    router.add_parser("summaries")
    refresh = router.add_parser("refresh"); refresh.add_argument("root", nargs="?"); refresh.add_argument("--all", action="store_true")
    preview = router.add_parser("preview"); preview.add_argument("--input-file", type=Path)
    router.add_parser("record").add_argument("thread_id")
    feedback = router.add_parser("feedback"); feedback.add_argument("--offset", type=int, default=0); feedback.add_argument("--limit", type=int, default=20)
    for action in ("set-feedback", "correct"):
        command = router.add_parser(action); command.add_argument("thread_id")
        target = command.add_mutually_exclusive_group(required=True)
        target.add_argument("--workspace"); target.add_argument("--general", action="store_true")
        if action == "set-feedback": target.add_argument("--accurate", action="store_true")
    notices = groups.add_parser("notifications", help="通知历史及已读；不启用旧右侧浮层").add_subparsers(dest="action", required=True)
    listing = notices.add_parser("list"); listing.add_argument("--thread-id"); listing.add_argument("--unread", action="store_true"); listing.add_argument("--offset", type=int, default=0); listing.add_argument("--limit", type=int, default=50)
    read = notices.add_parser("read"); read.add_argument("id", nargs="?"); read.add_argument("--all", action="store_true")
    seatalk = groups.add_parser("seatalk", help="只读连接与会话分支诊断").add_subparsers(dest="action", required=True)
    seatalk.add_parser("status"); seatalk.add_parser("bindings")
    waits = groups.add_parser("async-waits", help="Harness 原生异步等待").add_subparsers(dest="action", required=True)
    waits.add_parser("list")
    get = waits.add_parser("get")
    get.add_argument("id")
    create = waits.add_parser("create")
    create.add_argument("--file", type=Path, required=True)
    for action in ("check", "pause", "resume", "cancel", "acknowledge"):
        waits.add_parser(action).add_argument("id")
    return p


def operation(args):
    group = args.group
    if group in {"status", "capabilities"}: return group, {}
    if group == "call":
        params = read_object(args.params_file) if args.params_file else json.loads(args.params)
        if not isinstance(params, dict): raise ClientError("params 必须是对象")
        return args.method, params
    action = args.action
    if group == "models": return "models.list", {"provider": args.provider}
    if group == "settings":
        if action == "list": return "settings.list", {}
        params = {"group": args.name}
        if action == "update":
            params["patch"] = read_object(args.file)
            if args.expected_file: params["expected"] = read_object(args.expected_file)
        return "settings." + action, params
    if group == "projects":
        if action == "list": return "projects.list", {}
        if action in {"get", "update"}:
            params = {"projectId": args.project_id}
            if action == "update":
                params["patch"] = read_object(args.file)
                if args.expected_file: params["expected"] = read_object(args.expected_file)
            return "projects." + action, params
    if group == "router":
        if action == "summaries": return "router.summaries", {}
        if action == "refresh":
            if bool(args.root) == bool(args.all): raise ClientError("请提供一个工作区root或--all")
            return "router.refresh", {"all": True} if args.all else {"root": args.root}
        if action == "preview": return "router.preview", {"input": args.input_file.read_text()} if args.input_file else {}
        if action == "record": return "router.record", {"threadId": args.thread_id}
        if action == "feedback": return "router.feedback", {"offset": args.offset, "limit": args.limit}
        params = {"threadId": args.thread_id}
        if action == "set-feedback": params["accurate"] = args.accurate
        if not getattr(args, "accurate", False): params["actualWorkspace"] = args.workspace if args.workspace is not None else None
        return ("router.setFeedback" if action == "set-feedback" else "router.correct"), params
    if group == "notifications":
        if action == "list":
            params = {"offset": args.offset, "limit": args.limit, "unread": args.unread}
            if args.thread_id: params["threadId"] = args.thread_id
            return "notifications.list", params
        if bool(args.id) == bool(args.all): raise ClientError("请提供通知ID或--all")
        return "notifications.markRead", {"all": True} if args.all else {"id": args.id}
    if group == "seatalk": return "seatalk." + action, {}
    if group == "async-waits":
        if action in {"list", "get"}: return "asyncWaits.list", {}
        if action == "create":
            params = read_object(args.file)
            params.setdefault("threadId", os.environ.get("CODEX_THREAD_ID"))
            if not params.get("threadId"): raise ClientError("需要来源 threadId 或 CODEX_THREAD_ID，不能用当前选中会话代替")
            return "asyncWaits.create", params
        return "asyncWaits.action", {"id": args.id, "action": action}
    params = {}
    if group == "workspaces" and action != "list": params["root" if action == "hide" else "path"] = args.path
    if group == "sessions":
        if action in {"select", "rename", "archive", "restore"}: params["id"] = args.id
        if action == "rename": params["name"] = args.name
        if action == "create":
            params["provider"] = args.provider
            if args.cwd: params["cwd"] = args.cwd
    if group == "skills":
        params.update(cwd=args.cwd, provider=args.provider)
        if action != "list": params.update(path=args.path, enabled=action == "enable"); action = "setEnabled"
    if group == "plugins":
        if action in {"read", "enable", "disable", "configure", "delete"}: params["instanceId"] = args.instance_id
        if action in {"enable", "disable"}: params["enabled"] = action == "enable"; action = "setEnabled"
        if action == "configure": params["patch"] = read_object(args.file)
        if action == "create":
            target = {"kind": args.scope}
            if args.scope != "global":
                if not args.scope_key: raise ClientError("非 global 作用域需要 --scope-key")
                target["workspaceRoot" if args.scope == "workspace" else "threadId"] = args.scope_key
            params.update(pluginId=args.plugin_id, scope=target)
            if args.file: params["config"] = read_object(args.file)
        if action == "list":
            for key in ["provider", "workspace_root", "thread_id"]:
                if getattr(args, key): params[{"workspace_root": "workspaceRoot", "thread_id": "threadId"}.get(key, key)] = getattr(args, key)
    if group == "config" and action == "set": params.update(key=args.key, value=args.value)
    return group + "." + action, params


def main(argv=None):
    args = parser().parse_args(argv)
    home = Path.home()
    try:
        if args.group == "source":
            result = resolve_source(home, args.set_source or args.repo)
            if args.set_source:
                path = home / ".codex-harness/management-client.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                temp = path.with_suffix(".tmp-" + uuid.uuid4().hex)
                try:
                    temp.write_text(json.dumps({"sourceRepo": result["path"]}, ensure_ascii=False) + "\n")
                    os.replace(temp, path)
                finally:
                    temp.unlink(missing_ok=True)
        else:
            method, params = operation(args)
            result = call(args.endpoint_file or home / ".codex-harness/management-server.json", method, params, args.request_id)
        if args.group == "async-waits" and args.action == "get":
            task = next((t for t in result["result"]["data"] if t["id"] == args.id), None)
            if task is None: raise ClientError("异步任务不存在")
            result["result"] = task
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ClientError, OSError, ValueError) as error:
        output = {"error": str(error)}
        if isinstance(error, ClientError):
            if error.request_id: output["requestId"] = error.request_id
            if error.uncertain: output["outcomeUnknown"] = True
        print(json.dumps(output, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
