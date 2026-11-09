import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('harnessctl', Path(__file__).parents[1] / 'harnessctl.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class CLITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='harness cli ')
        self.root = Path(self.temp.name)
        self.calls = []
        calls = self.calls
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.headers.get('Authorization') != 'Bearer fixture-key-00000000000000000000000000':
                    self.send_error(401)
                    return
                d = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(d)
                task = {'id': 'wait-one', 'threadId': 'origin', 'lastObservation': 'reply received', 'continuation': 'Read the reply'}
                result = {'data': [task], 'schedulerError': None} if d['method'] == 'asyncWaits.list' else d['params']
                raw = json.dumps({'requestId': d['requestId'], 'result': result}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(raw)
            def log_message(self, *_): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = self.root / 'endpoint.json'
        self.endpoint.write_text(json.dumps({'protocolVersion': 1, 'baseUrl': f'http://127.0.0.1:{self.server.server_port}', 'token': 'fixture-key-00000000000000000000000000'}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(['--endpoint-file', str(self.endpoint), *args])
        self.assertNotIn('fixture-key-00000000000000000000000000', out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_get_returns_observation_and_continuation_for_only_the_requested_task(self):
        code, out, _ = self.run_cli('async-waits', 'get', 'wait-one')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['result']['lastObservation'], 'reply received')
        self.assertEqual(json.loads(out)['result']['continuation'], 'Read the reply')
        self.assertEqual(len(self.calls), 1)

    def test_missing_task_is_an_error_without_mutating_anything(self):
        code, _, err = self.run_cli('async-waits', 'get', 'missing')
        self.assertEqual(code, 1)
        self.assertIn('异步任务不存在', err)
        self.assertEqual(self.calls[0]['method'], 'asyncWaits.list')

    def test_creation_uses_origin_environment_and_one_request(self):
        file = self.root / 'wait.json'
        file.write_text(json.dumps({'id': 'wait-one', 'title': 'Wait', 'checkerPath': '/tmp/check.py', 'continuation': 'Review'}))
        with patch.dict(os.environ, {'CODEX_THREAD_ID': 'actual-origin'}):
            code, _, _ = self.run_cli('async-waits', 'create', '--file', str(file))
        self.assertEqual(code, 0)
        self.assertEqual(self.calls[0]['params']['threadId'], 'actual-origin')
        self.assertEqual(self.calls[0]['method'], 'asyncWaits.create')
        self.assertEqual(len(self.calls), 1)

    def test_explicit_origin_is_preserved_and_missing_origin_is_rejected(self):
        file = self.root / 'wait.json'
        file.write_text(json.dumps({'id': 'one', 'threadId': 'original-thread'}))
        with patch.dict(os.environ, {'CODEX_THREAD_ID': 'other'}):
            self.assertEqual(self.run_cli('async-waits', 'create', '--file', str(file))[0], 0)
        self.assertEqual(self.calls[0]['params']['threadId'], 'original-thread')
        file.write_text('{}')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.run_cli('async-waits', 'create', '--file', str(file))[0], 1)
        self.assertEqual(len(self.calls), 1)

    def test_pause_goes_through_native_management(self):
        self.assertEqual(self.run_cli('async-waits', 'pause', 'wait-one')[0], 0)
        self.assertEqual(self.calls[0]['method'], 'asyncWaits.action')
        self.assertEqual(self.calls[0]['params'], {'id': 'wait-one', 'action': 'pause'})


    def test_new_management_commands_send_their_typed_parameters(self):
        file = self.root / 'patch with spaces.json'
        file.write_text(json.dumps({'backend': 'codex', 'descriptions': {'/a': 'a\nb'}}))
        cases = [
            (['settings', 'list'], 'settings.list', {}),
            (['settings', 'read', 'router'], 'settings.read', {'group': 'router'}),
            (['settings', 'update', 'router', '--file', str(file)], 'settings.update', {'group': 'router', 'patch': json.loads(file.read_text())}),
            (['router', 'refresh', '/work tree'], 'router.refresh', {'root': '/work tree'}),
            (['router', 'correct', 'thread', '--general'], 'router.correct', {'threadId': 'thread', 'actualWorkspace': None}),
            (['router', 'set-feedback', 'thread', '--accurate'], 'router.setFeedback', {'threadId': 'thread', 'accurate': True}),
            (['plugins', 'read', 'one'], 'plugins.read', {'instanceId': 'one'}),
            (['notifications', 'read', '--all'], 'notifications.markRead', {'all': True}),
            (['seatalk', 'bindings'], 'seatalk.bindings', {}),
            (['models', 'list'], 'models.list', {'provider': 'codex'}),
            (['sessions', 'create'], 'sessions.create', {'provider': 'codex'}),
        ]
        for args, method, params in cases:
            with self.subTest(args=args):
                self.assertEqual(self.run_cli(*args)[0], 0)
                self.assertEqual(self.calls[-1]['method'], method)
                self.assertEqual(self.calls[-1]['params'], params)

    def test_project_commands_use_the_actual_origin_and_do_not_replace_selection(self):
        with patch.dict(os.environ, {'CODEX_THREAD_ID': 'actual-origin'}):
            self.assertEqual(self.run_cli('projects', 'request-create', 'Harness 管理')[0], 0)
        self.assertEqual(self.calls[-1]['params'], {'threadId': 'actual-origin', 'mode': 'create', 'name': 'Harness 管理'})
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.run_cli('projects', 'request-status')[0], 1)
        self.assertEqual(len(self.calls), 1)

    def test_ambiguous_bulk_commands_are_rejected_before_http(self):
        for args in [('router', 'refresh'), ('router', 'refresh', '/a', '--all'), ('notifications', 'read'), ('notifications', 'read', 'one', '--all')]:
            self.assertEqual(self.run_cli(*args)[0], 1)
        self.assertEqual(self.calls, [])

    def test_optional_expected_settings_and_preview_file_preserve_values(self):
        patch_file = self.root / 'patch.json'; patch_file.write_text('{"feedbackCount": 5}')
        expected = self.root / 'expected.json'; expected.write_text('{"backend": "decision2"}')
        self.assertEqual(self.run_cli('settings', 'update', 'router', '--file', str(patch_file), '--expected-file', str(expected))[0], 0)
        self.assertEqual(self.calls[-1]['params']['expected'], {'backend': 'decision2'})
        request = self.root / 'request.txt'; request.write_text('中文需求\n保留换行')
        self.assertEqual(self.run_cli('router', 'preview', '--input-file', str(request))[0], 0)
        self.assertEqual(self.calls[-1]['params'], {'input': request.read_text()})


if __name__ == '__main__': unittest.main()
