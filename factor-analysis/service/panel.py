"""Validate tabular snapshots and describe usable columns before modelling."""

from __future__ import annotations

import csv
import io
import math
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime

MAX_ROWS = 20_000
MAX_COLUMNS = 80
MAX_FEATURES = 16
NULL = {"", "na", "n/a", "null", "none", "nan"}


def number(value):
    text = value.replace("\N{NO-BREAK SPACE}", "").replace("\N{NARROW NO-BREAK SPACE}", "")
    text = text.replace(" ", "").replace(",", ".").replace("\N{MINUS SIGN}", "-")
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text):
        return None
    converted = float(text)
    return converted if math.isfinite(converted) and abs(converted) <= 1e15 else None


def iso_date(value):
    try:
        if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", value):
            return datetime.strptime(value, "%d.%m.%Y").date().isoformat()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return date.fromisoformat(value).isoformat()
    except ValueError:
        pass
    return None


@dataclass(frozen=True)
class Column:
    name: str
    kind: str
    missing: int
    distinct: int
    min: float | None
    max: float | None
    outliers: int | None


@dataclass(frozen=True)
class Panel:
    columns: tuple[Column, ...]
    rows: tuple[dict, ...]

    def profile(self):
        return {"rows": len(self.rows), "columns": [vars(column) for column in self.columns]}

    def report_options(self, date_column):
        self.column(date_column)
        values = [iso_date(row[date_column]) for row in self.rows]
        if any(value is None for value in values):
            raise ValueError("Колонка даты должна быть заполнена в каждой строке. Формат ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.")
        return sorted(set(values))

    def column(self, name):
        for column in self.columns:
            if column.name == name:
                return column
        raise ValueError("В таблице отсутствует указанная колонка.")


def extract_csv(text):
    if not isinstance(text, str) or len(text.encode()) > 6_000_000:
        raise ValueError("Загрузите UTF-8 CSV размером до 6 МБ.")
    normalized = text.lstrip("\ufeff").strip()
    try:
        dialect = csv.Sniffer().sniff(normalized[:16_384], delimiters=",;\t")
    except csv.Error:
        try:
            first = normalized.splitlines()[0]
        except IndexError as error:
            raise ValueError("Файл пуст.") from error
        # Sniffer can fail if a variety of values occur lower in the file.
        dialect = max((",", ";", "\t"), key=lambda separator: len(next(csv.reader([first], delimiter=separator))))
    stream = io.StringIO(normalized)
    iterator = csv.reader(stream, dialect=dialect) if not isinstance(dialect, str) else csv.reader(stream, delimiter=dialect)
    row_names = tuple(name.strip() for name in next(iterator, ()))
    if len(row_names) < 3 or len(row_names) > MAX_COLUMNS or len(set(row_names)) != len(row_names):
        raise ValueError("Нужно от 3 до 80 неповторяющихся колонок, включая дату, ID и метрику.")
    if any(not name or len(name) > 100 for name in row_names):
        raise ValueError("Проверьте заголовки колонок. Максимум 100 символов.")
    result = []
    for line_number, values in enumerate(iterator, 2):
        if not values or not any(value.strip() for value in values):
            continue
        if len(values) != len(row_names) or any(len(value) > 300 for value in values):
            raise ValueError(f"Строка {line_number} не соответствует заголовкам или содержит ячейку длиннее 300 символов.")
        if len(result) == MAX_ROWS:
            raise ValueError("До 20 000 строк на один анализ.")
        result.append(dict(zip(row_names, (value.strip() for value in values), strict=True)))
    if not result:
        raise ValueError("В файле есть только заголовки.")
    columns = tuple(profile_column(name, [row[name] for row in result]) for name in row_names)
    return Panel(columns, tuple(result))


def profile_column(name, values):
    good = [value for value in values if value.lower() not in NULL]
    values_as_numbers = [number(value) for value in good]
    if good and all(value is not None for value in values_as_numbers):
        kind = "numeric"
        distinct = len(set(values_as_numbers))
        ordered = sorted(values_as_numbers)
        minimum, maximum = ordered[0], ordered[-1]
        q1, q3 = quantile(ordered, 0.25), quantile(ordered, 0.75)
        spread = q3 - q1
        outliers = sum(value < q1 - 1.5 * spread or value > q3 + 1.5 * spread for value in ordered) if spread > 0 else None
    else:
        kind = "date" if good and all(iso_date(value) for value in good) else "category"
        distinct = len(set(good))
        minimum = maximum = None
        outliers = None
    return Column(name, kind, len(values) - len(good), distinct, minimum, maximum, outliers)


