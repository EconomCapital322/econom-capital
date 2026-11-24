"""Bounded effect diagnostics on observed support."""

from collections import Counter, defaultdict

import numpy as np

from .panel import number

SHAPES = {
    'linear': 'Приблизительно линейная', 'threshold': 'Пороговая', 'saturation': 'С насыщением',
    'u': 'U-образная', 'inverted_u': 'Перевёрнутая U-образная', 'regimes': 'Разные режимы наклона',
    'nonmonotonic': 'Немонотонная', 'unconfirmed': 'Тип зависимости не подтверждён',
}


def form(x, y, support, scale):
    if len(x) < 5 or np.ptp(x) <= 0 or np.ptp(y) < max(1e-9, scale * 0.06):
        return 'unconfirmed', None
    x = (x - x[0]) / np.ptp(x)
    y = (y - y[0]) / np.ptp(y)
    w = np.sqrt(support / np.sum(support))

    def fit(matrix):
        coefficients = np.linalg.lstsq(matrix * w[:, None], y * w, rcond=None)[0]
        return coefficients, float(np.linalg.norm((matrix @ coefficients - y) * w))

    linear = np.column_stack([np.ones(len(x)), x])
    _, linear_error = fit(linear)
    best = min(((*fit(np.column_stack([linear, np.maximum(0, x - x[at])])), at)
                for at in range(1, len(x) - 1)), key=lambda row: row[1])
    coefficients, error, at = best
    quadratic, quadratic_error = fit(np.column_stack([linear, x ** 2]))
    if abs(quadratic[2]) > 1e-9 and quadratic_error < min(.7 * linear_error, .9 * error):
        vertex = -quadratic[1] / (2 * quadratic[2])
        if .15 < vertex < .85 and abs(quadratic[2]) * min(vertex, 1 - vertex) ** 2 >= .075:
            return ('u' if quadratic[2] > 0 else 'inverted_u'), int(np.argmin(abs(x - vertex)))
    if linear_error < 0.085 or error > linear_error * 0.7:
        swings = np.diff(y)
        if linear_error > 0.12 and np.any(swings > .18) and np.any(swings < -.18):
            return 'nonmonotonic', None
        return ('linear' if linear_error < 0.16 else 'unconfirmed'), None
    first, second = coefficients[1], sum(coefficients[1:])
    left, right = first * x[at], second * (1 - x[at])
    if left < -.17 and right > .17:
        return 'u', at
    if left > .17 and right < -.17:
        return 'inverted_u', at
    if abs(first) < .35 * abs(second) and abs(right) > .4:
        return 'threshold', at
    if abs(second) < .5 * abs(first) and abs(left) > .4:
        return 'saturation', at
    return 'regimes', at


def center(values, support):
    middle = np.cumsum(values) - values / 2
    return middle - np.average(middle, weights=support)


