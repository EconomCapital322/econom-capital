import csv
from datetime import date
from io import StringIO
import math
import unittest

import numpy as np

from service.attribution import analyze
from service.effects import form
from service.panel import extract_csv

FIELDS = {'dateColumn': 't', 'idColumn': 'k', 'target': 'y', 'unit': 'шт.'}


def fixture(kind, *, leading=0, altered=False):
    rng = np.random.default_rng(7304)
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(['t', 'k', 'y', *[f'random_{n:02d}' for n in range(leading)], 'size', 'rate', 'group',
                     'copy_metric', 'next_target', 'corr_proxy'])
    for month in range(1, 9):
        for i in range(120):
            x, z = rng.uniform(0, 10, 2)
            category = i % 3
            value = {
                'linear': 100 + 5 * x - 3 * z,
                'u': 100 + 4 * (x - 3)**2 + z * .3,
                'inverted_u': 100 - 4 * (x - 5)**2 + z * .3,
                'threshold': 100 + 20 * max(0, x - 5) + .05 * z,
                'saturation': 100 + 50 * (1 - math.exp(-x)) + .1 * z,
                'cross': 100 + 5 * x + 8 * x * z,
                'mixed': 100 + 5 * x - 3 * z + 8 * x * category + 4 * (x - 3)**2 + rng.normal(),
                'categorical': 100 + 40 * category + x + z,
                'drift': 100 + 5 * x + z,
                'null': 60.,
            }[kind]
            if kind == 'drift' and month >= 7:
                x += 20
            if altered and month >= 7:
                value = -1000 * value - 15 * x
            noise = rng.normal(size=leading)
            writer.writerow([f'2026-{month:02d}-15', i, value, *noise, x, z, f'group-{category}', 2 * value + 7,
                             value / 3, x + rng.normal(scale=.04)])
    return extract_csv(buffer.getvalue())


class MLDiagnosticsTest(unittest.TestCase):
    def test_shapes_grid_and_insufficient_support(self):
        x = np.linspace(0, 10, 11)
        support = np.arange(10, 21)
        cases = {'linear': 4*x, 'u': (x-3)**2, 'inverted_u': -(x-5)**2,
                 'threshold': np.maximum(0, x-5), 'saturation': 1-np.exp(-x)}
        for expected, y in cases.items():
            with self.subTest(expected=expected):
                self.assertEqual(form(x, y, support, 1)[0], expected)
        self.assertEqual(form(x[:4], x[:4], support[:4], 1)[0], 'unconfirmed')
        self.assertEqual(form(x, 0*x, support, 1)[0], 'unconfirmed')

    def test_ale_detects_supported_curves_in_real_fitted_models(self):
        for expected in ('u', 'inverted_u', 'threshold', 'saturation'):
            with self.subTest(expected=expected):
                report = analyze(fixture(expected), {**FIELDS, 'features': ['size', 'rate']})
                effect = next(row for row in report['effects'] if row['key'] == 'size')
                self.assertEqual(effect['shape'], expected, effect)
                self.assertGreaterEqual(effect['stability'], .7)
                self.assertGreaterEqual(effect['support'], 100)

    def test_temporal_training_excludes_both_comparison_dates_and_future_proxies(self):
        report = analyze(fixture('linear', leading=18), FIELDS, diagnostics=False)
        altered = analyze(fixture('linear', leading=18, altered=True), FIELDS, diagnostics=False)
        self.assertEqual(report['model'], altered['model'])
        self.assertEqual(report['selectedFeatures'], altered['selectedFeatures'])
        self.assertEqual(report['quality'], altered['quality'])
        self.assertNotEqual(report['validation'], altered['validation'])
        self.assertIn('size', report['selectedFeatures'])
        audit = {row['name']: row for row in report['featureAudit']}
        self.assertFalse(audit['copy_metric']['eligible'])
        self.assertFalse(audit['next_target']['eligible'])
        self.assertTrue(any('Вне первых' in (row['reason'] or '') for row in audit.values()))
        self.assertEqual({row['date'] for row in report['validation']}, {report['before'], report['after']})
        self.assertLess(max(row['date'] for row in report['quality']), report['before'])
        self.assertAlmostEqual(report['modelChange'], sum(item['value'] for item in report['factors']), places=6)
        self.assertEqual(report['unit'], 'шт.')

    def test_pair_and_category_and_correlation(self):
        cross = analyze(fixture('cross'), {**FIELDS, 'features': ['size', 'rate', 'group']})
        self.assertEqual({cross['interactions'][0][key] for key in ('a', 'b')}, {'size', 'rate'})
        self.assertIsNotNone(cross['interactions'][0]['portfolioChange'])
        mixed = analyze(fixture('mixed'), FIELDS)
        self.assertTrue(any({'size', 'corr_proxy'} <= set(group) for group in mixed['correlated']))
        category = analyze(fixture('categorical'), FIELDS)
        self.assertEqual(max(category['importance'], key=lambda row: row['meanAbsShap'])['key'], 'group')
        self.assertEqual(next(item for item in category['effects'] if item['key'] == 'group')['kind'], 'category')

    def test_drift_and_no_signal_and_manual_exclusions(self):
        result = analyze(fixture('drift'), {**FIELDS, 'forbidden': ['corr_proxy']}, diagnostics=False)
        self.assertIn('size', [row['key'] for row in result['drift']])
        self.assertNotIn('corr_proxy', result['selectedFeatures'])
        null = analyze(fixture('null'), FIELDS, diagnostics=False)
        self.assertEqual(null['model']['key'], 'median')
        self.assertEqual(null['modelChange'], 0)
        self.assertIn(null['status'], ('caution', 'insufficient'))
        with self.assertRaisesRegex(ValueError, 'суммируемую'):
            analyze(fixture('linear'), {**FIELDS, 'aggregation': 'mean'})

    def test_date_shared_features_are_checked_as_blocks(self):
        history = StringIO()
        rows = csv.writer(history)
        rng = np.random.default_rng(17)
        rows.writerow(['t', 'k', 'y', 'common_level', 'individual'])
        for month, level in enumerate(rng.uniform(2, 9, 14)):
            day = date(2025 + month // 12, month % 12 + 1, 15)
            for i, value in enumerate(rng.normal(size=45)):
                rows.writerow([day, i, 500 + 50 * level + 4 * value, level, value])
        report = analyze(extract_csv(history.getvalue()), FIELDS)
        grouped = report['marketImportance']
        self.assertEqual(grouped['keys'], ['common_level'])
        self.assertEqual(len(grouped['dates']), 8)
        self.assertLess(grouped['trainedThrough'], min(grouped['dates']))
        self.assertLess(max(grouped['dates']), report['before'])
        self.assertGreater(grouped['value'], 0)
        self.assertIsNone(next(item['value'] for item in report['importance'] if item['key'] == 'common_level'))


if __name__ == '__main__':
    unittest.main()
