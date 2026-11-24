"""Read-only evidence from published Spectrum calculations and data profiles."""

from collections import Counter
from datetime import date
from hashlib import sha256
from math import fsum, isfinite

from .integration import DIRECTIONS, LABELS, RATE_TYPES, SCENARIOS

METRICS = {
    'npv': 'Приведённая стоимость договорных платежей по базовой кривой.',
    'stress_delta': 'Разница приведённой стоимости одних и тех же платежей по стрессовой и базовой кривым.',
    'interest12': 'Сумма договорных процентных потоков ближайших двенадцати месяцев с учётом стороны сделки.',
    'cash12': 'Сумма договорных платежей ближайших двенадцати месяцев с учётом стороны сделки.',
}
MEANINGS = {
    'cash_effect': 'Изменение состава, сумм и сроков платежей по общим сделкам.',
    'discount_effect': 'Изменение коэффициентов для тех же сроков платежей между отчётными датами.',
    'principal': 'Непогашенная часть основного долга на дату наблюдения.',
    'contract_rate': 'Договорная ставка, включая базовую ставку для плавающих сделок.',
    'term_years': 'Оставшийся срок до погашения.',
    'age_years': 'Время с даты возникновения сделки.',
    'payment_type': 'Порядок погашения основного долга.',
    'rate_type': 'Фиксированная либо плавающая договорная ставка.',
    'side': 'Актив или обязательство определяет знак договорных платежей.',
    'market_short': 'Нулевая ставка на коротком конце базовой кривой.',
    'market_long': 'Нулевая ставка на длинном конце базовой кривой.',
    'market_level': 'Среднее нулевых ставок на опорных сроках.',
    'market_slope': 'Разность нулевых ставок на длинном и коротком сроках.',
    'market_curvature': 'Отклонение среднего участка от опорных концов.',
}
SCENARIO_MEANINGS = {
    'parallel_up': 'Все сроки испытывают положительный шок ставок.',
    'parallel_down': 'Все сроки испытывают отрицательный шок ставок.',
    'steepener': 'Шок меняет наклон: короткий и длинный концы движутся по-разному.',
    'flattener': 'Шок уменьшает наклон: короткий и длинный концы движутся по-разному.',
    'short_rate_up': 'Положительный шок сосредоточен на коротких сроках.',
    'short_rate_down': 'Отрицательный шок сосредоточен на коротких сроках.',
}


def amount(value, unit=''):
    return f'{value:z,.2f}'.replace(',', '\xa0').replace('.', ',') + (' ' + unit if unit else '')


def number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and isfinite(value)


def day(value):
    return date.fromisoformat(value).strftime('%d.%m.%Y')


def stable_key(value):
    if value in LABELS:
        return value
    return sha256(value.encode()).hexdigest()[:20]


def pair_key(a, b):
    return 'interaction.' + '_'.join(sorted((stable_key(a), stable_key(b))))


def evidence(title, text, source, *, value=None, unit='', group='', detail='', meta=None, meaning='', legacy=None):
    return dict(title=title, text=text, source=source, detail=detail, value=value, unit=unit,
                group=group, meta=meta or {}, meaning=meaning, legacy=legacy)


