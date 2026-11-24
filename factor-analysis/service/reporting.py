"""Versioned analytical exports and spreadsheet-safe text cells."""

import csv
from io import StringIO
import json

from .panel import number


def spreadsheet_cell(value):
    if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')) and number(value) is None:
        return "'" + value
    if isinstance(value, str) and value.startswith(('\t', '\r', '\n')):
        return "'" + value
    return value


def csv_bytes(rows, delimiter=','):
    buffer = StringIO(newline='')
    writer = csv.writer(buffer, delimiter=delimiter)
    writer.writerows([spreadsheet_cell(value) for value in row] for row in rows)
    return buffer.getvalue().encode('utf-8-sig')


def safe_dataset(path, delimiter=','):
    with path.open(encoding='utf-8-sig', newline='') as source:
        if path.name == 'dataset.csv':
            sample = source.read(4096)
            source.seek(0)
            try:
                delimiter = csv.Sniffer().sniff(sample, delimiters=',;\t').delimiter
            except csv.Error:
                delimiter = max((',', ';', '\t'), key=lambda key: sample.split('\n', 1)[0].count(key))
        return csv_bytes(csv.reader(source, delimiter=delimiter), delimiter)


def export(report, filename, ai=None):
    if filename == 'analysis.json':
        return (json.dumps({**report, 'aiSummary': ai}, ensure_ascii=False, indent=2, allow_nan=False).encode(),
                'application/json')
    if filename == 'factors.csv':
        exact = report['mode'] == 'valuation'
        labels = report.get('labels', {})
        exact_values = report.get('decimal', {})
        rows = [
            ('start', 'Начало', exact_values.get('start', report['start']), None, None),
            ('added', 'Новые сделки', exact_values.get('additions', report['additions']), None, None),
            ('removed', 'Выбывшие сделки', exact_values.get('exclusions', report['exclusions']), None, None),
        ]
        exact_keys = {'cash_effect': 'cash', 'discount_effect': 'discount'}
        rows.extend((item['key'], labels.get(item['key'], item['key']),
                     exact_values.get(exact_keys.get(item['key']), item['value']), item.get('low'), item.get('high'))
                    for item in report['factors'])
        gap = 'reconciliation' if exact else 'numericalGap'
        if not exact:
            rows.append(('residual', 'Необъяснённый остаток', report['residual'], None, None))
        rows.append((gap, 'Расчётная невязка', exact_values.get(gap, report.get(gap)), None, None))
        rows.append(('end', 'Конец', exact_values.get('end', report['end']), None, None))
        metadata = (report['target'], report['before'], report['after'], report['method'], report.get('unit', ''))
        return csv_bytes([('key', 'label', 'value', 'low', 'high', 'target', 'before', 'after', 'method', 'unit'),
                          *[(*line, *metadata) for line in rows]]), 'text/csv'
    if filename == 'interactions.csv':
        if report['mode'] == 'valuation':
            return csv_bytes([('cash_flow_factor', 'discount_factor', 'joint_already_allocated'),
                              ('cash_effect', 'discount_effect', report['decimal']['joint'])]), 'text/csv'
        fields = ('a', 'b', 'strengthBefore', 'strength', 'change', 'rows', 'population', 'low', 'high', 'stable')
        return csv_bytes([fields, *[tuple(item.get(key) for key in fields) for item in report['interactions']]]), 'text/csv'
    fields = ('date', 'mae', 'rmse', 'r2', 'rows', 'bias', 'aggregateError', 'observedTotal', 'predictedTotal')
    if filename == 'quality.csv':
        return csv_bytes([fields, *[tuple(item.get(key) for key in fields) for item in report.get('validation', [])]]), 'text/csv'
    raise FileNotFoundError(filename)
