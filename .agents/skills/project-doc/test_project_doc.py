import contextlib
import importlib.util
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('project_doc', Path(__file__).with_name('project_doc.py'))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status = 200
        self.response = {'outcome': {'kind': 'applied', 'newSeq': 4}}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append((self.path, body))
                self.send_response(owner.status)
                self.end_headers()
                self.wfile.write(json.dumps({**owner.response, "requestId": body["requestId"]} if self.path == "/management/call" else owner.response).encode())

            def do_GET(self):
                owner.requests.append((self.path, None))
                self.send_response(owner.status)
                self.end_headers()
                self.wfile.write(json.dumps(owner.response).encode())

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.patch = patch.object(cli, 'load_base_url', return_value=self.base)
        self.patch.start()
        self.output = io.StringIO()

    def tearDown(self):
        self.patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_cli(self, *args):
        with contextlib.redirect_stdout(self.output), contextlib.redirect_stderr(self.output):
            return cli.main([*args, '--thread-id', 't', '--project-id', 'p'])

    def test_unbound_agent_only_requests_a_confirmation_card(self):
        endpoint = {"protocolVersion": 1, "baseUrl": self.base, "token": "test-token-" * 8}
        self.response = {"requestId": "ignored-fixture", "result": {"requestId": "card", "phase": "confirm"}}
        with patch.object(Path, "read_text", return_value=json.dumps(endpoint)):
            with contextlib.redirect_stdout(self.output), contextlib.redirect_stderr(self.output):
                result = cli.main(["request-create", "--thread-id", "unbound", "--name", "新项目"])
        self.assertEqual(result, 0)
        path, body = self.requests[0]
        self.assertEqual(path, "/management/call")
        self.assertEqual(body["method"], "projects.requestOnboarding")
        self.assertEqual(body["params"], {"threadId": "unbound", "mode": "create", "name": "新项目"})
        self.assertIn("等待用户确认", self.output.getvalue())
        self.assertNotIn(endpoint["token"], self.output.getvalue())

    def test_supersede_is_one_versioned_http_operation(self):
        self.assertEqual(self.run_cli('supersede', '--id', 'D-one', '--revision', '3', '--reason', '用户改规则', '--content', '只补缺失项'), 0)
        self.assertEqual(self.requests, [('/entries', {'threadId': 't', 'projectId': 'p', 'mutation': {'action': 'supersede', 'id': 'D-one', 'revision': 3, 'reason': '用户改规则', 'content': '只补缺失项'}})])

    def test_conflict_reports_error_and_never_retries_or_deletes(self):
        self.status, self.response = 409, {'error': '条目修订冲突，请重读'}
        self.assertEqual(self.run_cli('delete', '--id', 'D-one', '--revision', '2', '--reason', '失效'), 1)
        self.assertIn('修订冲突', self.output.getvalue())
        self.assertEqual(len(self.requests), 1)
        self.assertNotIn('content', self.requests[0][1]['mutation'])

    def test_read_entries_includes_inactive_records_and_old_command_still_appends(self):
        self.response = {'projectId': 'p', 'currentSeq': 4, 'entries': [{'id': 'D-one', 'state': 'deleted', 'content': '错误经验'}]}
        self.assertEqual(self.run_cli('entries'), 0)
        self.assertIn('错误经验', self.output.getvalue())
        self.response = {'applied': True, 'newSeq': 5}
        self.assertEqual(self.run_cli('propose', '--section', 'log', '--content', '进展'), 0)
        self.assertEqual(self.requests[-1][0], '/propose')

    def test_adopt_requires_exact_content_and_a_document_version(self):
        self.assertEqual(self.run_cli('adopt', '--section', 'decisions', '--base-seq', '7', '--reason', '纳管', '--content', '旧规则'), 0)
        mutation = self.requests[-1][1]['mutation']
        self.assertEqual(mutation['baseSeq'], 7)
        self.assertEqual(mutation['section'], 'decisions')
        self.assertEqual(mutation['content'], '旧规则')


if __name__ == '__main__':
    unittest.main()