def analysis_evidence(report, legacy, labels, unit):
    facts = {}
    exact = report.get('mode') == 'valuation'
    target = labels.get(report['target'], report['target'])

    def from_fact(key, old, **kwargs):
        source = legacy.get(old)
        if source:
            facts[key] = evidence(source['title'], source['text'], source['source'], detail=source.get('detail', ''),
                                  legacy=old, **kwargs)

    def add(key, title, val, source, *, units=unit, group='', detail='', meaning='', meta=None):
        if number(val):
            facts[key] = evidence(title, f'{title}: {amount(val, units)}.', source, value=val, unit=units, group=group,
                                  detail=detail, meaning=meaning, meta=meta)

    from_fact('metric.change', 'overview', value=report['change'], unit=unit, group='change',
              meaning=METRICS.get(report['target'], 'Агрегированная целевая метрика выбранных наблюдений.'),
              meta={'metric': target, **{name: report[name] for name in ('before', 'after', 'start', 'end')}})
    for key, label in (('start', 'Начальное значение'), ('end', 'Конечное значение')):
        add(f'metric.{key}', label, report[key], '#waterfall', group='metric',
            meta={'date': report['before' if key == 'start' else 'after']})
    from_fact('composition.matched', 'cohort', value=report['matched'], unit='сделок', group='count')
    for key, field, label in (('added', 'additions', 'Новые сделки'), ('removed', 'exclusions', 'Выбывшие сделки')):
        add(f'composition.{key}', label, report[field], '#waterfall', group='contribution', detail=key,
            meaning='Вклад изменения состава между двумя снимками.',
            meta={'count': report[key]} if key in report else None)
        if key in report:
            facts[f'composition.{key}']['text'] = f'{label}. Количество: {report[key]}. Вклад: {amount(report[field], unit)}.'
    for i, item in enumerate(report['factors']):
        name, value = item['key'], item['value']
        key = {'cash_effect': 'cashflows', 'discount_effect': 'discounting'}.get(name) or stable_key(name)
        change = report['change']
        meta = {'shareOfNetChange': round(value / change, 6)} if abs(change) > 1e-9 else {}
        meta.update({field: item[field] for field in ('low', 'high', 'signStability', 'refitSignMatches', 'refits') if field in item})
        from_fact(f'factor.{key}', f'factor_{i}', value=value, unit=unit, group='contribution',
                  meaning=MEANINGS.get(name, 'Модельный вклад изменения признака по общим наблюдениям.'), meta=meta)
    if 'other' in legacy:
        factor = legacy['other']
        facts['factor.other'] = evidence(factor['title'], factor['text'], factor['source'], detail='other', legacy='other')
    if exact:
        from_fact('validation.reconciliation', 'residual', value=report['reconciliation'], unit=unit, group='reconciliation',
                  meta={'status': report.get('status', 'verified'), 'tolerance': report.get('tolerance')})
        from_fact('interaction.cashflows_discounting', 'cash_discount_joint', value=report['joint'], unit=unit,
                  group='joint', meaning='Совместный эффект уже распределён между потоками и дисконтированием.')
        add('validation.numerical_gap', 'Арифметическая невязка по общим сделкам', report.get('numericalGap'),
            '#valuation-detail', group='reconciliation')
        states = {'v00': 'Прежние потоки и прежние веса', 'v10': 'Новые потоки и прежние веса',
                  'v01': 'Прежние потоки и новые веса', 'v11': 'Новые потоки и новые веса'}
        for key, name in states.items():
            add(f'counterfactual.{key}', name, report.get('states', {}).get(key), '#valuation-detail', group='state',
                meaning='Расчёт на общих сделках. Веса зависят от выбранного показателя и сценария.')
        if cash := report.get('cashDetails'):
            from_fact('cash.coverage', 'cash_summary', meta={'method': 'cashflow-rollforward-shapley',
                      'covered': cash['covered'], 'common': cash['common']})
            from_fact('limitation.cash', 'cash_caution')
            for part in cash['parts']:
                key = part['key']
                from_fact(f'cash.{key}', f'cash_part_{key}', value=part['value'], unit=unit, group='cash',
                          meaning='Договорный эффект в изменении потоков. Прошедшие плановые платежи взяты из прежнего графика.')
        else:
            facts['limitation.cash'] = evidence('Детализация потоков', 'Расчёт договорной детализации ещё не выполнен. '
                'Откройте денежные потоки и запустите детализацию.', '#cash-details')
        facts['limitation.method'] = evidence('Границы расчётной сверки', 'Сверка подтверждает арифметическую согласованность '
            'с выгрузкой калькулятора. Плановые погашения следуют из договорного графика. Применимость банковской '
            'методики и фактические операции требуют отдельной проверки.', '#analysis-methodology', legacy='caution')
    else:
        from_fact('model.residual', 'residual', value=report.get('residual'), unit=unit, group='residual',
                  meta={key: report[key] for key in ('residualRatio', 'residualLimit') if key in report})
        from_fact('model.quality', 'quality', meta={'status': report.get('status', 'insufficient'),
                  'reliable': report.get('reliable', False), 'criteria': report.get('criteria', {})})
        from_fact('limitation.causality', 'caution')
        from_fact('limitation.validation', 'warning')
        add_model_evidence(facts, report, legacy, labels, unit)

    facts['method.analysis'] = evidence('Метод анализа',
        ('Точное разложение использует договорные потоки и веса из кривых. Сравниваются четыре состояния по общим '
         'сделкам, совместный эффект распределяется симметрично. Состав портфеля учитывается отдельно.' if exact else
         'ML-атрибуция раскладывает изменение прогнозов на вклады признаков. Обучение проводится на более ранних '
         'датах. Разница между наблюдаемым и объяснённым изменением остаётся в остатке.'),
        '#analysis-methodology', legacy='method')
    return facts


