"""Explain a change in an observed aggregate with grouped TreeSHAP."""

from __future__ import annotations

from collections import Counter, defaultdict
from itertools import combinations

import numpy as np
import shap
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, root_mean_squared_error
from sklearn.preprocessing import StandardScaler

from .panel import NULL, discover, distribution, number, resolve_rows

MIN_TRAIN_ROWS = 40
MIN_TRAIN_DATES = 2
SEED = 4317


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
                data[:, offset] = [number(value) if number(value) is not None else replacement for value in raw]
            else:
                codes = {level: i for i, level in enumerate(levels)}
                data[np.arange(len(rows)), [offset + codes.get(value, len(levels)) for value in raw]] = 1.0
        return data


def target(rows):
    return np.array([row["observed"] for row in rows])


def train(rows, features, kinds):
    encoding = Encoding(rows, features, kinds)
    if not encoding.width:
        return encoding, None
    model = RandomForestRegressor(n_estimators=64, max_depth=7, min_samples_leaf=4, random_state=SEED, n_jobs=1)
    model.fit(encoding.transform(rows), target(rows))
    return encoding, model


def rolling_validation(grouped, train_dates, validation_dates, features, kinds):
    folds, scores = [], defaultdict(list)
    for current in validation_dates[-5:]:
        previous = [day for day in train_dates if day < current]
        training = [row for day in previous for row in grouped[day]]
        if len(previous) < MIN_TRAIN_DATES or len(training) < MIN_TRAIN_ROWS:
            continue
        encoding, forest = train(training, features, kinds)
        testing = grouped[current]
        if forest is None or len(testing) < 5:
            continue
        x_train = encoding.transform(training)
        x_test = encoding.transform(testing)
        y_train, y_test = target(training), target(testing)
        scaler = StandardScaler().fit(x_train)
        baseline = Ridge(alpha=1.0).fit(scaler.transform(x_train), y_train)
        forest_pred = forest.predict(x_test)
        linear_pred = baseline.predict(scaler.transform(x_test))
        median_pred = np.full(len(y_test), np.median(y_train))
        forest_error = mean_absolute_error(y_test, forest_pred)
        folds.append({
            "date": current, "trainedThrough": previous[-1], "trainRows": len(training), "testRows": len(testing),
            "forest": forest_error, "linear": mean_absolute_error(y_test, linear_pred),
            "median": mean_absolute_error(y_test, median_pred),
            "rmse": root_mean_squared_error(y_test, forest_pred),
        })
        rng = np.random.default_rng(SEED)
        for name, indices in encoding.indices.items():
            if np.all(x_test[:, indices] == x_test[0, indices]):
                continue
            trials = []
            for _ in range(5):
                shuffled = x_test.copy()
                shuffled[:, indices] = x_test[rng.permutation(len(x_test))[:, None], indices]
                trials.append(mean_absolute_error(y_test, forest.predict(shuffled)) - forest_error)
            scores[name].append({"date": current, "value": float(np.mean(trials))})
    return folds, scores


def group_projection(encoding):
    groups = list(encoding.indices)
    projection = np.zeros((encoding.width, len(groups)), dtype=np.float64)
    for i, name in enumerate(groups):
        projection[encoding.indices[name], i] = 1
    return groups, projection


