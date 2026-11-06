#!/usr/bin/env python3
"""project-doc: 把项目文档写意图回传给本机 Codex Harness。

Agent 不直接写文档文件，也不在输出里 emit 标记块；调用本命令把写意图
POST 到 Harness 的本地回传服务（地址从 ~/.codex-harness/project-doc-server.json 读）。

子命令：
  project-doc read     --thread-id T --project-id P      # 读当前正文 + seq
  project-doc propose  --thread-id T --project-id P --section S [--content ... | --file ...]
  project-doc entries  --thread-id T --project-id P
  project-doc update/supersede/delete/... --id ID --revision N --reason ...

propose 不用传 base_seq：Harness 在收到 status 提议时按当前 seq 自动入待审批队列；
log / decisions / openQuestions 追加区则免审批直接落盘。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ENDPOINT_STATE = Path.home() / ".codex-harness" / "project-doc-server.json"


class ProjectDocError(RuntimeError):
    pass


def load_base_url() -> str:
    if not ENDPOINT_STATE.exists():
        raise ProjectDocError(
            f"找不到 {ENDPOINT_STATE}：Codex Harness 的项目文档服务未在运行。"
            "请先在本机启动 Codex Harness，再重试。"
        )
    try:
        data = json.loads(ENDPOINT_STATE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectDocError(f"无法解析 {ENDPOINT_STATE}: {exc}") from exc
    base_url = data.get("baseUrl")
    if not isinstance(base_url, str) or not base_url.startswith("http://127.0.0.1:"):
        raise ProjectDocError(f"{ENDPOINT_STATE} 里没有合法的 baseUrl")
    return base_url.rstrip("/")


def http_json(method: str, url: str, payload: dict | None) -> tuple[int, dict]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            detail = {"error": f"HTTP {exc.code}"}
        return exc.code, detail
    except urllib.error.URLError as exc:
        raise ProjectDocError(f"无法连接项目文档服务（{url}）：{exc.reason}") from exc


def read_content_arg(args: argparse.Namespace) -> str:
    if args.content and args.file:
        raise ProjectDocError("--content 与 --file 只能二选一")
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    if args.content is not None:
        return args.content
    # 支持 stdin，便于粘贴多行正文。
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise ProjectDocError("缺少内容：用 --content、--file 或标准输入提供")


def cmd_read(args: argparse.Namespace) -> int:
    base = load_base_url()
    query = urllib.parse.urlencode({"project_id": args.project_id})
    status, body = http_json("GET", f"{base}/read?{query}", None)
    if status != 200:
        raise ProjectDocError(body.get("error", f"读取失败（HTTP {status}）"))
    print(f"# 项目 {body['projectId']} · 当前 seq {body['currentSeq']}")
    print()
    print(body.get("content", ""))
    return 0


def cmd_propose(args: argparse.Namespace) -> int:
    base = load_base_url()
    content = read_content_arg(args)
    status, body = http_json("POST", f"{base}/propose", {
        "threadId": args.thread_id,
        "projectId": args.project_id,
        "section": args.section,
        "content": content,
    })
    if status >= 400:
        raise ProjectDocError(body.get("error", f"提交失败（HTTP {status}）"))
    if body.get("applied"):
        print(f"已追加到 {args.section} 分区（v{body.get('newSeq')}）。")
    else:
        print(f"已提交 {args.section} 分区写入提议，等待人工确认（基于 v{body.get('baseSeq')}）。")
        print("Codex Harness 会在会话里弹出审批卡；你无需再等待，可继续手头工作。")
    return 0


def cmd_entries(args: argparse.Namespace) -> int:
    base = load_base_url()
    query = urllib.parse.urlencode({"project_id": args.project_id})
    status, body = http_json("GET", f"{base}/read?{query}", None)
    if status != 200:
        raise ProjectDocError(body.get("error", f"读取失败（HTTP {status}）"))
    print(json.dumps({"projectId": body["projectId"], "currentSeq": body["currentSeq"], "entries": body.get("entries", [])}, ensure_ascii=False, indent=2))
    return 0


def cmd_entry(args: argparse.Namespace) -> int:
    mutation = {"action": args.command, "reason": args.reason}
    if args.command == "adopt":
        mutation.update(section=args.section, baseSeq=args.base_seq, content=read_content_arg(args))
    else:
        mutation.update(id=args.id, revision=args.revision)
        if args.command in ("update", "supersede"):
            mutation["content"] = read_content_arg(args)
    status, body = http_json("POST", f"{load_base_url()}/entries", {
        "threadId": args.thread_id, "projectId": args.project_id, "mutation": mutation,
    })
    if status >= 400:
        raise ProjectDocError(body.get("error", f"修改失败（HTTP {status}），请重读后重试"))
    print(json.dumps(body, ensure_ascii=False, indent=2))
    return 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def cmd_onboarding(args: argparse.Namespace) -> int:
    try:
        endpoint = json.loads((Path.home() / ".codex-harness" / "management-server.json").read_text())
    except (OSError, ValueError) as exc:
        raise ProjectDocError("Harness 管理入口不可用，请先启动应用") from exc
    if not isinstance(endpoint, dict): raise ProjectDocError("管理入口配置无效")
    try:
        url = urllib.parse.urlsplit(endpoint.get("baseUrl", ""))
        port = url.port
    except (ValueError, TypeError): raise ProjectDocError("管理入口配置无效") from None
    token = endpoint.get("token")
    if (endpoint.get("protocolVersion") != 1 or url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1")
            or not port or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment
            or not isinstance(token, str) or len(token) < 32):
        raise ProjectDocError("管理入口配置无效")
    params = {}
    method = "projects.list"
    if args.command != "projects":
        if not args.thread_id: raise ProjectDocError("需要来源 --thread-id 或 CODEX_THREAD_ID，不能使用当前选中会话代替")
        params = {"threadId": args.thread_id, "mode": "create" if args.command == "request-create" else "join"}
        if args.command == "request-create": params["name"] = args.name
        else: params["projectId"] = args.project_id
        method = "projects.requestOnboarding"
    request_id = str(uuid.uuid4())
    payload = {"requestId": request_id, "method": method, "params": params}
    request = urllib.request.Request(endpoint["baseUrl"].rstrip("/") + "/management/call",
        data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=30) as response: result = json.load(response)
    except urllib.error.HTTPError as exc:
        try: error = json.loads(exc.read(65536)).get("error", str(exc.code))
        except ValueError: error = f"HTTP {exc.code}"
        raise ProjectDocError(error) from None
    except (OSError, ValueError) as exc:
        raise ProjectDocError(f"申请结果未知，先检查来源会话确认卡（requestId={request_id}）") from exc
    if not isinstance(result, dict) or result.get("requestId") != request_id or "result" not in result:
        raise ProjectDocError(f"申请结果无法关联，请检查来源会话确认卡（requestId={request_id}）")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.command != "projects": print("已申请显示确认卡。等待用户确认，不要自行创建、绑定或写文档。")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="project-doc", description="项目文档回传命令")
    sub = parser.add_subparsers(dest="command", required=True)
    projects = sub.add_parser("projects", help="列出可加入的项目")
    projects.set_defaults(func=cmd_onboarding)
    for action in ("request-create", "request-join"):
        command = sub.add_parser(action, help="申请新建/加入项目，仅显示确认卡，不直接写入")
        command.add_argument("--thread-id", default=os.environ.get("CODEX_THREAD_ID"))
        if action == "request-create": command.add_argument("--name", required=True)
        else: command.add_argument("--project-id", required=True)
        command.set_defaults(func=cmd_onboarding)

    read = sub.add_parser("read", help="读取项目当前正文 + seq")
    read.add_argument("--thread-id", required=True)
    read.add_argument("--project-id", required=True)
    read.set_defaults(func=cmd_read)

    propose = sub.add_parser("propose", help="提交一个分区写入提议")
    propose.add_argument("--thread-id", required=True)
    propose.add_argument("--project-id", required=True)
    propose.add_argument("--section", required=True,
                         choices=["status", "log", "decisions", "openQuestions"])
    propose.add_argument("--content")
    propose.add_argument("--file")
    propose.set_defaults(func=cmd_propose)
    entries = sub.add_parser("entries", help="读取受管理条目、修订号、状态和原因（包含软删除条目）")
    entries.add_argument("--thread-id", required=True)
    entries.add_argument("--project-id", required=True)
    entries.set_defaults(func=cmd_entries)
    for action in ("adopt", "update", "supersede", "delete", "restore", "revoke", "close", "reopen"):
        entry = sub.add_parser(action, help=f"条目操作：{action}（不硬删除）")
        entry.add_argument("--thread-id", required=True)
        entry.add_argument("--project-id", required=True)
        entry.add_argument("--reason", required=True)
        if action == "adopt":
            entry.add_argument("--section", required=True, choices=["decisions", "openQuestions"])
            entry.add_argument("--base-seq", required=True, type=int)
        else:
            entry.add_argument("--id", required=True)
            entry.add_argument("--revision", required=True, type=int)
        if action in ("adopt", "update", "supersede"):
            entry.add_argument("--content")
            entry.add_argument("--file")
        entry.set_defaults(func=cmd_entry)
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ProjectDocError as exc:
        print(f"project-doc: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