def add_model_evidence(facts, report, legacy, labels, unit):
    def title(name):
        return labels.get(name, name)

    if model := report.get('model'):
        folds = report.get('quality', [])
        model_name = model['name']
        scores = {key: fsum(row[key] for row in folds) / len(folds) for key in ('median', 'linear', 'forest', 'extra')
                  if folds and all(number(row.get(key)) for row in folds)}
        why = ('Выбор учитывает среднюю MAE на исторических проверках. Из моделей в пределах 1% от минимума '
               'берётся первая по порядку кандидатов.' if folds else
               'Для сравнения кандидатов не хватило независимых дат. Применён базовый случайный лес.')
        chosen_score = scores.get(model.get('key'))
        if chosen_score is not None and 'median' in scores:
            why += f' MAE выбранной модели {amount(chosen_score, unit)}, медианного ориентира {amount(scores["median"], unit)}.'
        facts['model.selection'] = evidence('Выбор модели',
            (f'Для разложения использована модель «{model_name}». Сравнение кандидатов выполнено на {len(folds)} '
             'проверочных датах до начала сравнения. ' + why),
            '#quality', meta={'model': model_name, 'folds': len(folds), 'trainedThrough': model.get('trainedThrough'),
                              'trainingRows': model.get('trainingRows'), 'candidateMae': scores})
    for i, row in enumerate(report.get('validation', [])):
        baseline = row.get('median', {}).get('mae')
        checks = [f'MAE {amount(row["mae"], unit)}']
        for key in ('rmse', 'r2', 'bias', 'aggregateError'):
            if number(row.get(key)):
                checks.append(f'{key} {amount(row[key], "" if key == "r2" else unit)}')
        if number(baseline):
            checks.append(f'MAE медианного ориентира {amount(baseline, unit)}')
        facts[f'validation.holdout_{i}'] = evidence(f'Проверка на {day(row["date"])}',
            f'{day(row["date"])} — {", ".join(checks)}.', '#quality', value=row['mae'], unit=unit, group='mae',
            meta={key: row[key] for key in ('date', 'mae', 'rmse', 'r2', 'bias', 'aggregateError', 'rows', 'median') if key in row})
    if report.get('stability'):
        stats = report['stability']
        ranks = ', '.join(amount(val) for val in stats.get('rankCorrelations', [])) or 'нет оценки'
        facts['model.stability'] = evidence('Повторное обучение',
            f'Повторных обучений: {stats["refits"]}. Корреляция рангов вкладов по модулю: {ranks}. '
            'Предупреждения отчёта учитывают устойчивость рангов и знаков ведущих вкладов.',
            '#quality', meta={key: stats[key] for key in ('refits', 'rankCorrelations') if key in stats})
    for item in report.get('featureAudit', []):
        name = item['name']
        reason = item.get('reason')
        selected = name in report.get('selectedFeatures', [])
        text = 'Признак выбран для модели.' if selected else (reason or 'Признак не вошёл в текущую модель.')
        facts['selection.' + stable_key(name)] = evidence(title(name), f'{title(name)}. {text}', '#data-setup',
            detail=name, meta={'selected': selected, 'reason': reason})
    for item in report.get('importance', []):
        name = item['key']
        absolute, permutation = item['meanAbsShap'], item.get('value')
        added = (f' После перестановки ошибка MAE изменилась на {amount(permutation, unit)}.'
                 if number(permutation) else ' Индивидуальная перестановочная оценка недоступна.')
        facts['importance.' + stable_key(name)] = evidence(title(name),
            f'Средний модуль SHAP на конечную дату для «{title(name)}» — {amount(absolute, unit)} на наблюдение.'
            + added + ' Это глобальная важность. Вклад в изменение по общим наблюдениям приведён в разложении.',
            '#importance', detail=name, value=absolute, unit=unit, group='importance',
            meta={'permutation': permutation, 'low': item.get('low'), 'high': item.get('high')})
    for i, item in enumerate(report.get('effects', [])):
        name = item['key']
        kind = item.get('kind')
        method = 'ALE' if kind == 'numeric' else 'SHAP по категориям'
        shape = item.get('shape', 'unconfirmed')
        meta = {key: item[key] for key in ('shape', 'range', 'turningRange', 'stability', 'support') if key in item}
        meta.update(method=method, refits=[r['shape'] for r in item.get('refitShapes', [])])
        parts = [legacy[f'effect_{i}']['text'], f'Метод: {method}.']
        if observed := item.get('range'):
            parts.append(f'Наблюдаемый диапазон: {amount(observed[0])} — {amount(observed[1])}.')
        points = [p for p in item.get('points', []) if number(p['x'])]
        if kind == 'numeric' and shape != 'unconfirmed' and len(points) >= 2:
            diff = points[-1]['value'] - points[0]['value']
            parts.append(f'Разность оценок ALE между крайними показанными точками: {amount(diff, unit)}.')
            meta['endMinusStart'] = diff
            if shape in ('u', 'inverted_u') and item.get('turningRange'):
                parts.append('Поворотный диапазон соответствует ' + ('минимуму.' if shape == 'u' else 'максимуму.'))
        if number(item.get('stability')):
            parts.append(f'Доля воспроизведения формы на подвыборках: {amount(100 * item["stability"], "%")}.')
        if meta['refits'] and any(refit != shape for refit in meta['refits']):
            parts.append('При повторном обучении форма воспроизводится не во всех прогонах.')
        parts.append('Оценка относится к наблюдаемому диапазону. Для причинного вывода нужна отдельная проверка.')
        facts['effect.' + stable_key(name)] = evidence(title(name), ' '.join(parts), '#effects',
            detail=name, meta=meta, meaning=MEANINGS.get(name, 'Зависимость прогноза от уровня признака.'),
            legacy=f'effect_{i}')
    for i, item in enumerate(report.get('interactions', [])):
        a, b = item['a'], item['b']
        key = pair_key(a, b)
        description = [legacy[f'pair_{i}']['text']]
        meta = {key: item[key] for key in ('strength', 'strengthBefore', 'change', 'changeInStrength', 'rows',
                                          'population', 'estimated', 'low', 'high', 'stable') if key in item}
        meta.update(method='TreeSHAP interaction', factors=[title(a), title(b)],
                    meanings=[MEANINGS.get(name, 'Признак модели.') for name in (a, b)])
        if number(item.get('change')):
            description.append(f'Среднее изменение подписанного взаимодействия между датами: {amount(item["change"], unit)} на сделку.')
        if item.get('low') is not None:
            description.append(f'Интервал средней абсолютной силы: {amount(item["low"], unit)} — {amount(item["high"], unit)}.')
        if item.get('estimated'):
            description.append('Оценка выполнена на подвыборке.')
        if item.get('stable') is False:
            description.append('Проверка устойчивости силы взаимодействия не пройдена.')
        profile = [(series['group'], point) for series in item.get('profile', []) for point in series['points']]
        if profile:
            opposite = sorted(profile, key=lambda row: -abs(row[1]['value']))[:3]
            meta['observedRanges'] = [{'second': group, 'first': row['range'], 'meanSigned': row['value'],
                                       'support': row['support']} for group, row in opposite]
            group, cell = opposite[0]
            description.append(f'В диапазонах «{band_label(cell["range"])}» и «{band_label(group)}» '
                               f'средний подписанный вклад пары {amount(cell["value"], unit)} по {cell["support"]} наблюдениям.')
        description.append('Модуль SHAP характеризует силу, а знак проверяется отдельно. '
                           'Парный вклад уже содержится во вкладах признаков и отдельно не суммируется.')
        facts[key] = evidence(f'{title(a)} × {title(b)}', ' '.join(description), '#interactions',
            detail=str(i), value=item['strength'], unit=unit, group='interaction', meta=meta, legacy=f'pair_{i}')
    if not report.get('effects'):
        facts['limitation.effects'] = evidence('Нелинейность', 'Подтверждённых форм зависимости в отчёте пока нет. '
            'Диагностику можно запустить в подробном анализе.', '#effects')
    if not report.get('interactions'):
        facts['limitation.interactions'] = evidence('Взаимодействия',
            'Подтверждённых парных взаимодействий в отчёте пока нет. Оценка требует поддерживаемой модели и общих наблюдений.',
            '#interactions', legacy='no_pair')


