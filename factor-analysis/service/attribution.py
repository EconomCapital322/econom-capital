"""Out-of-time model selection and matched-cohort prediction attribution."""

from collections import Counter, defaultdict
from itertools import combinations
from math import fsum
import os

import numpy as np
import shap
import sklearn
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
from sklearn.feature_selection import mutual_info_regression
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score, root_mean_squared_error
from sklearn.preprocessing import StandardScaler

from .effects import effect_curve, interaction_plot
from .panel import MAX_FEATURES, NULL, distribution, feature_audit, number, resolve_rows

MIN_TRAIN_ROWS = 40
MIN_TRAIN_DATES = 2
SEED = 4317
MODELS = {"median": "Медиана", "linear": "Ridge", "forest": "Случайный лес", "extra": "Extra Trees"}
MARKET_DATES = 8
INTERACTION_MAX = 180


class Encoding:
    def __init__(self, rows, features, kinds):
        self.specs = []
        self.indices = {}
        width = 0
        for name in features:
            raw = [row["values"][name] for row in rows]
            if kinds[name] == "numeric":
                values = [value for text in raw if (value := number(text)) is not None]
                if len(set(values)) < 2:
                    continue
                replacement = float(np.median(values))
                levels = None
                size = 1
            else:
                available = [text for text in raw if text.lower() not in NULL]
                if len(set(available)) < 2:
                    continue
                replacement = None
                levels = [value for value, _ in Counter(available).most_common(10)]
                size = len(levels) + 1
            self.indices[name] = np.arange(width, width + size)
            self.specs.append((name, replacement, levels))
            width += size
        self.width = width

    def transform(self, rows):
        data = np.zeros((len(rows), self.width), dtype=np.float64)
        for name, replacement, levels in self.specs:
            raw = [row["values"][name] for row in rows]
            offset = self.indices[name][0]
            if levels is None:
                data[:, offset] = [converted if (converted := number(value)) is not None else replacement for value in raw]
            else:
                codes = {level: i for i, level in enumerate(levels)}
                data[np.arange(len(rows)), [offset + codes.get(value, len(levels)) for value in raw]] = 1.0
        return data


def target(rows):
    return np.array([row['observed'] for row in rows], dtype=float)


def ratio_limit(name, default):
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        return default
    return value if 0 < value <= 1 else default


def feature_strings(value):
    if not isinstance(value, list) or len(value) > 80 or any(not isinstance(name, str) for name in value):
        raise ValueError('Задайте признаки списком известных колонок.')
    return set(value)


def pick_features(names, training, excluded, selected, forbidden):
    audit = feature_audit(names, training, excluded, forbidden)
    candidates = [row for row in audit if row['eligible'] and (selected is None or row['name'] in selected)]
    if len(candidates) > MAX_FEATURES:
        rng = np.random.default_rng(SEED)
        sample = rng.choice(len(training), min(len(training), 2048), replace=False)
        data = []
        for col in candidates:
            raw = [training[index]['values'][col['name']] for index in sample]
            if col['kind'] == 'numeric':
                numeric = np.array([np.nan if (val := number(item)) is None else val for item in raw])
                fill = np.nanmedian(numeric) if not np.all(np.isnan(numeric)) else 0
                data.append(np.nan_to_num(numeric, nan=fill))
            else:
                _, codes = np.unique(raw, return_inverse=True)
                data.append(codes)
        matrix = np.column_stack(data)
        discrete = [col['kind'] == 'category' for col in candidates]
        scores = np.zeros(len(candidates))
        varying = np.ptp(matrix, axis=0) > 0
        if any(varying) and np.ptp(target(training)[sample]) > 0:
            # Encoded categories represented once are excluded by sklearn's estimator.
            usable = np.array([not category or len(np.unique(values)) < len(values)
                               for category, values in zip(discrete, matrix.T)]) & varying
            if any(usable):
                scores[usable] = mutual_info_regression(matrix[:, usable], target(training)[sample],
                                                        discrete_features=np.array(discrete)[usable], random_state=SEED)
        candidates = [entry for _, entry in sorted(zip(scores, candidates), key=lambda item: (-item[0], item[1]['name']))]
    selected_names = {col['name'] for col in candidates[:MAX_FEATURES]}
    for col in audit:
        if col['eligible'] and col['name'] not in selected_names:
            col['reason'] = ('Выключен в настройках' if selected is not None and col['name'] not in selected
                             else f'Вне первых {MAX_FEATURES} по связи с метрикой на обучающих данных')
        col['used'] = col['name'] in selected_names
    return [col['name'] for col in candidates[:MAX_FEATURES]], {col['name']: col['kind'] for col in candidates}, audit


