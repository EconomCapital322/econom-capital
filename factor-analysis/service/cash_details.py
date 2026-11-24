"""Explain the exact cash-flow subtotal without changing valuation weights."""

from collections import Counter, defaultdict
from decimal import Decimal, localcontext
from pathlib import Path
from subprocess import TimeoutExpired
from tempfile import TemporaryDirectory

from .integration import core_path, read_rows, run, write_rows
from .valuation import BUCKETS, FILES, TOLERANCE, ZERO, load_snapshot, money, pv, report_date, weights
from normalizer.discounting import bucket_for

GROUPS = {
    'balance': ('current_principal_amt',),
    'rate': ('rate_type_cd', 'interest_rate', 'base_indicator_rate', 'cap_limit_interest_rate', 'floor_limit_interest_rate'),
    'schedule': (
        'discriminator', 'maturity_dttm', 'day_convention_cd',
        'interest_payment_rule_start_dttm', 'interest_payment_rule_period_cd', 'interest_payment_rule_day_num',
        'regular_payment_rule_start_dttm', 'regular_payment_rule_period_cd', 'regular_payment_rule_day_num',
    ),
}
EXPLICIT_FIELDS = (
    'interest_payment', 'principal_payment', 'repricing_rule_start_dttm', 'repricing_rule_period_cd',
    'repricing_rule_day_num', 'repricing_dttm_schedule', 'repricing_dttm_rate_schedule_fixed',
)
PARTS = (
    ('paid_principal', 'Погашения по прежнему графику'),
    ('paid_interest', 'Проценты по прежнему графику'),
    ('elapsed_other', 'Другие платежи по прежнему графику'),
    ('calendar_shift', 'Перенос оставшихся платежей по срокам'),
    ('rebase', 'Обновление прогноза при прежних условиях'),
    ('balance', 'Изменение остатка долга сверх прежнего графика'),
    ('rate', 'Ставка и условия её расчёта'),
    ('schedule', 'Срок, график и правила начисления'),
    ('undivided', 'Изменение прогноза без отдельного разложения'),
)


def by_id(folder, step):
    return {row['deal_id']: row for row in read_rows(folder / step / FILES[0], ';')}


def dated_flows(rows, sides):
    flows = {key: defaultdict(Decimal) for key in sides}
    for row in rows:
        key = row['instrument_id']
        if key not in sides:
            continue
        sign = -1 if sides[key] == 'LIABILITY' else 1
        flows[key][row['payment_date'], row['cash_flow_type']] += sign * money(row['amount'])
    return flows


def same_flows(left, right):
    return all(abs(left.get(cell, ZERO) - right.get(cell, ZERO)) <= TOLERANCE for cell in left.keys() | right.keys())


def old_forecast(rows, before, after, sides, avg):
    remaining = {key: defaultdict(Decimal) for key in sides}
    principal_paid = defaultdict(Decimal)
    totals = defaultdict(Decimal)
    bucket_start, bucket_end = {}, {}
    for row in rows:
        key = row['instrument_id']
        if key not in sides:
            continue
        payment = row['payment_date']
        amount = money(row['amount'])
        sign = -1 if sides[key] == 'LIABILITY' else 1
        kind = row['cash_flow_type']
        if payment not in bucket_start:
            bucket_start[payment] = bucket_for(report_date(payment), before)
        if payment <= after.isoformat():
            entry = {'PRINCIPAL': 'paid_principal', 'INTEREST': 'paid_interest'}.get(kind, 'elapsed_other')
            totals[entry] -= sign * amount * avg[bucket_start[payment]]
            if kind == 'PRINCIPAL':
                principal_paid[key] += amount
        else:
            if payment not in bucket_end:
                bucket_end[payment] = bucket_for(report_date(payment), after)
            remaining[key][bucket_end[payment], kind] += sign * amount
            totals['calendar_shift'] += sign * amount * (avg[bucket_end[payment]] - avg[bucket_start[payment]])
    return remaining, principal_paid, totals