def explain_matched(model, encoding, matched_before, matched_after):
    both = matched_before + matched_after
    encoded = encoding.transform(both)
    groups, project = group_projection(encoding)
    explainer = shap.TreeExplainer(model, model_output="raw", feature_perturbation="tree_path_dependent")
    shap_values = np.asarray(explainer.shap_values(encoded))
    predictions = model.predict(encoded)
    values = shap_values @ project
    size = len(matched_before)
    changes = values[size:] - values[:size]
    model_change = float(np.sum(predictions[size:] - predictions[:size]))
    contributions = changes.sum(axis=0)
    if abs(float(contributions.sum()) - model_change) > max(0.001, abs(model_change) * 1e-8):
        raise ArithmeticError("Вклады SHAP не сходятся с изменением оценки модели.")
    rng = np.random.default_rng(SEED)
    samples = np.vstack([changes[rng.integers(0, size, size=size)].sum(axis=0) for _ in range(100)])
    percentiles = np.quantile(samples, [0.1, 0.9], axis=0)
    factors = [
        {"key": name, "value": float(contributions[i]), "low": float(percentiles[0, i]),
         "high": float(percentiles[1, i])}
        for i, name in enumerate(groups)
    ]

    # Rows in one pair use the same sampled ID. One-hot levels are aggregated back to their original columns.
    take = np.sort(rng.choice(size, min(size, 180), replace=False))
    paired = np.concatenate((take, take + size))
    full = np.asarray(explainer.shap_interaction_values(encoded[paired]))
    interactions = np.einsum("if,nij,jg->nfg", project, full, project, optimize=True)
    details = []
    for i, j in combinations(range(len(groups)), 2):
        first = 2 * interactions[:len(take), i, j]
        last = 2 * interactions[len(take):, i, j]
        details.append({"a": groups[i], "b": groups[j], "strength": float(np.mean(np.abs(last))),
                        "change": float(np.mean(last - first)), "rows": len(take)})
    details.sort(key=lambda item: item["strength"], reverse=True)
    importance = {name: float(np.mean(np.abs(values[size:, i]))) for i, name in enumerate(groups)}
    return {
        "factors": factors, "modelChange": model_change, "interactions": details,
        "meanAbsShap": importance, "encoded": encoded, "values": values,
        "factorsInModel": groups,
    }