class Fit:
    def __init__(self, name, x, y, seed):
        self.name = name
        self.center = x.mean(axis=0)
        self.scaler = None
        if name == 'linear':
            self.scaler = StandardScaler().fit(x)
            self.model = Ridge(alpha=1.0).fit(self.scaler.transform(x), y)
        elif name == 'median':
            self.model = DummyRegressor(strategy='median').fit(x, y)
        else:
            kind = RandomForestRegressor if name == 'forest' else ExtraTreesRegressor
            self.model = kind(n_estimators=48, max_depth=8, min_samples_leaf=4,
                              random_state=seed, n_jobs=1).fit(x, y)
        self.explainer = None

    def predict(self, x):
        return self.model.predict(self.scaler.transform(x) if self.scaler else x)

    def tree(self):
        if self.explainer is None:
            self.explainer = shap.TreeExplainer(self.model, model_output='raw', feature_perturbation='tree_path_dependent')
        return self.explainer

    def contributions(self, x):
        if self.name == 'median':
            return np.zeros_like(x)
        if self.name == 'linear':
            return (x - self.center) * (self.model.coef_ / self.scaler.scale_)
        return np.asarray(self.tree().shap_values(x))


def metrics(y, prediction):
    error = prediction - y
    r2 = float(r2_score(y, prediction, force_finite=False)) if len(y) > 1 and np.ptp(y) > 0 else None
    return {'mae': float(mean_absolute_error(y, prediction)), 'rmse': float(root_mean_squared_error(y, prediction)),
            'r2': r2 if r2 is not None and np.isfinite(r2) else None,
            'observedTotal': float(np.sum(y)), 'predictedTotal': float(np.sum(prediction)),
            'aggregateError': float(np.sum(error)), 'bias': float(np.mean(error)), 'rows': len(y)}


def training_folds(grouped, known_days, columns, excluded, selected, forbidden):
    folds = []
    for index in range(max(MIN_TRAIN_DATES, len(known_days) - 5), len(known_days)):
        day = known_days[index]
        training = [row for earlier in known_days[:index] for row in grouped[earlier]]
        testing = grouped[day]
        if len(training) < MIN_TRAIN_ROWS or len(testing) < 5:
            continue
        features, kinds, _ = pick_features(columns, training, excluded, selected, forbidden)
        encoding = Encoding(training, features, kinds)
        if not encoding.width:
            continue
        x_train, x_test = encoding.transform(training), encoding.transform(testing)
        y0, y1 = target(training), target(testing)
        experiments = {name: metrics(y1, Fit(name, x_train, y0, SEED).predict(x_test)) for name in MODELS}
        folds.append({'date': day, 'trainedThrough': known_days[index - 1], 'trainRows': len(training),
                      'testRows': len(testing), 'features': features, 'models': experiments,
                      **{name: row['mae'] for name, row in experiments.items()}, 'rmse': experiments['forest']['rmse']})
    return folds


def choose(folds):
    if not folds:
        return 'forest'
    means = {name: np.mean([row[name] for row in folds]) for name in MODELS}
    threshold = min(means.values()) * 1.01 + 1e-9
    return next(name for name in MODELS if means[name] <= threshold)


def group_projection(encoding):
    groups = list(encoding.indices)
    projection = np.zeros((encoding.width, len(groups)))
    for i, name in enumerate(groups):
        projection[encoding.indices[name], i] = 1
    return groups, projection


def correlation_groups(x, encoding, kinds):
    numeric = [name for name in encoding.indices if kinds[name] == 'numeric']
    if len(numeric) < 2:
        return []
    coef = np.corrcoef(x[:, [encoding.indices[name][0] for name in numeric]], rowvar=False)
    groups = [{name} for name in numeric]
    for i, j in combinations(range(len(numeric)), 2):
        if abs(coef[i, j]) >= .9:
            one, other = (next(group for group in groups if numeric[key] in group) for key in (i, j))
            if one is not other:
                one.update(other)
                groups = [group for group in groups if group is not other]
    return [sorted(group) for group in groups if len(group) > 1]


