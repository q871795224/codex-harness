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
        "plugins": ["list", "create", "enable", "disable", "configure", "delete"],
        "skills": ["list", "enable", "disable"], "mcp": ["list", "reload"], "config": ["read", "set"],
    }.items():
        sub = groups.add_parser(group).add_subparsers(dest="action", required=True)
        for action in actions:
            command = sub.add_parser(action)
            if group == "workspaces" and action != "list": command.add_argument("path")
            if group == "sessions" and action in {"select", "rename", "archive", "restore"}: command.add_argument("id")
            if group == "sessions" and action == "rename": command.add_argument("name")
            if group == "skills" or (group == "sessions" and action == "create"):
                if group == "skills" or action == "create": command.add_argument("--cwd", required=True)
                command.add_argument("--provider", choices=["codex", "claude"], default="codex")
            if group == "skills" and action != "list": command.add_argument("path")
            if group == "plugins":
                if action in {"enable", "disable", "configure", "delete"}: command.add_argument("instance_id")
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
        if action == "create": params.update(cwd=args.cwd, provider=args.provider)
    if group == "skills":
        params.update(cwd=args.cwd, provider=args.provider)
        if action != "list": params.update(path=args.path, enabled=action == "enable"); action = "setEnabled"
    if group == "plugins":
        if action in {"enable", "disable", "configure", "delete"}: params["instanceId"] = args.instance_id
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