def band_label(value):
    if isinstance(value, (tuple, list)):
        return ' — '.join(amount(part) for part in value)
    return str(value)


def scenario_evidence(period, selected):
    items = period['scenarios']
    base = next(item for item in items if item['code'] == 'base')
    stresses = [item for item in items if item['code'] != 'base']
    worst = min(stresses, key=lambda item: item['delta'])
    focus = next((item for item in stresses if item['code'] == selected), worst)
    facts = {}
    for item in (focus, *(item for item in stresses if item != focus)):
        code, value = item['code'], item['delta']
        facts[f'scenario.{code}'] = evidence(item['name'],
            f'«{item["name"]}» на {day(period["date"])}: PV {amount(item["pv"], "₽")}, '
            f'к базовой оценке {amount(value, "₽")}.', '#scenario-results',
            detail=code, value=value, unit='₽', group='stress', meaning=SCENARIO_MEANINGS.get(code, ''),
            meta={'pv': item['pv'], 'base': base['pv'], 'date': period['date'], 'selected': item == focus})
    facts['scenario.worst'] = evidence('Минимальное изменение PV',
        f'«{worst["name"]}» даёт минимальное изменение среди рассчитанных сценариев: {amount(worst["delta"], "₽")}. '
        'Сценарии описывают чувствительность на этой дате и не оценивают вероятность шока.',
        '#scenario-results', detail=worst['code'], meta={'scenario': worst['code']})
    buckets = sorted(period.get('bucketDeltas', {}).get(focus['code'], []), key=lambda row: abs(row['value']), reverse=True)
    for item in buckets[:6]:
        value = item['value']
        facts[f'scenario.bucket_{item["label"]}'] = evidence(f'Срок {item["label"]}',
            f'Бакет {item["label"]} даёт {amount(value, "₽")} к ΔPV сценария «{focus["name"]}».',
            '#scenario-buckets', detail=focus['code'], value=value, unit='₽', group='stress_bucket',
            meta={'bucket': item['label'], 'scenario': focus['name']})
    return facts, focus['code']