def permutation(fit, encoding, holdouts, keys):
    indices = np.concatenate([encoding.indices[name] for name in keys])
    rng = np.random.default_rng(SEED)
    scores = []
    for day, x, y, prediction in holdouts:
        if np.all(x[:, indices] == x[0, indices]):
            continue
        original = mean_absolute_error(y, prediction)
        trials = []
        for _ in range(5):
            changed = x.copy()
            changed[:, indices] = x[rng.permutation(len(x))[:, None], indices]
            trials.append(float(mean_absolute_error(y, fit.predict(changed)) - original))
        scores.append({'date': day, 'value': float(np.mean(trials))})
    return scores


def importance(fit, encoding, holdouts, groups, values, correlated):
    def details(keys):
        folds = permutation(fit, encoding, holdouts, keys)
        estimates = [item['value'] for item in folds]
        return {'value': float(np.mean(estimates)) if estimates else None,
                'low': min(estimates, default=None), 'high': max(estimates, default=None), 'folds': folds}

    columns = [{'key': name, 'meanAbsShap': float(np.mean(np.abs(values[:, i]))), **details([name])}
               for i, name in enumerate(groups)]
    return sorted(columns, key=lambda row: row['value'] if row['value'] is not None else -np.inf, reverse=True), [
        {'keys': keys, **details(keys)} for keys in correlated]


def temporal_group_importance(grouped, prior, selection, model):
    if len(prior) < MIN_TRAIN_DATES + MARKET_DATES:
        return None
    earlier, hold_days = prior[:-MARKET_DATES], prior[-MARKET_DATES:]
    unit_train = [row for day in earlier for row in grouped[day]]
    if len(unit_train) < MIN_TRAIN_ROWS:
        return None
    # Fit and select on data strictly earlier than this separate diagnostic holdout.
    features, kinds, _ = pick_features(selection[0], unit_train, *selection[1:])
    encoder = Encoding(unit_train, features, kinds)
    used = [key for key in encoder.indices if all(len({row['values'][key] for row in grouped[day]}) <= 1 for day in earlier)]
    if not used:
        return None
    model_name = choose(training_folds(grouped, earlier, *selection))
    fit = Fit(model_name, encoder.transform(unit_train), target(unit_train), SEED)
    indices = np.concatenate([encoder.indices[key] for key in used])
    tests = [(encoder.transform(grouped[day]), target(grouped[day])) for day in hold_days]
    if any(not np.all(x[:, indices] == x[0, indices]) for x, _ in tests):
        return None
    all_blocks = np.array([x[0, indices] for x, _ in tests])
    original = np.mean([mean_absolute_error(y, fit.predict(x)) for x, y in tests])
    rng = np.random.default_rng(SEED)
    results = []
    for _ in range(16):
        trial = []
        shift = rng.permutation(len(tests))
        for i, (x, y) in enumerate(tests):
            changed = x.copy()
            changed[:, indices] = all_blocks[shift[i]]
            trial.append(mean_absolute_error(y, fit.predict(changed)))
        results.append(float(np.mean(trial) - original))
    return {'keys': used, 'dates': hold_days, 'value': float(np.mean(results)), 'low': min(results), 'high': max(results),
            'trainedThrough': earlier[-1], 'model': MODELS[model_name],
            'mainModel': MODELS[model]}


