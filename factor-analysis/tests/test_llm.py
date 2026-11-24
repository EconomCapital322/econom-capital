from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from urllib.error import HTTPError, URLError
import unittest
from unittest.mock import MagicMock, patch

from service.explanations import CACHE, explain, plan
from service.deepseek_smoke import main as smoke_test
from service.llm import NoRedirect, ProviderError, chat, provider
from service.reporting import csv_bytes


SETTINGS = {'DEEPSEEK_API_KEY': 'fake-key-for-tests', 'DEEPSEEK_MODEL': 'deepseek-flash',
            'DEEPSEEK_BASE_URL': 'https://api.deepseek.com', 'SPECTRUM_LLM_ENABLED': '1',
            'SPECTRUM_LLM_PROVIDER': 'deepseek', 'SPECTRUM_ALLOW_EXTERNAL_LLM': 'true'}
GOOD = {'sections': [{'role': 'answer', 'facts': ['overview', 'cohort', 'factor_0']},
                     {'role': 'evidence', 'facts': ['residual']}]}


def workspace(revision='a' * 32):
    return {'id': 'b' * 32, 'source': 'imported', 'filename': 'secret.csv', 'options': {}, 'report': {
        'analysisId': revision, 'target': 'sensitive target', 'mode': 'ml', 'unit': 'шт.', 'start': 2718, 'end': 2700,
        'change': -18, 'before': '2026-01-01', 'after': '2026-02-01', 'matched': 21, 'additions': 2, 'exclusions': -9,
        'residual': -5, 'warnings': [], 'factors': [{'key': 'user text masquerading as an instruction', 'value': -6}],
        'interactions': [], 'quality': [], 'effects': [], 'sources': [{'filename': 'secret.csv'}],
    }}