def rolled_contract(first, last, principal_paid, day):
    if set(first) != set(last) or first.get('deal_dttm') != last.get('deal_dttm'):
        return None, 'Различаются схема входных файлов или дата выдачи'
    if any(row.get(key) for row in (first, last) for key in EXPLICIT_FIELDS):
        return None, 'Явный график или пересмотр ставки требует отдельного согласования'
    if any(row.get('accrued_interest') not in ('', None) and money(row['accrued_interest']) for row in (first, last)):
        return None, 'Начисленные проценты требуют отдельного правила переноса'
    baseline = (money(first['current_principal_amt']) - principal_paid).quantize(Decimal('.01'))
    if baseline <= 0 or report_date(first['maturity_dttm']) <= day:
        return None, 'Предыдущий договор по графику завершается до даты сравнения'
    return {**first, 'report_dttm': day.isoformat(), 'current_principal_amt': str(baseline)}, None


def rerun(core, directory, rows, sides):
    directory.mkdir()
    source = directory / 'input.csv'
    write_rows(source, rows, tuple(rows[0]), ';')
    output = directory / 'core'
    run([str(core), '--input', str(source), '--output-dir', str(output), '--threads', '2'], timeout=30)
    good = {row['instrument_id'] for row in read_rows(output / 'deal_summary.csv')}
    return dated_flows(read_rows(output / 'cashflows.csv'), {key: sides[key] for key in good})


def priced_world(flows, day, weights, buckets):
    def weight(payment):
        if payment not in buckets:
            buckets[payment] = bucket_for(report_date(payment), day)
        return weights[buckets[payment]]

    return {key: sum((amount * weight(payment) for (payment, _), amount in rows.items()), ZERO)
            for key, rows in flows.items()}


def marginal_values(worlds):
    """Three groups, exact average over the six possible substitution orders."""
    return {
        name: sum(((2 if mask.bit_count() in (0, 2) else 1) * (worlds[mask | bit] - worlds[mask])
                   for mask in range(8) if not mask & bit), ZERO) / 6
        for idx, name in enumerate(GROUPS) for bit in (1 << idx,)
    }


def signed_balance(row):
    try:
        amount = money(row.get('current_principal_amt'))
    except ValueError:
        return None
    return -amount if row['side'] == 'LIABILITY' else amount


def portfolio_structure(before, after):
    def summary(rows, attribute):
        counts = Counter(row.get(attribute, '') for row in rows.values())
        amounts = defaultdict(Decimal)
        unknown = set()
        for row in rows.values():
            key = row.get(attribute, '')
            value = signed_balance(row)
            if value is None:
                unknown.add(key)
            else:
                amounts[key] += value
        return counts, {key: None if key in unknown else float(amounts[key]) for key in counts}

    result = []
    for attribute in ('side', 'discriminator', 'rate_type_cd'):
        a, p = summary(before, attribute)
        b, q = summary(after, attribute)
        result.extend({'field': attribute, 'label': key, 'before': a[key], 'after': b[key],
                       'signedBalanceBefore': p.get(key, 0.), 'signedBalanceAfter': q.get(key, 0.)}
                      for key in sorted(a.keys() | b.keys()))
    return result


def counterfactuals(folder, candidates, contracts0, contracts1, first_rows, last_rows, day, avg, common, update):
    """Verify original C++ output on both dates and validate each hybrid via the real engine."""
    if not candidates:
        return {}, set(), 0, None
    try:
        binary = core_path()
    except ValueError as error:
        return {}, set(), 0, str(error)
    sides = {key: common[key] for key in candidates}
    # Temporary files contain deal data, so keep them under the private analysis folder.
    with TemporaryDirectory(prefix='cash-details-', dir=folder) as name:
        base = Path(name)
        completed = 0
        try:
            update(1, 9, 'Проверка исходных условий в C++')
            archive0 = dated_flows(first_rows, sides)
            archive1 = dated_flows(last_rows, sides)
            original = rerun(binary, base / 'original', [contracts0[key] for key in candidates], sides)
            mismatched = {key for key in candidates if key not in original or not same_flows(original[key], archive0[key])}
            completed += 1
            worlds, buckets = {}, {}
            for mask in range(8):
                update(mask + 1, 9, f'Пересчёт условий в C++ · вариант {mask + 1} из 8')
                fields = [field for idx, group in enumerate(GROUPS.values()) if mask & (1 << idx) for field in group]
                rows = [{**baseline, **{field: contracts1[key][field] for field in fields}} for key, baseline in candidates.items()]
                replay = rerun(binary, base / str(mask), rows, sides)
                completed += 1
                if mask == 7:
                    mismatched.update(key for key in candidates if key not in replay or not same_flows(replay[key], archive1[key]))
                worlds[mask] = priced_world(replay, day, avg, buckets)
            return worlds, mismatched, completed, None
        except (OSError, ValueError, TimeoutExpired):
            return {}, set(), completed, 'Калькулятор не завершил проверочный прогон. Показаны эффекты по сохранённым потокам.'


