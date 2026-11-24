"""Ground local language-model answers in facts from the selected analysis."""

from __future__ import annotations

import json
import os
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .integration import LABELS


class DirectRequest(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def model_endpoint():
    url = os.environ.get("SPECTRUM_LLM_URL", "http://127.0.0.1:8089/v1")
    parts = urlsplit(url)
    if (parts.scheme not in ("http", "https") or parts.hostname not in ("localhost", "127.0.0.1", "::1")
            or parts.username or parts.password or parts.query or parts.fragment):
        raise ValueError("Для объяснений укажите локальный адрес LLM.")
    return url.rstrip("/")


def fact_library(report, labels, unit):
    def amount(value):
        return f"{value:,.2f}".replace(",", "\xa0").replace(".", ",") + unit

    first, last = report["before"], report["after"]
    target = labels.get(report["target"], report["target"])
    facts = {
        "overview": {
            "title": "Изменение показателя", "source": "#waterfall",
            "text": f"Показатель «{target}» изменился с {amount(report['start'])} на {first} "
                    f"до {amount(report['end'])} на {last}. Изменение составило {amount(report['change'])}.",
        },
        "cohort": {
            "title": "Состав портфеля", "source": "#waterfall",
            "text": f"На обе даты найдено {report['matched']} общих сделок. "
                    f"Появившиеся сделки дали {amount(report['additions'])}, выбывшие дали {amount(report['exclusions'])}.",
        },
        "residual": {
            "title": "Необъяснённая часть", "source": "#waterfall",
            "text": f"Модель оставила необъяснёнными {amount(report['residual'])}. "
                    "Это разница между изменением наблюдаемой метрики и суммой учтённых вкладов.",
        },
        "caution": {
            "title": "Границы вывода", "source": "#quality",
            "text": "Вклады описывают связи в модели. Для вывода о причинах нужен отдельный дизайн исследования.",
        },
    }
    for i, item in enumerate(report["factors"]):
        title = labels.get(item["key"], item["key"])
        facts[f"factor_{i}"] = {
            "title": title, "source": "#waterfall",
            "text": f"Модельный вклад фактора «{title}» в изменение по общим сделкам составил {amount(item['value'])}.",
        }
    for i, item in enumerate(report["interactions"]):
        first = labels.get(item["a"], item["a"])
        second = labels.get(item["b"], item["b"])
        facts[f"pair_{i}"] = {
            "title": f"{first} × {second}", "source": "#interactions",
            "text": f"Средний абсолютный совместный вклад «{first}» и «{second}» на конечную дату "
                    f"составил {amount(item['strength'])} на сделку по {item['rows']} наблюдениям.",
        }
    if not report["interactions"]:
        facts["no_pair"] = {
            "title": "Взаимодействия", "source": "#interactions",
            "text": "Для оценки взаимодействий нужно достаточно общих сделок и минимум два изменчивых признака.",
        }
    if report["quality"]:
        folds = report["quality"]

        def mean(key):
            return amount(sum(fold[key] for fold in folds) / len(folds))

        facts["quality"] = {
            "title": "Проверка качества", "source": "#quality",
            "text": f"На {len(folds)} проверочных датах средняя абсолютная ошибка модели за сделку "
                    f"составила {mean('forest')}, линейного ориентира {mean('linear')}.",
        }
    else:
        facts["quality"] = {
            "title": "Проверка качества", "source": "#quality",
            "text": "Для оценки ошибки модели пока недостаточно проверочных дат.",
        }
    if report["warnings"]:
        facts["warning"] = {
            "title": "Устойчивость", "source": "#quality",
            "text": " ".join(report["warnings"]),
        }
    return facts


def scope(facts, question):
    text = question.casefold()
    catalog, required = [], []
    if any(fragment in text for fragment in ("взаим", "пара фактор", "парн", "совместн", "вместе")):
        pairs = [key for key in facts if key.startswith("pair_")]
        named = [key for key in pairs if matches_name(facts[key]["title"], text)]
        catalog = (named or pairs)[:6] + ["caution"]
        required = catalog[:1]
        if not pairs:
            catalog = ["no_pair", "quality", "caution"]
            required = ["no_pair"]
    elif any(fragment in text for fragment in ("устойч", "довер", "качеств", "ошибк", "точност", "mae", "проверк")):
        catalog = ["quality", "warning", "caution"]
        required = ["quality"]
    elif "остаток" in text and any(fragment in text for fragment in ("необъяс", "остаточн", "модель")):
        catalog = ["residual", "warning", "quality"]
        required = ["residual"]
    elif any(fragment in text for fragment in ("появил", "добавил", "новые сделк", "выбы", "состав")):
        catalog = ["cohort", "overview", "residual"]
        required = ["cohort"]
    elif not text or any(fragment in text for fragment in ("npv", "pv", "фактор", "вклад", "влия", "измен", "портф", "показат", "стоимост")):
        factors = [key for key in facts if key.startswith("factor_")]
        named = [key for key in factors if matches_name(facts[key]["title"], text)]
        catalog = ["overview", "cohort", *(named or factors)[:4], "residual", "warning"]
        required = named[:1] or ["overview", "cohort", *factors[:1]]
    return [key for key in catalog if key in facts], [key for key in required if key in facts]


def matches_name(title, text):
    return any(len(part) > 4 and part[:-2] in text for part in title.casefold().split())


def explain(workspace, question):
    if not isinstance(question, str) or len(question) > 300:
        raise ValueError("Вопрос должен содержать до 300 символов.")
    report = workspace.get("report")
    if report is None:
        raise ValueError("Сначала выполните анализ.")
    integrated = workspace["source"] == "integrated"
    facts = fact_library(report, LABELS if integrated else {}, " ₽" if integrated else "")
    catalog, required = scope(facts, question)
    if not catalog:
        return {"mode": "facts", "model": None, "facts": [],
                "empty": "В расчёте нет подтверждённых данных для ответа."}
    model = os.environ.get("SPECTRUM_LLM_MODEL", "mlx-community/Qwen2.5-1.5B-Instruct-4bit")
    example = json.dumps({"facts": required or catalog[:1]})
    system = (
        'You route questions about an NPV calculation to the verified facts. Output JSON only. '
        f'Example answer: {example}. Select the most relevant IDs. '
        'Factors and pairs are listed in order of measured contribution. '
        'Prefer the specifically mentioned feature or pair. For largest contributions, choose the first factors and cohort. '
        'For an unrelated question return {"facts":[]}. Use only IDs in the catalog.'
    )
    content = json.dumps({"question": question or "Кратко объясни результат", "fact_catalog": {
        key: facts[key]["title"] for key in catalog
    }}, ensure_ascii=False)
    request_data = {"model": model, "temperature": 0, "max_tokens": 110,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}]}
    used_llm = False
    try:
        request = Request(model_endpoint() + "/chat/completions", json.dumps(request_data).encode(),
                          {"Content-Type": "application/json"})
        with build_opener(DirectRequest).open(request, timeout=25) as response:
            reply = json.load(response)["choices"][0]["message"]["content"].strip()
        fence = chr(96) * 3
        if reply.startswith(fence) and reply.endswith(fence):
            reply = reply.split("\n", 1)[-1][:-3].strip()
        keys = json.loads(reply)["facts"]
        if isinstance(keys, list):
            keys = [key for key in keys if isinstance(key, str) and key in catalog]
            used_llm = bool(keys)
        else:
            keys = []
    except (URLError, OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
        keys = []
    combined = keys if used_llm else catalog[:4]
    keys = list(dict.fromkeys([*required, *combined]))[:5]
    if keys and "warning" in facts and "warning" not in keys:
        keys = [*keys[:4], "warning"]
    return {
        "mode": "llm" if used_llm else "facts",
        "model": model if used_llm else None,
        "facts": [facts[key] for key in dict.fromkeys(keys)],
        "empty": "В расчёте нет подтверждённых данных для ответа." if not keys else "",
    }