def effect_curve(model, encoding, feature, sample, attributed, groups):
    name = feature["key"]
    data = encoding.transform(sample)
    for spec_name, _, levels in encoding.specs:
        if spec_name == name:
            break
    column = encoding.indices[name][0]
    if levels is not None:
        groups_by_value = defaultdict(list)
        index = groups.index(name)
        for row, values in zip(sample, attributed, strict=True):
            raw = row["values"][name]
            label = raw if raw in levels else "Прочие / пропуски"
            groups_by_value[label].append(values[index])
        return {"key": name, "kind": "category", "points": [
            {"x": level, "value": float(np.mean(values)), "support": len(values)}
            for level, values in groups_by_value.items() if len(values) >= 3
        ]}
    valid = np.array([number(row["values"][name]) is not None for row in sample])
    data = data[valid]
    values = data[:, column]
    if len(values) < 20:
        return {"key": name, "kind": "numeric", "points": []}
    edges = np.unique(np.quantile(values, np.linspace(0, 1, min(8, len(values) // 10 + 1))))
    if len(edges) < 3:
        return {"key": name, "kind": "numeric", "points": []}
    bins = np.searchsorted(edges[1:-1], values, side="left")
    accumulated, points = 0.0, []
    for index in range(len(edges) - 1):
        current = data[bins == index]
        if not len(current):
            continue
        lo, hi = edges[index:index + 2]
        at_lo, at_hi = current.copy(), current.copy()
        at_lo[:, column] = lo
        at_hi[:, column] = hi
        local = float(np.mean(model.predict(at_hi) - model.predict(at_lo)))
        points.append({"x": float((lo + hi) / 2), "value": accumulated + local / 2,
                       "lower": float(lo), "upper": float(hi), "support": len(current)})
        accumulated += local
    centered = sum(point["value"] * point["support"] for point in points) / len(data)
    for point in points:
        point["value"] -= centered
    return {"key": name, "kind": "numeric", "points": points}


def optional_figure(value):
    return float(value) if value is not None else None


def analyze(panel, settings, *, protected=(), preferred=()):
    rows, dates = resolve_rows(panel, settings)
    if len(dates) < 2:
        raise ValueError("Для изменения нужны снимки хотя бы на две даты.")
    before_day, after_day = settings.get("before") or dates[-2], settings.get("after") or dates[-1]
    if before_day not in dates or after_day not in dates or before_day >= after_day:
        raise ValueError("Выберите две отчётные даты в хронологическом порядке.")
    columns = {col.name: col for col in panel.columns}
    excluded = {settings["dateColumn"], settings["idColumn"], settings["target"], *protected}
    available = discover(panel, excluded, names=preferred)
    selection = settings.get("features")
    if selection is not None and (not isinstance(selection, list) or any(not isinstance(name, str) for name in selection)):
        raise ValueError("Выберите допустимые признаки из списка.")
    if selection is not None and (len(set(selection)) != len(selection) or any(item not in available for item in selection)):
        raise ValueError("В набор факторов попали неизвестные колонки или колонки с пропусками более 50%.")
    features = available if selection is None else selection
    kinds = {name: columns[name].kind for name in features}
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["date"]].append(row)
    older = [day for day in dates if day < before_day]
    considered = [day for day in dates if day <= after_day]
    training = [row for day in older for row in grouped[day]]
    before = {row["id"]: row for row in grouped[before_day]}
    after = {row["id"]: row for row in grouped[after_day]}
    matched = sorted(before.keys() & after.keys())
    first = [before[deal] for deal in matched]
    last = [after[deal] for deal in matched]
    start, end = sum(target(grouped[before_day])), sum(target(grouped[after_day]))
    added = [after[deal] for deal in after.keys() - before.keys()]
    removed = [before[deal] for deal in before.keys() - after.keys()]
    additions, exclusions = sum(target(added)), -sum(target(removed))
    observed_matched = sum(target(last)) - sum(target(first))
    profile = panel.profile()
    profile.update({"dates": dates, "distinctIds": len(set(row["id"] for row in rows)), "features": available})

    result = {
        "before": before_day, "after": after_day, "target": settings["target"],
        "start": float(start), "end": float(end), "change": float(end - start),
        "matched": len(matched), "added": len(added), "removed": len(removed),
        "additions": float(additions), "exclusions": float(exclusions), "residual": float(observed_matched),
        "factors": [], "interactions": [], "importance": [], "effects": [], "quality": [],
        "trainingDates": older, "trainingRows": len(training), "warnings": [], "profile": profile,
        "availableFeatures": available, "selectedFeatures": features,
        "timeline": [{"date": day, "value": float(sum(target(grouped[day]))), "count": len(grouped[day])}
                     for day in dates],
        "reliable": False,
    }
    if len(older) < MIN_TRAIN_DATES or len(training) < MIN_TRAIN_ROWS or len(matched) < 8 or not features:
        result["warnings"].append(
            "Для оценки вкладов нужны минимум две даты обучения до начала сравнения, 40 строк обучения, 8 общих сделок и изменчивые признаки."
        )
        return result
    encoding, model = train(training, features, kinds)
    if model is None:
        result["warnings"].append("Признаки постоянны в периоде обучения. Выберите другой период или загрузите историю.")
        return result
    parts = explain_matched(model, encoding, first, last)
    # Use an expanding training window and never give a holdout date to its estimator.
    folds, scores = rolling_validation(grouped, considered, considered, features, kinds)
    before_facts = {item["name"]: item for item in distribution(first, features, kinds)}
    after_facts = {item["name"]: item for item in distribution(last, features, kinds)}
    factors = sorted(parts["factors"], key=lambda item: abs(item["value"]), reverse=True)
    for item in factors:
        name = item["key"]
        item.update({"before": before_facts[name], "after": after_facts[name]})
    importance = []
    for name in parts["factorsInModel"]:
        repeats = scores.get(name, [])
        values = [entry["value"] for entry in repeats]
        importance.append({
            "key": name, "value": optional_figure(np.mean(values) if values else None),
            "low": min(values) if values else None, "high": max(values) if values else None,
            "folds": repeats, "meanAbsShap": parts["meanAbsShap"][name],
        })
    importance.sort(key=lambda item: item["value"] if item["value"] is not None else -np.inf, reverse=True)
    residual = float(observed_matched - parts["modelChange"])
    if len(folds) < 2:
        result["warnings"].append("Пока мало проверочных дат для оценки устойчивости.")
    elif sum(fold["forest"] for fold in folds) >= min(
        sum(fold["median"] for fold in folds), sum(fold["linear"] for fold in folds)
    ):
        result["warnings"].append("Лес не обошёл лучший простой ориентир на проверочных датах. Вклады интерпретируйте осторожно.")
    if abs(residual) > max(0.01, abs(observed_matched) * 0.35):
        result["warnings"].append("Остаток велик относительно изменения по общим сделкам. Модель объяснила его частично.")
    result.update({
        "factors": factors, "interactions": parts["interactions"], "importance": importance, "quality": folds,
        "residual": residual, "reliable": not result["warnings"],
        "effects": [effect_curve(model, encoding, item, last, parts["values"][len(first):], parts["factorsInModel"])
                    for item in factors],
    })
    return result