def curve_evidence(result, selected, archived):
    base = next(item for item in result['curves'] if item['curveCode'] == 'base')
    focus = next((item for item in result['curves'] if item['curveCode'] == selected), base)
    facts = {}
    for key, curve in [('base', base), ('selected', focus)]:
        if key == 'selected' and curve is base:
            continue
        points = sorted(curve['points'], key=lambda item: float(item['tenorYears']))
        first, last = points[0], points[-1]
        short, long = float(first['ratePercent']), float(last['ratePercent'])
        rates = [float(point['ratePercent']) for point in points]
        monotone = ('возрастает по срокам' if all(x <= y for x, y in zip(rates, rates[1:])) and short < long else
                    'убывает по срокам' if all(x >= y for x, y in zip(rates, rates[1:])) and short > long else
                    'плоская в показанных узлах' if short == long and len(set(rates)) == 1 else
                    'меняет направление между узлами')
        label = SCENARIOS[curve['curveCode']]
        facts[f'curve.{key}'] = evidence(label,
            f'Кривая «{label}» {monotone}. Ставка {first["bucketLabel"]} — {amount(short, "%")}, '
            f'{last["bucketLabel"]} — {amount(long, "%")}. Разность длинной и короткой ставок: {amount(long - short, "п. п.")}.',
            '#curve-context', value=long - short, unit='п. п.', group='curve_slope',
            meaning=SCENARIO_MEANINGS.get(curve['curveCode'], 'Нулевые ставки для разных сроков дисконтирования.'),
            meta={'code': curve['curveCode'], 'shape': monotone, 'short': short, 'long': long,
                  'shortBucket': first['bucketLabel'], 'longBucket': last['bucketLabel']})
    used = result['usedParameters']
    provenance = 'данные MOEX' if result.get('source') == 'moex' and result.get('dataProvenance') != 'synthetic' else 'синтетический пример'
    date_text = day(result['reportDate'])
    facts['curve.parameters'] = evidence('Параметры стрессовых кривых',
        f'Для расчёта применены P = {amount(float(used["p"]))}, K = {amount(float(used["k"]))}, '
        f'D = {amount(float(used["d"]))} п. п. Они задают размеры параллельного, короткого и длинного шоков.',
        '#curve-context', meta={**{key: float(used[key]) for key in ('p', 'k', 'd')}, 'mode': used['mode']})
    snapshot = ('Архивный снимок портфеля фиксирует кривые, использованные в оценке.'
                if archived else 'Готовый запуск модуля кривых относится к выбранной дате и применённым параметрам.')
    facts['curve.source'] = evidence('Источник кривых',
        f'{snapshot} Дата {date_text}, {provenance}. Сравнение опирается на опубликованные узлы выбранного запуска.',
        '#curve-context', meta={'date': result['reportDate'], 'archive': archived, 'provenance': provenance})
    return facts, focus['curveCode']


