import importlib.util
import json
from pathlib import Path
import unittest

module = importlib.util.spec_from_file_location('checkers', Path(__file__).with_name('checkers.py'))
checkers = importlib.util.module_from_spec(module)
module.loader.exec_module(checkers)


class CheckersTest(unittest.TestCase):
    def test_gitlab_tracks_exact_pipeline_and_notifies_failures(self):
        spec = dict(type='gitlabCi', project='group/repo', pipeline=42, sha='a'*40)
        def query(cli, args):
            self.assertEqual((cli, args), ('gitlab-api', ['api', 'GET', 'projects/group%2Frepo/pipelines/42']))
            return json.dumps(dict(id=42, sha='a'*40, status='failed', web_url='https://git.example/pipeline/42'))
        self.assertEqual(checkers.main(spec, query)['status'], 'ready')
        self.assertEqual(checkers.main(spec, lambda *a: json.dumps(dict(id=42, sha='b'*40)))['status'], 'needsAttention')

    def test_github_checks_status_contexts_and_new_head(self):
        spec = dict(type='githubCi', repo='owner/repo', pr=7, sha='a'*40)
        def query(cli, args):
            path = args[-1]
            if '/pulls/' in path:
                return json.dumps(dict(head=dict(sha='a'*40)))
            if '/check-runs?' in path:
                return json.dumps(dict(total_count=1, check_runs=[dict(name='test', status='completed', conclusion='success')]))
            return json.dumps(dict(state='pending', total_count=1))
        self.assertEqual(checkers.main(spec, query)['status'], 'waiting')
        self.assertEqual(checkers.main(spec, lambda cli, args: json.dumps(dict(head=dict(sha='b'*40))))['status'], 'ready')
        def complete(cli, args):
            if args[-1].endswith('/status?per_page=100'):
                return json.dumps(dict(state='failure', total_count=1))
            return query(cli, args)
        self.assertEqual(checkers.main(spec, complete)['status'], 'ready')
        self.assertIn('失败', checkers.main(spec, complete)['summary'])

    def test_github_pages_all_checks_and_does_not_treat_no_checks_as_success(self):
        spec = dict(type='githubCi', repo='owner/repo', pr=7, sha='a'*40)
        def query(cli, args):
            path = args[-1]
            if '/pulls/' in path: return json.dumps(dict(head=dict(sha='a'*40)))
            if '/check-runs?' in path:
                if 'page=2' in path: return json.dumps(dict(total_count=101, check_runs=[dict(name='last', status='in_progress')]))
                return json.dumps(dict(total_count=101, check_runs=[dict(name='done', status='completed', conclusion='success')]*100))
            return json.dumps(dict(state='pending', total_count=0))
        self.assertEqual(checkers.main(spec, query)['status'], 'waiting')
        def empty(cli, args):
            if '/check-runs?' in args[-1]: return json.dumps(dict(total_count=0, check_runs=[]))
            return query(cli, args)
        self.assertEqual(checkers.main(spec, empty)['status'], 'waiting')

    def test_sdp_requires_exact_commit_and_every_target_healthy(self):
        spec = dict(type='sdp', service='svc-test-sg', environment='test', callback='abc', sha='a'*40, tasks=['svc-test-sg.1.1', 'svc-test-sg.1.2'])
        table = 'svc-test-sg.1.1 RUNNING healthy\nsvc-test-sg.1.2 RUNNING unhealthy'
        sha = 'a'*40
        status = 'SUCCESS'
        def query(cli, args):
            self.assertEqual(cli, 'smc')
            if args[0] == 'sdpcli': return json.dumps(dict(data=dict(callback_id='abc', git_version=dict(commit_id=sha), tracking=dict(status=status))))
            return table
        self.assertEqual(checkers.main(spec, query)['status'], 'waiting')
        table = table.replace('unhealthy', 'healthy')
        self.assertEqual(checkers.main(spec, query)['status'], 'ready')
        sha = 'b'*40
        self.assertEqual(checkers.main(spec, query)['status'], 'needsAttention')
        sha, status = 'a'*40, 'FAILED'
        self.assertEqual(checkers.main(spec, query)['status'], 'ready')

    def test_seatalk_pages_deduplicates_excludes_self_and_preserves_coverage(self):
        spec = dict(type='seatalk', reference='seatalk://conversation?v=1&owner_id=self&target_id=group&target_type=group&message_id=base', after='base', excludeSender='self')
        cursors = []
        def query(cli, args):
            self.assertEqual(cli, 'bridge')
            self.assertEqual(args[args.index('--ref')+1], spec['reference'])
            after = args[args.index('--after')+1]; cursors.append(after)
            if after == 'base': return json.dumps(dict(messages=[dict(messageId='mine', senderId='self')], cursor='mine', hasMore=True))
            return json.dumps(dict(messages=[dict(messageId='reply', senderId='bot'), dict(messageId='reply', senderId='bot')], hasMore=False))
        response = checkers.main(spec, query)
        self.assertEqual(cursors, ['base', 'mine'])
        self.assertEqual(response['status'], 'ready')
        self.assertEqual(response['summary'].count('reply'), 1)
        empty = checkers.main(spec, lambda *a: '{"messages": [], "historyComplete": false}')
        self.assertEqual(empty['status'], 'waiting')
        self.assertIn('不完整', empty['summary'])

    def test_auth_pauses_and_transport_errors_use_native_backoff(self):
        spec = dict(type='gitlabCi', project='a', pipeline=1, sha='a'*40)
        def auth(*a): raise PermissionError('secret')
        self.assertEqual(checkers.main(spec, auth)['status'], 'needsAttention')
        def failure(*a): raise RuntimeError('secret')
        with self.assertRaisesRegex(RuntimeError, '受控只读检查失败') as caught:
            checkers.main(spec, failure)
        self.assertNotIn('secret', str(caught.exception))

if __name__ == '__main__': unittest.main()
