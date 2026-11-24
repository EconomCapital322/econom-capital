"""Exact portfolio bridges over signed relative-bucket cash flows."""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, localcontext
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path

from .integration import CODES, SCENARIOS, curve_metadata, read_rows, validated_snapshot_curves
from normalizer.discounting import LABELS as BUCKETS, bucket_for

ZERO = Decimal(0)
TOLERANCE = Decimal('0.000001')
METHOD = 'calendar-bucket-v1'
FILES = (
    'calculator_input.csv', 'core/cashflows.csv', 'core/deal_summary.csv',
    'core/discounted_deal_summary.csv', 'curves/standard-result.json',
)


@dataclass(frozen=True)
class Snapshot:
    day: str
    sides: dict
    flows: dict
    dfs: dict
    actual: dict
    source: dict


def money(raw):
    try:
        value = Decimal(raw)
    except (InvalidOperation, TypeError) as error:
        raise ValueError('В выгрузке калькулятора есть некорректная сумма.') from error
    if not value.is_finite() or abs(value) > Decimal('1e19'):
        raise ValueError('В выгрузке калькулятора есть неконечная сумма или сумма вне допустимого диапазона.')
    return value


def report_date(text):
    if not isinstance(text, str):
        raise ValueError('Укажите дату в формате ГГГГ-ММ-ДД.')
    day = date.fromisoformat(text)
    if day.isoformat() != text:
        raise ValueError('Укажите дату в формате ГГГГ-ММ-ДД.')
    return day


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pv(flows, weights):
    return sum((amount * weights[bucket] for (bucket, _), amount in flows.items()), ZERO)


@lru_cache(maxsize=16)
def read_snapshot(folder, text, signature):
    """The stat signature prevents reusing a result after any tracked input changes."""
    day = report_date(text)
    try:
        raw = (folder / FILES[-1]).read_bytes()
        curve_result = validated_snapshot_curves(json.loads(raw, parse_float=Decimal), day)
        dfs = {curve['curveCode']: {point['bucketLabel']: Decimal(point['discountFactor']) for point in curve['points']}
               for curve in curve_result['curves']}
        require(all(tuple(weights) == BUCKETS for weights in dfs.values()), 'В выгрузке кривых отсутствуют бакеты согласованной сетки.')
        sides = {}
        for row in read_rows(folder / FILES[0], ';'):
            key, side = row['deal_id'], row['side']
            require(bool(key) and key not in sides, 'Во входе калькулятора пустой или повторный ID сделки.')
            require(row['currency_id'] == 'RUB' and row['report_dttm'] == text and side in ('ASSET', 'LIABILITY'),
                    'Дата, валюта или сторона сделки не соответствует снимку.')
            sides[key] = side
        rows = read_rows(folder / FILES[2])
        counts = {row['instrument_id']: int(row['flow_count']) for row in rows}
        require(bool(sides) and len(counts) == len(rows) and set(counts) == set(sides),
                'Сводка калькулятора не соответствует составу сделок во входном файле.')
        flows = {key: defaultdict(Decimal) for key in sides}
        loaded = dict.fromkeys(sides, 0)
        buckets = {}
        for row in read_rows(folder / FILES[1]):
            key, date_text, kind = row['instrument_id'], row['payment_date'], row['cash_flow_type']
            require(key in sides and bool(kind), 'Денежный поток не связан со сделкой или отсутствует тип платежа.')
            if date_text not in buckets:
                buckets[date_text] = bucket_for(report_date(date_text), day)
            amount = money(row['amount'])
            require(amount >= ZERO, 'Калькулятор должен передавать сумму платежа до применения знака сделки.')
            flows[key][buckets[date_text], kind] += amount if sides[key] == 'ASSET' else -amount
            loaded[key] += 1
        require(loaded == counts, 'Количество платежей не сходится со сводкой калькулятора.')
        actual = {code: {} for code in CODES}
        for row in read_rows(folder / FILES[3]):
            key, code = row['instrument_id'], row['curveCode']
            require(code in actual and key in sides and row['side'] == sides[key], 'Некорректный сценарий, ID или сторона в выгрузке PV.')
            require(key not in actual[code], 'В выгрузке PV повторяется комбинация сделки и сценария.')
            actual[code][key] = money(row['present_value'])
        with localcontext() as context:
            context.prec = 44
            for code in CODES:
                require(set(actual[code]) == set(sides), 'В выгрузке PV должны быть все семь сценариев для каждой сделки.')
                for key, value in actual[code].items():
                    require(abs(pv(flows[key], dfs[code]) - value) <= TOLERANCE,
                            'PV в выгрузке калькулятора расходится с денежными потоками и исходными DF.')
        return Snapshot(text, sides, flows, dfs, actual, {
            'date': text, 'runId': curve_result['runId'], 'sha256': sha256(raw).hexdigest(),
            'method': METHOD, 'files': list(FILES),
            **curve_metadata(curve_result),
        })
    except (KeyError, AttributeError, TypeError, UnicodeError, InvalidOperation) as error:
        raise ValueError('Некорректные колонки выгрузки расчёта. Проверьте формат истории.') from error


