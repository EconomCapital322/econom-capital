"""Versioned analytical exports and spreadsheet-safe text cells."""

import csv
from decimal import Decimal
from html import escape
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


def factor_rows(report):
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
    return rows


def html_table(headers, rows):
    heading = ''.join(f'<th scope="col">{escape(label)}</th>' for label in headers)
    body = ''.join('<tr>' + ''.join(f'<td>{escape(str(value)) if value is not None else "—"}</td>' for value in row) + '</tr>'
                   for row in rows)
    return f'<div class="table"><table><thead><tr>{heading}</tr></thead><tbody>{body}</tbody></table></div>'


def html_report(report, ai):
    def fmt(value, precision=2):
        if value is None:
            return '—'
        return f'{Decimal(str(value)):z,.{precision}f}'.replace(',', '\xa0').replace('.', ',')

    labels = report.get('labels', {})
    target = labels.get(report['target'], report['target'])
    state = {'verified': 'Расчёт проверен', 'stable': 'Модельное объяснение устойчиво',
             'caution': 'Требуется осторожность', 'insufficient': 'Недостаточно данных',
             'unavailable': 'Анализ недоступен'}
    exact = report['mode'] == 'valuation'
    scenario = report.get('scenario')
    model = report.get('model') or {}
    portfolio_source = {'synthetic': 'Синтетический портфель', 'bank': 'Банковский портфель', 'external': 'Загруженные данные'}
    curve_source = {'market': 'Рыночные кривые', 'api': 'MOEX через API', 'saved': 'Сохранённый ответ MOEX',
                    'imported': 'Загруженные рыночные кривые', 'synthetic': 'Учебные кривые', 'fixture': 'Учебные кривые'}
    blocks = [f'<h1>{escape(target)}</h1>', html_table(['Параметр', 'Значение'], [
        ('Начальная дата', report['before']), ('Конечная дата', report['after']),
        ('Изменение', fmt(report['change'])), ('Единица измерения', report.get('unit') or 'Единицы столбца'),
        ('Метод', report['method']), ('Модель', model.get('name')), ('Сценарий', scenario),
        ('Происхождение данных', portfolio_source.get(report.get('dataSource'))),
        ('Статус', state.get(report.get('status'), report.get('status'))), ('Версия расчёта', report.get('analysisId')),
        ('Общие / новые / выбывшие наблюдения', f"{report['matched']} / {report.get('added', 0)} / {report.get('removed', 0)}"),
    ]), '<h2>Факторное разложение</h2>', html_table(['Компонент', 'Значение', '10-й процентиль', '90-й процентиль'],
        [(label, fmt(value), fmt(low), fmt(high)) for _, label, value, low, high in factor_rows(report)])]
    if detail := report.get('cashDetails'):
        blocks.extend(['<h2>Детализация денежных потоков</h2>',
                       f'<p>Проверено договорных изменений для {detail["covered"]} из {detail["common"]} общих сделок.</p>',
                       html_table(['Компонент', 'Вклад'], [(part['label'], fmt(part['decimal'])) for part in detail['parts']])])
        if detail.get('message'):
            blocks.append(f'<p>{escape(detail["message"])}</p>')
        if detail['excluded']:
            blocks.append(html_table(['Причина группировки', 'Сделок'],
                                     [(row['reason'], row['count']) for row in detail['excluded']]))
    blocks.append('<h2>Взаимодействия</h2>')
    if exact:
        blocks.append(f'<p>Совместный эффект потоков и весов {fmt(report["joint"])}. Он уже распределён между обоими вкладами.</p>')
    elif pairs := report.get('interactions'):
        blocks.append(html_table(['Первый фактор', 'Второй фактор', 'Сила в начале', 'Сила в конце', 'Изменение', 'Наблюдений'],
            [(labels.get(p['a'], p['a']), labels.get(p['b'], p['b']), fmt(p['strengthBefore']), fmt(p['strength']),
              fmt(p['change']), p['rows']) for p in pairs]))
    elif report.get('diagnosticsReady') is False:
        blocks.append('<p>Детализация взаимодействий ещё не рассчитана.</p>')
    else:
        blocks.append('<p>Оценённых взаимодействий в отчёте нет.</p>')
    if validation := report.get('validation'):
        blocks.extend(['<h2>Качество модели на датах сравнения</h2>',
                       html_table(['Дата', 'MAE', 'RMSE', 'R²', 'Наблюдений', 'Ошибка суммы'],
                                  [(row['date'], fmt(row['mae']), fmt(row['rmse']), fmt(row['r2'], 4), row['rows'],
                                    fmt(row['aggregateError'])) for row in validation])])
    if limits := list(dict.fromkeys([*report.get('limitations', []), *report.get('warnings', [])])):
        blocks.append('<h2>Ограничения</h2><ul>' + ''.join(f'<li>{escape(line)}</li>' for line in limits) + '</ul>')
    blocks.extend(['<h2>Источники</h2>', html_table(['Дата', 'Запуск или файл', 'Источник кривой', 'SHA-256'],
        [(row.get('date'), row.get('runId', row.get('filename')),
          curve_source.get(row.get('curveSource') or row.get('curveProvenance')), row.get('sha256'))
         for row in report.get('sources', [])])])
    if ai and ai.get('analysisId') == report.get('analysisId') and ai.get('sections'):
        summary = ai.get('kind') == 'summary'
        blocks.append('<h2>Аналитическое резюме</h2>' if summary else '<h2>Пояснение по проверенным фактам</h2>')
        for section in ai['sections']:
            if not summary or section['title'] != 'Аналитическое резюме':
                blocks.append(f'<h3>{escape(section["title"])}</h3>')
            lines = []
            for fact in section['facts']:
                references = list(dict.fromkeys(ref['title'] for ref in fact.get('sources', [])))
                sources = f'<br><small>Источники · {escape(" / ".join(references))}</small>' if references else ''
                lines.append(f'<li>{escape(fact["text"])}{sources}</li>')
            blocks.append('<ul>' + ''.join(lines) + '</ul>')
    return ('''<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Спектр · Отчёт анализа</title><style>
body{font:1rem/1.55 system-ui,sans-serif;color:#172923;background:#f8faf9;margin:2rem auto;padding:0 1rem;max-width:72rem}
h1,h2,h3{line-height:1.2}h2{margin-top:2rem}.table{overflow:auto}table{border-collapse:collapse;width:100%;background:white}
td,th{text-align:left;vertical-align:top;border-bottom:1px solid #d9e3de;padding:.55rem .75rem;overflow-wrap:anywhere}
th{background:#e5efeb}@media print{body{background:white;margin:0}.table{overflow:visible}}
</style><main>''' + ''.join(blocks) + '</main></html>').encode('utf-8')


def export(report, filename, ai=None):
    if filename == 'analysis.json':
        return (json.dumps({**report, 'aiSummary': ai}, ensure_ascii=False, indent=2, allow_nan=False).encode(),
                'application/json')
    if filename == 'analysis.html':
        return html_report(report, ai), 'text/html'
    if filename == 'factors.csv':
        metadata = (report['target'], report['before'], report['after'], report['method'], report.get('unit', ''))
        return csv_bytes([('key', 'label', 'value', 'low', 'high', 'target', 'before', 'after', 'method', 'unit'),
                          *[(*line, *metadata) for line in factor_rows(report)]]), 'text/csv'
    if filename == 'cash-details.csv' and (detail := report.get('cashDetails')) is not None:
        metadata = (detail['method'], report['before'], report['after'], report.get('unit', ''), detail['covered'], detail['common'])
        return csv_bytes([('key', 'label', 'value', 'method', 'before', 'after', 'unit', 'covered', 'common'),
                          *[(part['key'], part['label'], part['decimal'], *metadata) for part in detail['parts']]]), 'text/csv'
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