def ale_intervals(model, data, column):
    values = data[:, column]
    edges = np.unique(np.quantile(values, np.linspace(0, 1, min(13, len(values) // 8 + 1))))
    bins = np.searchsorted(edges[1:-1], values, side='left')
    diffs, bounds = [], []
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        current = data[bins == i]
        if len(current) < 5:
            continue
        at_lo, at_hi = current.copy(), current.copy()
        at_lo[:, column], at_hi[:, column] = lo, hi
        diffs.append(model.predict(at_hi) - model.predict(at_lo))
        bounds.append((lo, hi))
    return edges, bounds, diffs


def effect_curve(model, encoding, feature, sample, attributed, groups, scale, seed):
    name = feature['key']
    points = []
    column = encoding.indices[name][0]
    _, _, levels = next(spec for spec in encoding.specs if spec[0] == name)
    result = {'key': name, 'kind': 'numeric' if levels is None else 'category', 'points': points,
              'shape': 'unconfirmed', 'shapeLabel': SHAPES['unconfirmed'], 'stability': None,
              'sampleRows': len(sample), 'support': 0}
    if levels is not None:
        groups_by_value = defaultdict(list)
        index = groups.index(name)
        for row, values in zip(sample, attributed, strict=True):
            raw = row['values'][name]
            groups_by_value[raw if raw in levels else 'Прочие / пропуски'].append(values[index])
        points.extend({'x': level, 'value': float(np.mean(values)), 'support': len(values)}
                      for level, values in groups_by_value.items() if len(values) >= 3)
        result.update(support=sum(item['support'] for item in points), shapeLabel='Средний SHAP по категориям')
        return result
    valid = np.array([number(row['values'][name]) is not None for row in sample])
    data = encoding.transform(sample)[valid]
    values = data[:, column]
    if len(values) < 20:
        return result
    edges, bounds, diffs = ale_intervals(model, data, column)
    if not diffs:
        return result
    support = np.array([len(values) for values in diffs])
    x = np.array([lo + (hi - lo) / 2 for lo, hi in bounds])
    y = center(np.array([np.mean(values) for values in diffs]), support)
    shape, turn = form(x, y, support, scale)
    rng = np.random.default_rng(seed)
    boot = np.array([center(np.array([np.mean(rng.choice(values, len(values))) for values in diffs]), support)
                     for _ in range(40)])
    confidence = Counter(form(x, row, support, scale)[0] for row in boot)[shape] / len(boot)
    low, high = np.quantile(boot, [.1, .9], axis=0)
    for i, (lo, hi) in enumerate(bounds):
        points.append({'x': float(x[i]), 'value': float(y[i]), 'lower': float(lo), 'upper': float(hi),
                       'support': int(support[i]), 'low': float(low[i]), 'high': float(high[i]),
                       'slope': float(np.mean(diffs[i]) / (hi - lo))})
    stable = shape != 'unconfirmed' and confidence >= .7 and all(a[1] == b[0] for a, b in zip(bounds, bounds[1:]))
    shown = shape if stable else 'unconfirmed'
    result.update(shape=shown, shapeLabel=SHAPES[shown], stability=confidence,
                  support=int(sum(support)), range=[float(edges[0]), float(edges[-1])],
                  turningRange=list(map(float, bounds[turn])) if stable and turn is not None else None)
    return result


def interaction_plot(pair, panel_rows, key_a, key_b):
    """Summarize observed pair contributions across observed feature ranges."""
    def bands(values, split):
        nums = [number(raw) for raw in values]
        good = [value for value in nums if value is not None]
        categories = dict(Counter(values).most_common(split))
        if len(good) == len(values) and len(set(good)) > split:
            edges = np.unique(np.quantile(good, np.linspace(0, 1, split + 1)))
            groups = np.searchsorted(edges[1:-1], good, side='left')
            ranges = {i: (float(lo), float(hi)) for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:]))}
            return groups, ranges
        labels = list(categories)
        return [labels.index(raw) if raw in categories else -1 for raw in values], dict(enumerate(labels))

    a, ranges_a = bands([row['values'][key_a] for row in panel_rows], 5)
    b, ranges_b = bands([row['values'][key_b] for row in panel_rows], 3)
    support = defaultdict(list)
    for first, second, value in zip(a, b, pair, strict=True):
        if first >= 0 and second >= 0:
            support[int(second), int(first)].append(float(value))
    return [{'group': ranges_b[group], 'points': [
        {'range': value_range, 'value': float(np.mean(support[group, i])), 'support': len(support[group, i])}
        for i, value_range in ranges_a.items() if len(support[group, i]) >= 5]}
        for group in ranges_b if any(len(support[group, i]) >= 5 for i in ranges_a)]


def sampled_shape(model, encoding, name, sample, scale):
    indices = encoding.indices.get(name)
    if indices is None or len(indices) != 1:
        return 'unconfirmed'
    rows = [row for row in sample if number(row['values'][name]) is not None]
    if len(rows) < 25:
        return 'unconfirmed'
    _, bounds, diffs = ale_intervals(model, encoding.transform(rows), indices[0])
    if len(diffs) < 5 or any(a[1] != b[0] for a, b in zip(bounds, bounds[1:])):
        return 'unconfirmed'
    support = np.array([len(part) for part in diffs])
    x = np.mean(bounds, axis=1)
    value = center(np.array([np.mean(part) for part in diffs]), support)
    return form(x, value, support, scale)[0]


def training_dependencies(matrix, encoding, column, name):
    """Screen correlated and nonlinearly dependent candidate controls on training rows."""
    current = matrix[:, column]
    variation = float(np.var(current))
    if not variation:
        return []
    result = []
    for other, indices in encoding.indices.items():
        if name == other:
            continue
        controls = matrix[:, indices]
        if len(indices) == 1:
            values = controls[:, 0]
            if len(set(values)) < 2:
                continue
            correlation = abs(np.corrcoef(current, values)[0, 1])
            edges = np.unique(np.quantile(values, [.2, .4, .6, .8]))
            levels = np.searchsorted(edges, values, side='right')
        else:
            correlation = 0
            levels = np.argmax(controls, axis=1)
        if correlation >= .8:
            result.append(other)
            continue
        between = sum(len(selected) * (float(np.mean(selected)) - float(np.mean(current))) ** 2
                      for level in np.unique(levels) if len(selected := current[levels == level]) >= 8)
        if between / (len(current) * variation) >= .65:
            result.append(other)
    return result


def response_plots(model, encoding, training, sample, attributed, groups, name, date_constant, seed):
    column = encoding.indices[name][0]
    valid = np.array([number(row['values'][name]) is not None for row in sample])
    if not any(valid):
        return {'shap': [], 'ice': [], 'pdp': [], 'reason': 'Нет наблюдений с числовым значением.'}
    data = encoding.transform(sample)[valid]
    x = data[:, column]
    phi = attributed[valid, groups.index(name)]
    ordered = np.argsort(x, kind='stable')
    display = ordered[np.linspace(0, len(x) - 1, min(160, len(x))).astype(int)]
    result = {'shap': [{'x': float(x[i]), 'value': float(phi[i])} for i in display],
              'ice': [], 'pdp': [], 'reason': None, 'dependencies': [], 'predictionRows': 0}
    if date_constant:
        result['reason'] = 'Признак общий для даты. Допустимы наблюдаемые вклады SHAP и отдельная проверка по датам.'
        return result
    dependencies = training_dependencies(training, encoding, column, name)
    if dependencies:
        result.update(dependencies=dependencies, reason='Сильная зависимость признаков в обучении. Используйте ALE и наблюдаемые вклады SHAP.')
        return result
    if len(x) < 25:
        result['reason'] = 'Нужно минимум 25 наблюдений на конечную дату.'
        return result
    lo, hi = np.quantile(training[:, column], [.05, .95])
    grid = np.unique(np.quantile(x, np.linspace(.05, .95, 12)))
    grid = grid[(grid >= lo) & (grid <= hi)]
    if len(grid) < 4:
        result['reason'] = 'Для ICE и PDP мало общих значений в обучающем и проверочном диапазонах.'
        return result
    rng = np.random.default_rng(seed)
    cohort = rng.choice(len(x), min(128, len(x)), replace=False)
    selected = data[cohort]
    matrix = np.tile(selected, (len(grid), 1))
    matrix[:, column] = np.repeat(grid, len(selected))
    predictions = model.predict(matrix).reshape(len(grid), len(selected))
    lines = rng.choice(len(selected), min(12, len(selected)), replace=False)
    result.update(
        ice=[[{'x': float(point), 'value': float(predictions[i, row] - predictions[0, row])}
              for i, point in enumerate(grid)] for row in lines],
        pdp=[{'x': float(point), 'value': float(np.mean(predictions[i])), 'support': len(selected)} for i, point in enumerate(grid)],
        predictionRows=len(selected),
    )
    return result