def load_snapshot(root: Path, text: str):
    folder = root / report_date(text).isoformat()
    try:
        signature = tuple((stat.st_size, stat.st_mtime_ns) for stat in ((folder / name).stat() for name in FILES))
        with localcontext() as context:
            context.prec = 44
            return read_snapshot(folder, text, signature)
    except FileNotFoundError as error:
        raise ValueError(f'{text}. Нужны совместимые выгрузки платежей, PV и кривых на выбранную дату.') from error
    except ValueError as error:
        raise ValueError(f'{text}. {error}') from error


def weights(snapshot, scenario):
    return snapshot.dfs['base'] if scenario == 'base' else {
        bucket: value - snapshot.dfs['base'][bucket] for bucket, value in snapshot.dfs[scenario].items()
    }


def actual_pv(snapshot, key, scenario):
    value = snapshot.actual[scenario][key]
    return value if scenario == 'base' else value - snapshot.actual['base'][key]


def aggregate(snapshot, keys):
    result = defaultdict(Decimal)
    for key in sorted(keys):
        for cell, amount in snapshot.flows[key].items():
            result[cell] += amount
    return result


def diagnostics(first, last, common, scenario):
    cf0, cf1 = aggregate(first, common), aggregate(last, common)
    df0, df1 = weights(first, scenario), weights(last, scenario)
    v00, v10, v01, v11 = pv(cf0, df0), pv(cf1, df0), pv(cf0, df1), pv(cf1, df1)
    cash = ((v10 - v00) + (v11 - v01)) / 2
    discount = ((v01 - v00) + (v11 - v10)) / 2
    detail = []
    for bucket, kind in sorted(cf0.keys() | cf1.keys(), key=lambda cell: (BUCKETS.index(cell[0]), cell[1])):
        amount0, amount1 = cf0[bucket, kind], cf1[bucket, kind]
        avg_df = (df0[bucket] + df1[bucket]) / 2
        avg_cf = (amount0 + amount1) / 2
        detail.append({'bucket': bucket, 'kind': kind, 'cfBefore': float(amount0), 'cfAfter': float(amount1),
                       'dfBefore': float(df0[bucket]), 'dfAfter': float(df1[bucket]),
                       'cash': float((amount1 - amount0) * avg_df), 'discount': float((df1[bucket] - df0[bucket]) * avg_cf)})
    return cash, discount, v11 - v10 - v01 + v00, (v00, v10, v01, v11), detail


def describe(weights_by_bucket):
    return [{'bucket': label, 'weight': float(weights_by_bucket[label])} for label in BUCKETS]


