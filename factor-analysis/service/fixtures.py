"""Explicit synthetic curve inputs for offline tests and demonstrations."""

from datetime import date
from decimal import Decimal
import json
from uuid import NAMESPACE_URL, uuid5


def curve_fixture(day: date, codes, labels):
    curves = []
    for code in codes:
        points = []
        for i, label in enumerate(labels):
            years = 1 / 365 if not i else i / 2
            level = 11 + (day.month % 7) / 3 + i / 9
            shift = {
                'base': 0, 'parallel_up': 2, 'parallel_down': -2,
                'steepener': (i - 7) / 8, 'flattener': (7 - i) / 8,
                'short_rate_up': 2 / (1 + years), 'short_rate_down': -2 / (1 + years),
            }[code]
            rate = level + shift
            points.append({'bucketLabel': label, 'tenorYears': round(years, 8), 'ratePercent': round(rate, 8),
                           'discountFactor': round((1 + rate / 100) ** -years, 12)})
        curves.append({'curveCode': code, 'points': points})
    value = {'reportDate': day.isoformat(), 'source': 'synthetic_fixture', 'dataProvenance': 'synthetic',
             'runId': str(uuid5(NAMESPACE_URL, 'spectrum-offline-example-' + day.isoformat())),
             'completedAt': day.isoformat() + 'T20:00:00Z', 'usedParameters': {'mode': 'standard', 'p': 4, 'k': 5, 'd': 3},
             'curves': curves}
    raw = json.dumps(value).encode()
    return json.loads(raw, parse_float=Decimal), raw