def interaction_results(fit, encoding, encoded, last, groups, projection):
    if fit.name not in ('forest', 'extra') or len(groups) < 2:
        return []
    rng = np.random.default_rng(SEED)
    size = len(last)
    # Bound the two encoded p×p tensors, including when many features are categorical.
    limit = min(size, INTERACTION_MAX, max(8, 800_000 // (2 * encoding.width ** 2)))
    take = np.sort(rng.choice(size, limit, replace=False))
    values = fit.tree().shap_interaction_values(encoded[np.concatenate((take, take + size))])
    values = np.einsum('if,nij,jg->nfg', projection, np.asarray(values), projection, optimize=True)
    boot = rng.integers(0, limit, size=(36, limit))
    details = []
    for i, j in combinations(range(len(groups)), 2):
        first, final = values[:limit, i, j] * 2, values[limit:, i, j] * 2
        change = final - first
        low, high = np.quantile(np.mean(np.abs(final[boot]), axis=1), [.1, .9])
        strength = float(np.mean(np.abs(final)))
        delta = float(np.mean(change))
        details.append({'a': groups[i], 'b': groups[j], 'strength': strength, 'strengthBefore': float(np.mean(np.abs(first))),
                        'change': delta, 'changeInStrength': float(np.mean(np.abs(final)) - np.mean(np.abs(first))),
                        'rows': limit, 'population': size, 'estimated': limit != size, 'low': float(low), 'high': float(high),
                        'stable': bool(limit >= 24 and strength > 1e-9 and low >= .5 * strength),
                        'portfolioChange': None if limit != size else float(np.sum(change)), '_values': (first, final)})
    details.sort(key=lambda row: row['strength'], reverse=True)
    observed = [last[index] for index in take]
    for i, item in enumerate(details):
        first, final = item.pop('_values')
        if i < 12:
            item['profile'] = interaction_plot(final, observed, item['a'], item['b'])
            item['local'] = [{'id': row['id'], 'before': float(old), 'after': float(new), 'change': float(new - old)}
                             for row, old, new in zip(observed, first, final, strict=True)]
    return details


def stability_checks(training, first, last, features, kinds, name, reference):
    rng = np.random.default_rng(SEED + 1)
    ids = sorted({row['id'] for row in training})
    names = list(reference)
    reference_ranks = np.argsort(np.argsort([-abs(reference[key]) for key in names]))
    results, rankings = defaultdict(list), []
    for seed in (173, 941):
        kept = set(rng.choice(ids, max(1, int(.8 * len(ids))), replace=False))
        subset = [row for row in training if row['id'] in kept]
        encoder = Encoding(subset, features, kinds)
        if not encoder.width:
            continue
        groups, projection = group_projection(encoder)
        fit = Fit(name, encoder.transform(subset), target(subset), seed)
        values = fit.contributions(encoder.transform(first + last)) @ projection
        vals = dict(zip(groups, (values[len(first):] - values[:len(first)]).sum(axis=0)))
        current_ranks = np.argsort(np.argsort([-abs(vals.get(key, 0)) for key in names]))
        rankings.append(float(np.corrcoef(reference_ranks, current_ranks)[0, 1]) if len(names) > 1 else 1.)
        for key in names:
            results[key].append(float(vals.get(key, 0)))
    return results, {'refits': len(rankings), 'rankCorrelations': rankings, 'trainingIdFraction': .8, 'seeds': [173, 941]}


def drift(training, testing, keys, kinds):
    result = []
    for name in keys:
        a, b = ([row['values'][name] for row in rows] for rows in (training, testing))
        if kinds[name] == 'numeric':
            first, last = ([n for item in raw if (n := number(item)) is not None] for raw in (a, b))
            if not first or not last:
                continue
            spread = np.diff(np.quantile(first, [.25, .75]))[0]
            score = abs(float(np.median(last) - np.median(first)))
            if spread and score / spread >= 1:
                result.append({'key': name, 'measure': 'median_per_iqr', 'value': float(score / spread)})
        else:
            first, last = Counter(a), Counter(b)
            distance = sum(abs(first[key] / len(a) - last[key] / len(b)) for key in first.keys() | last.keys()) / 2
            if distance >= .25:
                result.append({'key': name, 'measure': 'total_variation', 'value': distance})
    return result


def analyze(panel, settings, *, protected=(), preferred=(), diagnostics=True):
    if settings.get('aggregation', 'sum') != 'sum':
        raise ValueError('Выберите суммируемую метрику. Средние и коэффициенты требуют иной формулы агрегации.')
    unit = settings.get('unit', '')
    if not isinstance(unit, str) or len(unit) > 20 or any(ord(char) < 32 for char in unit):
        raise ValueError('Единица измерения должна содержать до 20 символов.')
    rows, dates = resolve_rows(panel, settings)
    if len(dates) < 2:
        raise ValueError('Для изменения нужны снимки хотя бы на две даты.')
    before, after = settings.get('before') or dates[-2], settings.get('after') or dates[-1]
    if before not in dates or after not in dates or before >= after:
        raise ValueError('Выберите две отчётные даты в хронологическом порядке.')
    columns = [col.name for col in panel.columns if not preferred or col.name in preferred]
    all_columns = {col.name for col in panel.columns}
    excluded = {settings['dateColumn'], settings['idColumn'], settings['target'], *protected}
    selected = feature_strings(settings['features']) if settings.get('features') is not None else None
    forbidden = feature_strings(settings.get('forbidden', []))
    if (selected is not None and selected - all_columns) or forbidden - all_columns:
        raise ValueError('В настройках есть неизвестная колонка.')
    grouped = defaultdict(list)
    for row in rows:
        grouped[row['date']].append(row)
    older = [day for day in dates if day < before]
    training = [row for day in older for row in grouped[day]]
    features, kinds, audit = pick_features(columns, training, excluded, selected, forbidden)
    table0, table1 = ({row['id']: row for row in grouped[day]} for day in (before, after))
    common = sorted(table0.keys() & table1.keys())
    first, last = ([table[key] for key in common] for table in (table0, table1))
    start, end = (fsum(target(grouped[day])) for day in (before, after))
    added = [table1[key] for key in sorted(table1.keys() - table0.keys())]
    removed = [table0[key] for key in sorted(table0.keys() - table1.keys())]
    additions, exclusions = fsum(target(added)), -fsum(target(removed))
    observed = fsum(target(last)) - fsum(target(first))
    available = [item['name'] for item in audit if item['eligible']]
    profile = {**panel.profile(), 'dates': dates, 'distinctIds': len({row['id'] for row in rows}), 'features': available}
    warnings = []
    limitations = ['Вклады описывают связи модели. Для вывода о причинах нужен отдельный эксперимент.',
                   'Вклады one-hot столбцов складываются по исходному полю. Это агрегация кодированных вкладов.',
                   'Отсутствующий ID трактуется как выбытие. Проверьте полноту снимков.']
    result = {
        'before': before, 'after': after, 'target': settings['target'], 'mode': 'ml', 'unit': unit.strip(),
        'method': 'matched-model-attribution-v2', 'start': start, 'end': end, 'change': end - start,
        'matched': len(common), 'added': len(added), 'removed': len(removed), 'additions': additions, 'exclusions': exclusions,
        'residual': observed, 'observedMatchedChange': observed, 'modelChange': None, 'numericalGap': None,
        'status': 'insufficient', 'reliable': False, 'factors': [], 'interactions': [], 'importance': [], 'effects': [], 'quality': [],
        'trainingDates': older, 'trainingRows': len(training), 'warnings': warnings, 'profile': profile, 'limitations': limitations,
        'availableFeatures': available, 'selectedFeatures': features, 'featureAudit': audit, 'diagnosticsReady': diagnostics,
        'timeline': [{'date': day, 'value': fsum(target(grouped[day])), 'count': len(grouped[day])} for day in dates],
    }
    if len(older) < MIN_TRAIN_DATES or len(training) < MIN_TRAIN_ROWS or len(common) < 8 or not features:
        warnings.append('Для оценки вкладов нужны две даты до начала сравнения, 40 обучающих строк, 8 общих ID и изменчивые признаки.')
        return result
    encoder = Encoding(training, features, kinds)
    if not encoder.width:
        warnings.append('Признаки постоянны в периоде обучения.')
        return result
    groups, projection = group_projection(encoder)
    x_train, y_train = encoder.transform(training), target(training)
    quality = training_folds(grouped, older, columns, excluded, selected, forbidden)
    selected_model = choose(quality)
    fit = Fit(selected_model, x_train, y_train, SEED)
    encoded = encoder.transform(first + last)
    size = len(first)
    pred = fit.predict(encoded)
    values = fit.contributions(encoded) @ projection
    changes = values[size:] - values[:size]
    contributions = changes.sum(axis=0)
    model_change = fsum(pred[size:] - pred[:size])
    numerical_gap = model_change - fsum(contributions)
    tolerance = max(.0001, abs(model_change) * 1e-8, max(abs(start), abs(end)) * 1e-13)
    if abs(numerical_gap) > tolerance:
        raise ValueError('Вклады модели не сходятся с изменением её предсказания.')
    rng = np.random.default_rng(SEED)
    samples = np.array([changes[rng.integers(0, size, size=size)].sum(axis=0) for _ in range(100)])
    low, high = np.quantile(samples, [.1, .9], axis=0)
    by_date = [{row['name']: row for row in distribution(cohort, groups, kinds)} for cohort in (first, last)]
    factors = sorted([
        {'key': name, 'value': float(contributions[i]), 'low': float(low[i]), 'high': float(high[i]),
         'before': by_date[0][name], 'after': by_date[1][name],
         'signStability': float(np.mean(np.sign(samples[:, i]) == np.sign(contributions[i])))}
        for i, name in enumerate(groups)
    ], key=lambda item: abs(item['value']), reverse=True)
    holdouts = [(day, encoder.transform(grouped[day]), target(grouped[day])) for day in (before, after)]
    predictions = [(day, x, y, fit.predict(x)) for day, x, y in holdouts]
    validations = [{'date': day, **metrics(y, prediction), 'median': metrics(y, np.full(len(y), np.median(y_train)))}
                   for day, _, y, prediction in predictions]
    aggregate_error = float(validations[1]['aggregateError'] - validations[0]['aggregateError'])
    residual = observed - model_change
    residual_limit = ratio_limit('SPECTRUM_RESIDUAL_LIMIT', .35)
    residual_ratio = abs(residual) / max(.01, abs(observed))
    if residual_ratio > residual_limit:
        warnings.append('Необъяснённый остаток велик относительно изменения по общим наблюдениям.')
    enough_folds = len(quality) >= 2
    beats_median = selected_model != 'median' and sum(row['mae'] for row in validations) < sum(row['median']['mae'] for row in validations)
    aggregate_valid = abs(aggregate_error) <= max(.01, abs(end - start) * residual_limit)
    if not enough_folds:
        warnings.append('До начала сравнения мало независимых проверочных дат для выбора модели.')
    if not beats_median:
        warnings.append('На двух датах сравнения модель не обошла медианный ориентир. Связи требуют проверки.')
    if not aggregate_valid:
        warnings.append('Ошибка изменения портфельной суммы выше порога. Проверьте выводы по агрегату.')
    drift_rows = drift(training, grouped[after], groups, kinds)
    if drift_rows:
        warnings.append('На конечную дату изменилось распределение части признаков относительно обучения.')
    correlated = correlation_groups(x_train, encoder, kinds)
    if correlated:
        warnings.append('Коррелирующие признаки могут делить вклад. Доступна совместная перестановка группы.')
    date_constant = [name for name in groups if all(len({row['values'][name] for row in grouped[day]}) <= 1 for day in older)]
    if date_constant:
        limitations.append(f'Для общих признаков даты число независимых наблюдений равно {len(older)}. '
                           'Перестановка внутри даты для них не применяется.')
        if len(older) < MARKET_DATES:
            warnings.append('Рыночные признаки имеют мало независимых обучающих дат. Используйте расчётный эффект кривой для PV.')
    refits, stability = stability_checks(training, first, last, groups, kinds, selected_model,
                                        {item['key']: item['value'] for item in factors})
    for item in factors:
        item['refits'] = refits[item['key']]
    stable_rank = bool(stability['rankCorrelations']) and min(stability['rankCorrelations']) >= .5
    stable_sign = all(item['signStability'] >= .7 for item in factors[:2]
                      if abs(item['value']) > .05 * max(1, abs(model_change)))
    if not (stable_rank and stable_sign):
        warnings.append('Лидирующие вклады чувствительны к подвыборке или переобучению.')
    trained_model = {'key': selected_model, 'name': MODELS[selected_model], 'seed': SEED,
                     'parameters': fit.model.get_params(), 'versions': {'numpy': np.__version__, 'scikit-learn': sklearn.__version__,
                                                                      'shap': shap.__version__},
                     'features': groups, 'trainedThrough': older[-1], 'trainingDates': older, 'trainingRows': len(training)}
    criteria = {'selectionFolds': enough_folds, 'beatsMedianOnComparisonDates': beats_median,
                'aggregateChangeWithinLimit': aggregate_valid, 'residualWithinLimit': residual_ratio <= residual_limit,
                'stableRank': stable_rank, 'stableSign': stable_sign, 'noMajorDrift': not drift_rows,
                'sufficientSharedFactorDates': not date_constant or len(older) >= MARKET_DATES,
                'noCorrelatedFeatureGroups': not correlated}
    reliable = all(criteria.values())
    result.update(factors=factors, modelChange=model_change, numericalGap=numerical_gap, residual=residual,
                  quality=quality, validation=validations, aggregateChangeError=aggregate_error, model=trained_model,
                  stability=stability, residualRatio=residual_ratio, residualLimit=residual_limit,
                  drift=drift_rows, correlated=correlated, dateConstant=date_constant,
                  status='stable' if reliable else 'caution', reliable=reliable, criteria=criteria)
    if diagnostics:
        importance_rows, group_scores = importance(fit, encoder, predictions, groups, values[size:], correlated)
        scale = float(np.std(y_train))
        max_effect_sample = min(600, size)
        take = np.sort(rng.choice(size, max_effect_sample, replace=False))
        sample = [last[index] for index in take]
        result.update(importance=importance_rows, groupedImportance=group_scores,
                      marketImportance=temporal_group_importance(grouped, older, (columns, excluded, selected, forbidden), selected_model) if date_constant else None,
                      interactions=interaction_results(fit, encoder, encoded, last, groups, projection),
                      effects=[effect_curve(fit, encoder, item, sample, values[size:][take], groups, scale, SEED)
                               for item in factors])
    return result