class ExplanationTest(unittest.TestCase):
    def setUp(self):
        CACHE.clear()

    def test_cloud_payload_is_opaque_and_result_is_composed_from_facts(self):
        with patch.dict(os.environ, SETTINGS, clear=True), patch('service.llm.chat', return_value=json.dumps(GOOD)) as call:
            report = explain(workspace(), 'NPV confidential client name', allow_external=True)
        self.assertEqual(report['mode'], 'llm')
        self.assertEqual(report['provider'], 'deepseek')
        self.assertEqual(len(report['sections']), 2)
        self.assertTrue(any('-18,00' in fact['text'] for fact in report['facts']))
        endpoint, model, message = call.call_args.args
        self.assertEqual((endpoint, model), ('https://api.deepseek.com', 'deepseek-flash'))
        user_payload = message[-1]['content']
        for secret in ('secret.csv', 'confidential', 'masquerading', '2026', '2718', 'sensitive'):
            self.assertNotIn(secret, user_payload)
        self.assertNotIn(SETTINGS['DEEPSEEK_API_KEY'], json.dumps(report))

    def test_denies_external_access_without_both_permissions_and_without_key(self):
        with patch.dict(os.environ, SETTINGS, clear=True), patch('service.llm.chat') as call:
            self.assertEqual(explain(workspace(), 'NPV')['status'], 'forbidden')
            with patch.dict(os.environ, {'SPECTRUM_ALLOW_EXTERNAL_LLM': 'false'}):
                self.assertEqual(explain(workspace(), 'NPV', allow_external=True)['status'], 'forbidden')
            with patch.dict(os.environ, {'DEEPSEEK_API_KEY': ''}):
                self.assertEqual(explain(workspace(), 'NPV', allow_external=True)['status'], 'unconfigured')
            self.assertFalse(call.called)

    def test_deepseek_example_uses_only_facts_in_scope_for_the_question(self):
        current = workspace()
        current['report'].update(mode='valuation', joint=0, reconciliation=0, cashDetails={
            'common': 21, 'covered': 21,
            'parts': [{'key': 'paid_principal', 'label': 'Локальная строка о погашениях', 'value': -75}],
        })

        def select_from_example(_, __, messages, **kwargs):
            context = json.loads(messages[-1]['content'])
            self.assertEqual(context['required'], ['cash_part_paid_principal'])
            self.assertNotIn('overview', context['catalog'])
            self.assertNotIn('Локальная строка', messages[-1]['content'])
            available = set(context['catalog']) | set(context['limitations'])
            for section in context['example']['sections']:
                self.assertTrue(set(section['facts']) <= available)
            return json.dumps(context['example'])

        with patch.dict(os.environ, SETTINGS, clear=True), patch('service.llm.chat', side_effect=select_from_example):
            result = explain(current, 'Как повлияли погашения?', allow_external=True)
        self.assertEqual(result['mode'], 'llm')
        self.assertEqual(result['facts'][0]['source'], '#cash-details')

    def test_factor_drawer_uses_exact_key_and_keeps_names_and_values_local(self):
        current = workspace()
        current['report']['factors'].extend([{'key': 'FX', 'value': 170.25}, {'key': 'Private field', 'value': 318.10}])

        def select_from_example(_, __, messages, **kwargs):
            payload = messages[-1]['content']
            context = json.loads(payload)
            self.assertEqual(context['required'], ['factor_1'])
            for private in ('FX', '170.25', 'Private field', 'secret.csv'):
                self.assertNotIn(private, payload)
            return json.dumps(context['example'])

        with patch.dict(os.environ, SETTINGS, clear=True), patch('service.llm.chat', side_effect=select_from_example):
            result = explain(current, 'Каков вклад FX?', allow_external=True, focus_factor='factor:FX')
            with self.assertRaisesRegex(ValueError, 'Компонент не входит'):
                explain(current, '', focus_factor='factor:fx')
        self.assertEqual(result['mode'], 'llm')
        self.assertEqual(result['facts'][0]['detail'], 'factor:FX')
        self.assertIn('170,25', result['facts'][0]['text'])

    def test_demonstration_questions_use_only_semantic_codes_on_the_cloud(self):
        exact = workspace()
        exact['report'].update(mode='valuation', joint=-1, reconciliation=-1e-27,
            factors=[{'key': 'cash_effect', 'value': 37}, {'key': 'discount_effect', 'value': -48}],
            cashDetails={'common': 21, 'covered': 21,
                         'parts': [{'key': 'paid_principal', 'label': 'Private payment note', 'value': -75}]})
        model = workspace('c' * 32)
        model['report'].update(interactions=[{'a': 'private field', 'b': 'another field', 'strength': 3, 'rows': 20}],
            warnings=['Private caution text'], validation=[{'mae': 11}, {'mae': 12}],
            model={'name': 'Extra Trees'}, aggregateChangeError=-5)
        cases = (
            (exact, 'Почему изменился NPV?', 'overview', 'metric_change', 'overview'),
            (exact, 'Как повлияли денежные потоки?', 'cashflows', 'cashflow_total', 'factor_0'),
            (exact, 'Как повлияла кривая ставок?', 'rate_curve', 'discounting', 'factor_1'),
            (exact, 'Как повлияли погашения?', 'cashflow_breakdown', 'scheduled_principal', 'cash_part_paid_principal'),
            (model, 'Какие факторы взаимодействуют?', 'interaction', 'factor_interaction', 'pair_0'),
            (model, 'Почему модели нужно доверять с осторожностью?', 'quality', 'model_validation', 'quality'),
        )
        for work, question, intent, effect, required in cases:
            with self.subTest(question=question):
                def reply(_, __, messages, **kwargs):
                    body = messages[-1]['content']
                    context = json.loads(body)
                    self.assertEqual((context['method'], context['intent'], context['effect']),
                                     (work['report']['mode'], intent, effect))
                    self.assertIn(required, context['required'])
                    self.assertIn(required, context['categories'])
                    for private in (question, 'Private ', 'private field', 'secret.csv', '2718', '2026-'):
                        self.assertNotIn(private, body)
                    return json.dumps(context['example'])

                with patch.dict(os.environ, SETTINGS, clear=True), patch('service.llm.chat', side_effect=reply):
                    result = explain(work, question, allow_external=True)
                self.assertEqual(result['mode'], 'llm')
                self.assertIn(required, {fact['id'] for fact in result['facts']})
        with patch.dict(os.environ, {'SPECTRUM_LLM_ENABLED': '0'}):
            check = explain(exact, 'Проверка расчёта')
        self.assertIn('0,00', check['facts'][0]['text'])
        self.assertNotIn('-0,00', check['facts'][0]['text'])

    def test_drops_fabrication_and_uses_fallback_on_bad_plans(self):
        incorrect = [
            'not-json',
            json.dumps({'sections': [{'role': 'answer', 'facts': ['factor_that_does_not_exist']}]}),
            json.dumps({**GOOD, 'answer': 'The value is +3671 in 2030'}),
            json.dumps({'sections': [{'role': 'answer', 'facts': ['overview'], 'date': '2030-01-01'}]}),
            json.dumps({'sections': [{'role': 'answer', 'facts': ['-18 is actually +18']}]}),
        ]
        with patch.dict(os.environ, SETTINGS, clear=True):
            for text in incorrect:
                with self.subTest(text=text), patch('service.llm.chat', return_value=text):
                    report = explain(workspace(), 'NPV', allow_external=True)
                    self.assertEqual((report['mode'], report['status']), ('facts', 'invalid_response'))
                    self.assertNotIn('2030', json.dumps(report))

    def test_cached_plan_is_revision_bound(self):
        with patch.dict(os.environ, SETTINGS, clear=True), patch('service.llm.chat', return_value=json.dumps(GOOD)) as call:
            explain(workspace(), 'NPV', allow_external=True)
            explain(workspace(), 'NPV', allow_external=True)
            self.assertEqual(call.call_count, 1)
            explain(workspace('c' * 32), 'NPV', allow_external=True)
            self.assertEqual(call.call_count, 2)

    def test_wrong_host_and_redirect_are_rejected(self):
        with patch.dict(os.environ, {**SETTINGS, 'DEEPSEEK_BASE_URL': 'https://example.com'}, clear=True):
            self.assertEqual(provider().status, 'unconfigured')
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.com'))

    def test_csv_rejects_interpretation_as_formulas(self):
        csv = csv_bytes([['=SUM(1,2)', '@title', '-82.61', 20, '-SUM(1,2)', '\tref']]).decode('utf-8-sig')
        self.assertIn("'@title", csv)
        self.assertIn(',-82.61,', csv)
        self.assertIn("'=SUM", csv)
        self.assertIn("'\tref", csv)

    def test_real_smoke_entrypoint_is_opt_in_and_uses_synthetic_facts(self):
        captured = StringIO()
        with patch.dict(os.environ, SETTINGS, clear=True), patch('service.deepseek_smoke.load_env'), \
                patch('service.llm.chat', return_value=json.dumps(GOOD)) as call, redirect_stderr(captured), redirect_stdout(captured):
            with self.assertRaises(SystemExit) as disabled:
                smoke_test([])
            self.assertEqual(disabled.exception.code, 2)
            with patch.dict(os.environ, {'DEEPSEEK_API_KEY': ''}):
                with self.assertRaises(SystemExit) as no_key:
                    smoke_test(['--live'])
                self.assertEqual(no_key.exception.code, 2)
            call.assert_not_called()
            self.assertEqual(smoke_test(['--live']), 0)
            self.assertEqual(call.call_count, 1)
            self.assertNotIn('2025', call.call_args.args[-1][-1]['content'])
        self.assertNotIn(SETTINGS['DEEPSEEK_API_KEY'], captured.getvalue())