def calculate_cash_details(folder, report, update=lambda *_: None):
    first = load_snapshot(folder, report['before'])
    last = load_snapshot(folder, report['after'])
    before, after = report_date(first.day), report_date(last.day)
    contracts0, contracts1 = by_id(folder, first.day), by_id(folder, last.day)
    common = {key: first.sides[key] for key in sorted(first.sides.keys() & last.sides.keys())}
    with localcontext() as ctx:
        ctx.prec = 44
        w0, w1 = weights(first, report['scenario']), weights(last, report['scenario'])
        avg = {bucket: (w0[bucket] + w1[bucket]) / 2 for bucket in BUCKETS}
        flows0 = read_rows(folder / first.day / FILES[1])
        flows1 = read_rows(folder / last.day / FILES[1])
        remaining, paid, totals = old_forecast(flows0, before, after, common, avg)
        candidates, excluded = {}, Counter()
        required_fields = {field for fields in GROUPS.values() for field in fields} | {'deal_dttm'}
        for key in common:
            a, b = contracts0[key], contracts1[key]
            if not (required_fields <= a.keys() and required_fields <= b.keys()):
                excluded['В снимке нет всех полей нормализованной схемы'] += 1
                continue
            try:
                row, reason = rolled_contract(a, b, paid[key], after)
            except ValueError:
                row, reason = None, 'Недостаточно корректных договорных полей для пересчёта'
            if row is None:
                excluded[reason] += 1
            else:
                candidates[key] = row
        worlds, mismatched, completed, unavailable = counterfactuals(
            folder, candidates, contracts0, contracts1, flows0, flows1, after, avg, common, update)
        covered = 0
        revision = ZERO
        for key in common:
            observed = pv(last.flows[key], avg)
            original = pv(remaining[key], avg)
            revision += observed - original
            if key not in candidates or unavailable:
                totals['undivided'] += observed - original
                if key in candidates:
                    excluded['Калькулятор недоступен для проверки условий'] += 1
                continue
            if key in mismatched:
                excluded['Повторный расчёт исходных условий расходится со снимком'] += 1
                totals['undivided'] += observed - original
                continue
            if any(key not in world for world in worlds.values()):
                excluded['Одна из комбинаций параметров отклонена калькулятором'] += 1
                totals['undivided'] += observed - original
                continue
            amounts = {mask: world[key] for mask, world in worlds.items()}
            # Anchor the final valuation to the archived flows after verifying the replay.
            amounts[7] = observed
            totals['rebase'] += amounts[0] - original
            for name, value in marginal_values(amounts).items():
                totals[name] += value
            covered += 1
        actual = Decimal(report['decimal']['cash'])
        gap = actual - sum(totals.values(), ZERO)
        if abs(gap) > TOLERANCE:
            raise ValueError('Детализация не сходится с проверенным эффектом денежных потоков.')
        added = last.sides.keys() - first.sides.keys()
        issued = []
        for key in added:
            row = contracts1[key]
            try:
                issued_on = report_date(row.get('deal_dttm'))
            except ValueError:
                continue
            if before < issued_on <= after:
                issued.append(signed_balance(row))
        signed_issued = None if any(value is None for value in issued) else float(sum(issued, ZERO))
        return {
            'method': 'cashflow-rollforward-shapley', 'common': len(common), 'covered': covered,
            'recalculations': completed, 'basis': 'Средние веса начальной и конечной дат',
            'parts': [{'key': key, 'label': label, 'value': float(totals[key]), 'decimal': str(totals[key])} for key, label in PARTS],
            'revision': float(revision), 'reconciliation': float(gap),
            'excluded': [{'reason': reason, 'count': count} for reason, count in sorted(excluded.items())],
            'structure': portfolio_structure(contracts0, contracts1),
            'newlyIssued': {'count': len(issued), 'signedBalance': signed_issued, 'added': len(added)},
            'message': unavailable,
        }