def quantile(ordered, fraction):
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (position - lower) * (ordered[upper] - ordered[lower])


def discover(panel, excluded, *, names=()):
    result = []
    for col in panel.columns:
        if col.name in excluded or (names and col.name not in names):
            continue
        if col.kind == "date" or col.distinct <= 1 or col.missing > len(panel.rows) / 2:
            continue
        if col.kind == "category" and col.distinct > 30:
            continue
        if re.search(r"(?:^|[_\W])(?:id|код|номер|идентификатор)(?:$|[_\W])", col.name.casefold()):
            continue
        result.append(col.name)
    return result


def resolve_rows(panel, settings):
    date_col, id_col, target_col = (settings.get(key, "") for key in ("dateColumn", "idColumn", "target"))
    columns = (date_col, id_col, target_col)
    if any(not isinstance(col, str) for col in columns) or len(set(columns)) != 3:
        raise ValueError("Укажите разные колонки для ID, даты и цели.")
    dates = panel.report_options(date_col)
    panel.column(id_col)
    if panel.column(target_col).kind != "numeric":
        raise ValueError("Выберите числовую целевую метрику.")
    rows, seen = [], set()
    for item in panel.rows:
        key = (iso_date(item[date_col]), item[id_col])
        if key[1].lower() in NULL:
            raise ValueError("У каждой строки должен быть ID сделки или наблюдения.")
        if key in seen:
            raise ValueError(f"ID {key[1]} повторяется на дату {key[0]}. Оставьте по одной строке на ID и дату.")
        seen.add(key)
        value = number(item[target_col])
        if value is None:
            raise ValueError("Выбранная метрика должна быть заполнена числом в каждой строке. Проверьте CSV.")
        rows.append({"date": key[0], "id": key[1], "observed": value, "values": item})
    rows.sort(key=lambda row: (row["date"], row["id"]))
    return rows, dates


def distribution(rows, features, kinds):
    facts = []
    for name in features:
        values = [row["values"][name] for row in rows]
        if kinds[name] == "numeric":
            observed = [value for raw in values if (value := number(raw)) is not None]
            facts.append({"name": name, "kind": "numeric", "count": len(observed),
                          "mean": sum(observed) / len(observed) if observed else None})
        else:
            observed = [raw for raw in values if raw.lower() not in NULL]
            facts.append({"name": name, "kind": "category", "count": len(observed),
                          "levels": dict(Counter(observed).most_common(8))})
    return facts


ID_LABEL = re.compile(r'(?:^|[_\W])(?:id|uid|guid|код|номер|идентификатор)(?:$|[_\W])', re.I)
FUTURE_LABEL = re.compile(r'(?:^|[_\W])(?:future|lead\d*|next|t\+\d+|after|будущ\w*|следующ\w*|после)(?:$|[_\W])', re.I)


def feature_audit(names, rows, excluded, forbidden=()):
    """Determine eligibility using the training prefix only."""
    import numpy as np

    observed = np.array([row['observed'] for row in rows], dtype=float)
    results = []
    for name in names:
        reason = None
        raw = [row['values'][name] for row in rows]
        col = profile_column(name, raw)
        if name in excluded:
            reason = 'Выбранная дата, ID, метрика или другая расчётная метрика'
        elif name in forbidden:
            reason = 'Колонка исключена пользователем'
        elif ID_LABEL.search(name):
            reason = 'Потенциальный технический идентификатор'
        elif FUTURE_LABEL.search(name):
            reason = 'Название указывает на значение из будущего или после даты наблюдения'
        elif not rows:
            reason = 'Нет наблюдений до начала сравнения'
        elif col.missing > len(rows) / 2:
            reason = 'Более 50% пропусков в обучающих строках'
        elif col.kind == 'date':
            reason = 'Дата требует отдельного временного преобразования'
        elif col.distinct <= 1:
            reason = 'Значение постоянно в обучающем периоде'
        elif col.kind == 'category' and col.distinct > 30:
            reason = 'Более 30 категорий в обучающем периоде'
        elif col.kind == 'numeric':
            values = np.array([np.nan if (value := number(text)) is None else value for text in raw])
            valid = np.isfinite(values)
            if np.sum(valid) >= 20 and np.ptp(observed[valid]) > 0:
                corr = np.corrcoef(values[valid], observed[valid])[0, 1]
                if abs(corr) >= 0.99999999:
                    reason = 'Почти точное линейное преобразование цели. Проверьте утечку'
        results.append({'name': name, 'kind': col.kind, 'eligible': reason is None, 'reason': reason,
                        'missing': col.missing, 'distinct': col.distinct})
    return results
