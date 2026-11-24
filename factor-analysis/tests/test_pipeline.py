import json
import math
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from service import server
from service.explanations import explain
from service.history import pack, unpack
from service.integration import CODES, core_path, portfolio_history
from service.valuation import FILES, load_snapshot
from normalizer.curves import CurvesError

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
