from dataclasses import replace
from decimal import Decimal
import unittest

from service.valuation import BUCKETS, CODES, Snapshot, bridge


def snapshot(day, positions, base='.80', stress='.70'):
    exact = lambda value: Decimal(str(value))
    sides = {key: side for key, (side, *_rest) in positions.items()}
    dfs = {code: dict.fromkeys(BUCKETS, exact(base if code == 'base' else stress)) for code in CODES}
    flows, actual = {}, {code: {} for code in CODES}
    for key, (side, amount, *bucket) in positions.items():
        sign = 1 if side == 'ASSET' else -1
        bucket_name = bucket[0] if bucket else '1y'
        flows[key] = {(bucket_name, 'PRINCIPAL'): exact(amount) * sign}
        for code in CODES:
            actual[code][key] = exact(amount) * sign * dfs[code][bucket_name]
    return Snapshot(day, sides, flows, dfs, actual, {'date': day, 'method': 'calendar-bucket-v1'})


class ValuationTest(unittest.TestCase):
    def first(self, positions=None, base='.80'):
        return snapshot('2026-01-31', positions or {'A': ('ASSET', 100)}, base)

    def last(self, positions=None, base='.80'):
        return snapshot('2026-02-28', positions or {'A': ('ASSET', 100)}, base)

    def test_flows_only_and_curve_only(self):
        cash = bridge(self.first(), self.last({'A': ('ASSET', 140)}))
        self.assertEqual((cash['change'], cash['cash'], cash['discount']), (32, 32, 0))
        curve = bridge(self.first(), self.last(base='.60'))
        self.assertEqual((curve['change'], curve['cash'], curve['discount']), (-20, 0, -20))

    def test_symmetry_and_joint_effect(self):
        result = bridge(self.first(), self.last({'A': ('ASSET', 120)}, '.90'))
        self.assertEqual(result['states'], {'v00': 80, 'v10': 96, 'v01': 90, 'v11': 108})
        self.assertEqual((result['cash'], result['discount'], result['joint']), (17, 11, 2))
        self.assertEqual((result['change'], result['numericalGap'], result['reconciliation']), (28, 0, 0))

    def test_entries_exits_liabilities_and_crossing_zero(self):
        initial = self.first({'A': ('ASSET', 100), 'B': ('LIABILITY', 180)})
        final = self.last({'A': ('ASSET', 100), 'C': ('LIABILITY', 30)})
        result = bridge(initial, final)
        self.assertEqual((result['start'], result['end']), (-64, 56))
        self.assertEqual((result['additions'], result['exclusions'], result['change']), (-24, 144, 120))
        self.assertIsNone(result['residual'])

    def test_zero_value_and_zero_change(self):
        positions = {'A': ('ASSET', 100), 'B': ('LIABILITY', 100)}
        result = bridge(self.first(positions), self.last(positions, '.95'))
        self.assertEqual((result['start'], result['end'], result['change'], result['reconciliation']), (0, 0, 0, 0))

    def test_stress_delta_changes_between_dates(self):
        result = bridge(self.first(), self.last({'A': ('ASSET', 120)}, '.9'), 'parallel_up')
        self.assertEqual((result['start'], result['end'], result['change']), (-10, -24, -14))
        self.assertEqual((result['cash'], result['discount'], result['joint']), (-3, -11, -2))

    def test_rejects_invalid_dates_sides_and_source_values(self):
        first, last = self.first(), self.last()
        with self.assertRaises(ValueError):
            bridge(first, replace(last, day='2026-02-30'))
        with self.assertRaises(ValueError):
            bridge(last, first)
        with self.assertRaisesRegex(ValueError, 'Сторона'):
            bridge(first, self.last({'A': ('LIABILITY', 100)}))
        with self.assertRaisesRegex(ValueError, 'не сходится'):
            bridge(first, replace(last, actual={**last.actual, 'base': {'A': Decimal('81')}}))


if __name__ == '__main__':
    unittest.main()
