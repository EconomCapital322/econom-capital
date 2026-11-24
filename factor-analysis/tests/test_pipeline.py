import csv
from datetime import date, timedelta
from decimal import Decimal
from io import StringIO
import json
import math
import os
from pathlib import Path
from shutil import copytree
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from service import server
from service.cash_details import calculate_cash_details
from service.explanations import explain
from service.history import pack, unpack
from service.integration import CODES, core_path, portfolio_history, read_rows, run, write_rows
from service.reporting import export
from service.valuation import FILES, TOLERANCE, analyze_valuation, load_snapshot
from normalizer.curves import CurvesError
from normalizer.discounting import discount_flows

SETTINGS = {'valuationDate': '2026-10-30', 'periods': 4, 'count': 24, 'monthly': 4, 'seed': '4317',
            'liabilityShare': 30, 'demoCurves': True}


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            core_path()
        except ValueError:
            if os.environ.get('SPECTRUM_REQUIRE_CORE_IN_TESTS') == '1':
                raise
            raise unittest.SkipTest('Build cfcore or set SPECTRUM_CFCORE for integration tests.')
        cls.tmp = TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.data = Path(cls.tmp.name)
        cls.update = staticmethod(lambda *_: None)
        with patch.object(server, 'DATA', cls.data):
            cls.workspace = server.save_integration(SETTINGS, cls.update)
        cls.folder = cls.data / cls.workspace['id']

    def test_offline_fixture_runs_actual_cpp_and_all_scenarios(self):
        work = self.workspace
        self.assertEqual([item['deals'] for item in work['periods']], [24, 28, 32, 36])
        self.assertTrue(all(item['curveSource'] == 'fixture' and len(item['scenarios']) == 7 for item in work['periods']))
        report = work['report']
        self.assertEqual(report['mode'], 'valuation')
        self.assertEqual(report['status'], 'verified')
        snapshot = load_snapshot(self.folder, report['after'])
        self.assertEqual(snapshot.source['curveProvenance'], 'synthetic')
        self.assertIn('LIABILITY', snapshot.sides.values())
        self.assertTrue(any(value < 0 for value in snapshot.actual['base'].values()))
        self.assertAlmostEqual(report['change'], math.fsum([report['cash'], report['discount'], report['additions'], report['exclusions']]), places=6)
        self.assertTrue(all(item.get('sha256') for item in report['sources']))
        with patch.dict(os.environ, {'SPECTRUM_LLM_ENABLED': '0'}):
            answer = explain(work, 'Как повлияло изменение кривой?')
        self.assertEqual(answer['analysisId'], report['analysisId'])
        self.assertTrue(any('дисконтирования' in item['text'] for item in answer['facts']))

    def test_history_roundtrip_and_switches_scenario_without_cpp(self):
        work = self.workspace
        raw = pack(self.folder, work['periods'], 'synthetic')
        folder = self.data / 'roundtrip'
        folder.mkdir()
        with patch('service.integration.run', side_effect=AssertionError('Should not invoke C++ again')):
            details = unpack(raw, folder, self.update)
            self.assertEqual(details['portfolioSource'], 'synthetic')
            self.assertEqual(details['periods'][-1]['sha256'], work['periods'][-1]['sha256'])
            with patch.object(server, 'DATA', self.data):
                panel = server.extract_csv(server.text_of(folder))
                for code in CODES[1:]:
                    imported = server.compute(folder, panel, {'id': folder.name, **details},
                                              {'mode': 'valuation', 'target': 'stress_delta', 'scenario': code})
                    report = imported['report']
                    self.assertEqual(report['scenario'], code)
                    expected = next(line['delta'] for line in work['periods'][-1]['scenarios'] if line['code'] == code)
                    self.assertAlmostEqual(report['end'], expected, places=6)

    def test_cash_details_replay_changed_contract_and_reconcile_base_and_stress(self):
        work = self.workspace
        periods = work['periods'][-2:]
        before, after = [item['date'] for item in periods]
        with TemporaryDirectory(dir=self.data) as name:
            folder = Path(name)
            for day in (before, after):
                copytree(self.folder / day, folder / day)
            initial = load_snapshot(folder, before)
            source = folder / after / FILES[0]
            rows = read_rows(source, ';')
            deal = next(row for row in rows if row['deal_id'] in initial.sides and
                        row['rate_type_cd'] == 'FIXED' and row['discriminator'] == 'ANN')
            deal['current_principal_amt'] = str((Decimal(deal['current_principal_amt']) * Decimal('.95')).quantize(Decimal('.01')))
            deal['interest_rate'] = str(Decimal(deal['interest_rate']) + Decimal('.01'))
            deal['maturity_dttm'] = (date.fromisoformat(deal['maturity_dttm']) + timedelta(days=90)).isoformat()
            write_rows(source, rows, rows[0].keys(), ';')
            output = folder / after / 'core'
            run([str(core_path()), '--input', str(source), '--output-dir', str(output), '--threads', '2'])
            curves = json.loads((folder / after / FILES[-1]).read_bytes(), parse_float=Decimal)
            discount_flows(output, source, curves, 'all')

            for scenario in ('base', 'parallel_up'):
                report = analyze_valuation(folder, periods, scenario=scenario)
                detail = calculate_cash_details(folder, report, self.update)
                with self.subTest(scenario=scenario):
                    parts = {part['key']: Decimal(part['decimal']) for part in detail['parts']}
                    self.assertEqual(detail['covered'], report['matched'])
                    self.assertEqual(detail['recalculations'], 9)
                    for key in ('paid_principal', 'calendar_shift', 'balance', 'rate', 'schedule'):
                        self.assertGreater(abs(parts[key]), TOLERANCE)
                    self.assertLess(abs(sum(parts.values()) - Decimal(report['decimal']['cash'])), TOLERANCE)
                    self.assertEqual(parts['undivided'], 0)
            with patch('service.cash_details.core_path', side_effect=ValueError('Нет C++')):
                limited = calculate_cash_details(folder, report, self.update)
            self.assertEqual(limited['covered'], 0)
            self.assertEqual(limited['excluded'][0]['count'], report['matched'])
            self.assertLess(abs(sum(Decimal(part['decimal']) for part in limited['parts']) - Decimal(report['decimal']['cash'])), TOLERANCE)

    def test_diagnostics_persist_with_the_revision_and_exports_escape_report_text(self):
        work = self.workspace
        revision = {'workspaceId': work['id'], 'analysisId': work['report']['analysisId']}
        with patch.object(server, 'DATA', self.data):
            server.publish(self.folder, work)
            detailed = server.analysis_task(revision, diagnostics=True)
        report = detailed['report']
        detail = report['cashDetails']
        self.assertEqual(report['analysisId'], revision['analysisId'])
        self.assertEqual(detail['covered'], report['matched'])
        self.assertEqual(detail['newlyIssued']['count'], report['added'])
        with patch.dict(os.environ, {'SPECTRUM_LLM_ENABLED': '0'}):
            answer = explain(detailed, 'Как повлияли погашения?')
        self.assertEqual(answer['facts'][0]['id'], 'cash_part_paid_principal')
        self.assertEqual(answer['facts'][0]['source'], '#cash-details')
        report = {**report, 'labels': {report['target']: '<img src=x onerror=alert(1)>'}}
        content, mime = export(report, 'analysis.html', answer)
        html = content.decode()
        self.assertEqual(mime, 'text/html')
        self.assertNotIn('<img', html)
        self.assertIn('&lt;img', html)
        self.assertIn('Детализация денежных потоков', html)
        self.assertIn('Пояснение по проверенным фактам', html)
        content, mime = export(report, 'cash-details.csv')
        rows = list(csv.DictReader(StringIO(content.decode('utf-8-sig'))))
        self.assertEqual(mime, 'text/csv')
        self.assertEqual(len(rows), len(detail['parts']))
        self.assertEqual(rows[0]['value'], detail['parts'][0]['decimal'])
        with self.assertRaises(FileNotFoundError):
            export(work['report'], 'cash-details.csv')

    def test_snapshot_rejects_missing_buckets_and_duplicate_id(self):
        existing = self.workspace['periods'][-1]['date']
        before = self.folder / existing
        with TemporaryDirectory() as temp:
            root = Path(temp)
            day = root / existing
            for key in FILES:
                path = day / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((before / key).read_bytes())
            path = day / FILES[0]
            original = path.read_text()
            path.write_text(original + original.splitlines()[1] + '\n')
            with self.assertRaisesRegex(ValueError, 'повторный ID'):
                load_snapshot(root, existing)
            path.write_text(original)
            curves = day / FILES[-1]
            payload = json.loads(curves.read_bytes())
            for curve in payload['curves']:
                curve['points'].pop()
            curves.write_text(json.dumps(payload))
            with self.assertRaisesRegex(ValueError, 'бакеты'):
                load_snapshot(root, existing)

    def test_reports_both_upstream_errors_without_publishing(self):
        with TemporaryDirectory() as temp:
            data = Path(temp)
            with patch('service.integration.CurvesClient.result', side_effect=CurvesError('Нет публикации MOEX')):
                with self.assertRaisesRegex(ValueError, 'Нет публикации'):
                    portfolio_history({**SETTINGS, 'demoCurves': False}, data, self.update)
            with patch('service.integration.core_path', side_effect=ValueError('Калькулятор не найден')):
                with self.assertRaisesRegex(ValueError, 'Калькулятор не найден'):
                    portfolio_history(SETTINGS, data, self.update)

    def test_unsupported_default_settings_and_existing_result_are_safe(self):
        work = self.workspace
        with patch.object(server, 'DATA', self.data):
            panel = server.extract_csv(server.text_of(self.folder))
            server.publish(self.folder, work)
            with self.assertRaisesRegex(ValueError, 'NPV или ΔPV'):
                server.compute(self.folder, panel, work, {'mode': 'valuation', 'target': 'interest12'})
            self.assertEqual(server.current()['report']['analysisId'], work['report']['analysisId'])
            with self.assertRaises(server.StaleReport):
                server.active_revision(work, {'analysisId': 'e' * 32})


if __name__ == '__main__':
    unittest.main()