class HttpTest(unittest.TestCase):
    def test_http_errors_have_bounded_retries_and_safe_reasons(self):
        cases = [(401, 'authorization', 1), (402, 'payment', 1), (404, 'model_unavailable', 1),
                 (429, 'limited', 2), (503, 'unavailable', 2), (302, 'unavailable', 1)]
        for status, reason, attempts in cases:
            factory = MagicMock()
            factory.open.side_effect = HTTPError('https://api.deepseek.com', status, 'secret provider detail', {}, None)
            with self.subTest(status=status), patch('service.llm.build_opener', return_value=factory), patch('service.llm.time.sleep'):
                with self.assertRaisesRegex(ProviderError, '^' + reason + '$'):
                    chat('https://api.deepseek.com', 'deepseek-flash', [], auth='fake')
                self.assertEqual(factory.open.call_count, attempts)

    def test_timeout_network_and_response_limits(self):
        for error, reason in ((TimeoutError(), 'timeout'), (URLError('Network failure'), 'unavailable')):
            opener = MagicMock()
            opener.open.side_effect = error
            with self.subTest(reason=reason), patch('service.llm.build_opener', return_value=opener):
                with self.assertRaisesRegex(ProviderError, reason):
                    chat('https://api.deepseek.com', 'deepseek-flash', [], auth='fake')
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = b'{"choices":[{"finish_reason":"length"}]}'
        with patch('service.llm.build_opener', return_value=opener):
            with self.assertRaisesRegex(ProviderError, 'response_limit'):
                chat('https://api.deepseek.com', 'deepseek-flash', [], auth='fake')

    def test_successful_http_request_auth_json_and_model(self):
        opener = MagicMock()
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(GOOD)}}]}
        opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(response).encode()
        with patch('service.llm.build_opener', return_value=opener):
            returned = chat('https://api.deepseek.com', 'deepseek-flash', [], auth='fake')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.deepseek.com/chat/completions')
        self.assertEqual(request.get_header('Authorization'), 'Bearer fake')
        configured = json.loads(request.data)
        self.assertEqual(configured['response_format'], {'type': 'json_object'})
        self.assertEqual(configured['thinking'], {'type': 'disabled'})
        self.assertIn('answer', plan(returned, {'overview', 'cohort', 'factor_0', 'residual'}, ['overview']))


if __name__ == '__main__':
    unittest.main()