def bridge(first, last, scenario='base'):
    if scenario not in CODES or report_date(first.day) >= report_date(last.day):
        raise ValueError('Выберите сценарий и две даты в хронологическом порядке.')
    common = first.sides.keys() & last.sides.keys()
    require(all(first.sides[key] == last.sides[key] for key in common), 'Сторона сделки меняется между датами. Проверьте сопоставление ID.')
    added = last.sides.keys() - first.sides.keys()
    removed = first.sides.keys() - last.sides.keys()
    with localcontext() as context:
        context.prec = 44
        start = sum((actual_pv(first, key, scenario) for key in sorted(first.sides)), ZERO)
        end = sum((actual_pv(last, key, scenario) for key in sorted(last.sides)), ZERO)
        additions = sum((actual_pv(last, key, scenario) for key in sorted(added)), ZERO)
        exclusions = -sum((actual_pv(first, key, scenario) for key in sorted(removed)), ZERO)
        cash, discount, joint, states, detail = diagnostics(first, last, common, scenario)
        v00, _, _, v11 = states
        arithmetic = v11 - v00 - cash - discount
        reconciliation = end - start - additions - exclusions - cash - discount
        require(abs(arithmetic) <= TOLERANCE and abs(reconciliation) <= TOLERANCE,
                'Сумма эффектов не сходится с фактическим изменением по выгрузкам калькулятора.')
        actual0 = sum((actual_pv(first, key, scenario) for key in sorted(common)), ZERO)
        actual1 = sum((actual_pv(last, key, scenario) for key in sorted(common)), ZERO)
        require(max(abs(v00 - actual0), abs(v11 - actual1)) <= TOLERANCE,
                'Начальный или конечный расчёт по общим сделкам не сходится с выгрузкой.')
        exact = dict(zip(('v00', 'v10', 'v01', 'v11'), states, strict=True))
        balances = [start, end, end - start, additions, exclusions, cash, discount, joint, reconciliation]
        values = dict(zip(('start', 'end', 'change', 'additions', 'exclusions', 'cash', 'discount', 'joint', 'reconciliation'), balances, strict=True))
    target = 'npv' if scenario == 'base' else 'stress_delta'
    unit = '₽'
    return {
        **{key: float(value) for key, value in values.items()},
        'decimal': {key: str(value) for key, value in {**values, **exact}.items()},
        'before': first.day, 'after': last.day, 'mode': 'valuation', 'method': METHOD, 'unit': unit,
        'target': target, 'scenario': scenario, 'matched': len(common), 'added': len(added), 'removed': len(removed),
        'states': {key: float(value) for key, value in exact.items()}, 'numericalGap': float(arithmetic),
        'status': 'verified', 'tolerance': float(TOLERANCE), 'reliable': True,
        'residual': None, 'quality': [], 'warnings': [], 'reconciliationBasis': 'discounted_deal_summary.csv',
        'factors': [{'key': 'cash_effect', 'value': float(cash)}, {'key': 'discount_effect', 'value': float(discount)}],
        'interactions': [], 'effects': [], 'importance': [], 'buckets': detail,
        'weightsBefore': describe(weights(first, scenario)), 'weightsAfter': describe(weights(last, scenario)),
        'sources': [first.source, last.source],
        'limitations': ['Эффект потоков объединяет изменения договоров, погашения и перенос оставшихся платежей по срокам.',
                        'Невязка проверяет согласованность арифметики с выгрузкой. Применимость банковской методики проверяется отдельно.'],
    }


def analyze_valuation(folder, periods, before=None, after=None, scenario='base'):
    days = sorted(period['date'] for period in periods)
    require(len(days) >= 2 and len(days) == len(set(days)), 'Для расчётного режима нужны минимум два снимка на разные даты.')
    before, after = before or days[-2], after or days[-1]
    require(before in days and after in days and before < after, 'Выберите две имеющиеся даты в хронологическом порядке.')
    snapshots = [load_snapshot(folder, day) for day in days]
    lookup = {item.day: item for item in snapshots}
    result = bridge(lookup[before], lookup[after], scenario)
    result['timeline'] = [{'date': s.day, 'count': len(s.sides),
                           'value': float(sum((actual_pv(s, key, scenario) for key in s.sides), ZERO))} for s in snapshots]
    result['profile'] = {'dates': days}
    result['scenarioLabel'] = SCENARIOS[scenario]
    return result