def portfolio_evidence(workspace, period, contracts):
    result = {}
    stamp = date.fromisoformat(period['date'])
    for key, title, val, units in (
        ('deals', 'Сделки в снимке', period['deals'], 'сделок'),
        ('flows', 'Строки договорных потоков', period['flowRows'], 'строк'),
        ('cash12', 'Платежи на ближайший год', period['cash12'], '₽'),
        ('interest12', 'Процентные потоки на ближайший год', period['interest12'], '₽'),
    ):
        result[f'portfolio.{key}'] = evidence(title, f'{title} на {day(period["date"])}: {amount(val, units)}.',
            '#portfolio-holdings', value=val, unit=units, group=key,
            meaning='Платежи из договорного графика калькулятора с учётом стороны сделки.')
    for key, title, counts in (
        ('payment_type', 'Типы платежей', Counter(DIRECTIONS.get(row['discriminator'], 'Другой тип') for row in contracts)),
        ('rate_type', 'Типы ставок', Counter(RATE_TYPES.get(row['rate_type_cd'], 'Другой тип') for row in contracts)),
        ('side', 'Стороны сделок', Counter('Активы' if row['side'] == 'ASSET' else 'Обязательства' for row in contracts)),
        ('terms', 'Оставшиеся сроки', Counter(term_band(stamp, row['maturity_dttm']) for row in contracts)),
    ):
        result[f'portfolio.{key}'] = evidence(title,
            f'{title} на {day(period["date"])}: ' + ', '.join(f'{name} — {n}' for name, n in counts.most_common()) + '.',
            '#portfolio-holdings', meta={'counts': dict(counts)})
    report = workspace.get('report') or {}
    if report.get('after') == period['date'] and 'added' in report and 'removed' in report:
        result['portfolio.composition'] = evidence('Изменение состава',
            f'Между {day(report["before"])} и {day(report["after"])} появилось {report["added"]} '
            f'и выбыло {report["removed"]} сделок. Сопоставление выполнено по ID.',
            '#waterfall', meta={key: report[key] for key in ('before', 'after', 'added', 'removed')})
    return result


def term_band(stamp, maturity):
    days = (date.fromisoformat(maturity) - stamp).days
    if days <= 365:
        return 'До 1 года'
    if days <= 3 * 365:
        return 'От 1 до 3 лет'
    return 'Свыше 3 лет'


def data_evidence(workspace):
    profile = workspace.get('profile') or {}
    columns = profile.get('columns', [])
    dates = profile.get('dates', [])
    result = {}
    if columns:
        result['data.profile'] = evidence('Профиль данных',
            f'В наборе {profile["rows"]} строк, {len(columns)} колонок и {len(dates)} отчётных дат.',
            '#data-profile', meta={'rows': profile['rows'], 'columns': len(columns), 'dates': len(dates)})
    for key, title, field in (('missing', 'Пропуски', 'missing'), ('outliers', 'Выбросы по межквартильному правилу', 'outliers')):
        counted = sorted((col for col in columns if col.get(field)), key=lambda col: col[field], reverse=True)
        checked = sum(col.get(field) is not None for col in columns)
        results = (', '.join(f'{col["name"]} — {col[field]}' for col in counted[:4]) + '.'
                   if counted else 'в проверенных колонках замечаний нет.' if checked else 'нет данных для этой проверки.')
        result[f'data.{key}'] = evidence(title,
            f'{title}: {results} Проверено колонок: {checked}.',
            '#data-profile', meta={'affectedColumns': len(counted), 'checkedColumns': checked})
    report = workspace.get('report') or {}
    audit = [item for item in report.get('featureAudit', []) if not item.get('eligible')]
    result['data.leakage'] = evidence('Проверка утечки цели',
        ('Исключённые признаки: ' + '; '.join(f'{item["name"]}: {item["reason"]}' for item in audit[:6]) + '. '
         if audit else '') + 'Для прогноза допустимы только признаки, доступные на дату наблюдения. '
        'Профиль и автоматический отбор не заменяют проверку экономического смысла колонок.',
        '#data-setup', meta={'excluded': len(audit)})
    result['data.history'] = evidence('История для временной проверки',
        f'Доступно {len(dates)} отчётных дат. Для обучения нужна история до начала сравнения. '
        'При недостаточной истории отчёт показывает изменение и ограничивает выводы о факторах.',
        '#data-profile', value=len(dates), unit='дат', group='date_count')
    return result
