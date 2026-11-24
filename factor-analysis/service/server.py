"""Local HTTP entry point for the integrated Spectrum workspace."""

from __future__ import annotations

import argparse
import base64
import binascii
from dataclasses import replace
from decimal import Decimal
from hashlib import sha256
import csv
import json
import logging
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen
from uuid import uuid4

from .assistant_context import curve_evidence, data_evidence, pair_key, portfolio_evidence, scenario_evidence, stable_key
from .assistant_privacy import policy
from .attribution import analyze, feature_strings, pick_features
from .config import load_env
from .cash_details import calculate_cash_details
from .explanations import StaleDialog, explain
from .history import MAX_ARCHIVE, pack, revalue, unpack
from .llm import provider, model_endpoint
from .reporting import export, safe_dataset
from .integration import (CODES, FEATURES, LABELS, ROOT, SCENARIOS, TARGETS, CurvesClient, core_path,
                          curves_url, market_curve_run, portfolio_history, read_rows, selected_curve_ref, validated_snapshot_curves)
from .panel import discover, extract_csv, iso_date, number, profile_column, resolve_rows
from .valuation import actual_pv, analyze_valuation, load_snapshot
from . import curve_ui

load_env(ROOT)
DATA = Path(os.environ.get("SPECTRUM_DATA_DIR", ROOT / ".local" / "runs")).resolve()
STATIC = ROOT / "src" / "studio"
ID = r"[a-f0-9]{32}"
DAY = r"\d{4}-\d{2}-\d{2}"
MAX_BODY = 7_000_000
SIGNALS = {"dateColumn": "date", "idColumn": "deal_id", "target": "npv"}
LOCK = threading.Lock()
WORKSPACE_WRITE = threading.Lock()
JOBS = {}
LOG = logging.getLogger("spectrum")
ARCHIVE_BODY = (MAX_ARCHIVE * 4 // 3) + 8192
REPORT_EXPORTS = r"analysis\.json|analysis\.html|factors\.csv|interactions\.csv|quality\.csv|cash-details\.csv"
INTEGRATED = {"integrated", "historical"}


class StaleReport(ValueError):
    pass


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


def atomic_write(path, value):
    with NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temp = Path(output.name)
        try:
            output.write(value)
            output.close()
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def run_folder(workspace_id):
    if not isinstance(workspace_id, str) or not re.fullmatch(ID, workspace_id):
        raise ValueError("Укажите существующий рабочий набор.")
    folder = DATA / workspace_id
    if not folder.is_dir():
        raise FileNotFoundError(workspace_id)
    return folder


def current():
    try:
        folder = run_folder((DATA / "current").read_text().strip())
        return json.loads((folder / "workspace.json").read_bytes())
    except FileNotFoundError:
        return None


def publish(folder, workspace, *, active=True):
    report = workspace.get("report")
    if report and report.get("analysisId"):
        (folder / "reports").mkdir(exist_ok=True)
        atomic_write(folder / "reports" / (report["analysisId"] + ".json"), json_bytes(report))
    atomic_write(folder / "workspace.json", json_bytes(workspace))
    if active:
        atomic_write(DATA / "current", folder.name.encode())


def load(folder):
    return json.loads((folder / "workspace.json").read_bytes())


def active_revision(workspace, request):
    expected = request.get("analysisId")
    if expected is not None:
        current_report = (current() or {}).get("report") or {}
        if not re.fullmatch(ID, str(expected)) or current_report.get("analysisId") != expected \
                or (workspace.get("report") or {}).get("analysisId") != expected:
            raise StaleReport("Отчёт изменился. Повторите запрос для текущего расчёта.")


def assistant_revision(workspace, request, active):
    revision = (workspace.get('report') or {}).get('analysisId')
    if request.get('analysisId') != revision or revision and (
            active is None or active['id'] != workspace['id'] or (active.get('report') or {}).get('analysisId') != revision):
        raise StaleReport('Отчёт изменился. Повторите запрос для текущего расчёта.')
    if not revision and request.get('page', 'analysis') == 'analysis':
        raise ValueError('Сначала выполните анализ.')


def assistant_period(workspace, selected):
    periods = workspace.get('periods') or []
    period = next((item for item in periods if item['date'] == selected), None) if selected is not None else next(reversed(periods), None)
    if not period:
        raise ValueError('На выбранную дату нет расчётного снимка.')
    return period


def assistant_context(workspace, folder, request, page):
    if page == 'analysis':
        selection = request.get('analysisFocus')
        if selection is None:
            return {}
        if not isinstance(selection, dict) or set(selection) != {'kind', 'item'}:
            raise ValueError('Выберите детализацию текущего отчёта.')
        kind, item = selection['kind'], selection['item']
        report = workspace['report']
        if kind == 'effect' and isinstance(item, str) and any(row['key'] == item for row in report.get('effects', [])):
            key = 'effect.' + stable_key(item)
        elif kind == 'interaction' and type(item) is int and 0 <= item < len(report['interactions']):
            pair = report['interactions'][item]
            key = pair_key(pair['a'], pair['b'])
        else:
            raise ValueError('Выбранная детализация отсутствует в текущей ревизии.')
        return {'focus': key, 'identity': key}
    if page == 'data':
        if not workspace.get('profile'):
            raise ValueError('Загрузите данные для профилирования.')
        return {'facts': data_evidence(workspace)}
    if page == 'curves':
        return assistant_curve_context(workspace, request)
    period = assistant_period(workspace, request.get('reportDate'))
    if page == 'scenarios':
        selected = request.get('scenario')
        if selected is not None and selected not in CODES[1:]:
            raise ValueError('Выберите рассчитанный стресс-сценарий.')
        facts, scenario = scenario_evidence(period, selected)
        return {'facts': facts, 'identity': (period['date'], period['runId'], scenario)}
    contracts = read_rows(folder / period['date'] / 'calculator_input.csv', ';')
    return {'facts': portfolio_evidence(workspace, period, contracts), 'identity': (period['date'], period['runId'])}


def assistant_curve_context(workspace, request):
    selected = request.get('scenario', 'base')
    if selected not in CODES:
        raise ValueError('Выберите рассчитанную кривую.')
    reference = request.get('curveRef')
    selected_date, run_id = selected_curve_ref(reference)
    text = selected_date.isoformat()
    archive = request.get('curveWorkspaceId')
    public = False
    if archive is not None:
        folder = run_folder(archive)
        work = workspace if archive == workspace.get('id') else load(folder)
        period = assistant_period(work, text)
        if period['runId'] != run_id:
            raise StaleReport('Выбранная кривая отличается от сохранённого снимка.')
        result = json.loads((folder / text / 'curves' / 'standard-result.json').read_bytes(), parse_float=Decimal)
        validated_snapshot_curves(result, selected_date)
        public = policy(work)[0] == 'aggregate'
    else:
        client = CurvesClient(curves_url())
        route = '/curve-runs/' + run_id
        run, _ = client.request(route)
        if run.get('status') != 'ready' or run.get('reportDate') != text or run.get('runId') != run_id:
            raise ValueError('На выбранную дату нужен готовый запуск кривых.')
        result, _ = client.request(route + '/result')
        if result.get('runId') != run_id or result.get('reportDate') != text \
                or result.get('usedParameters') != run.get('usedParameters'):
            raise ValueError('Результат не совпадает с выбранным запуском кривых.')
        if run.get('dataProvenance') == 'market' and run['usedParameters'].get('mode') == 'standard':
            validated_snapshot_curves(result, selected_date)
            public = True
    if result['runId'] != run_id:
        raise StaleReport('Результат не совпадает с выбранным снимком кривых.')
    facts, scenario = curve_evidence(result, selected, archive is not None)
    return {'facts': facts, 'identity': (text, run_id, archive, scenario), 'public': public, 'private': not public}


def text_of(folder):
    return (folder / "dataset.csv").read_text(encoding="utf-8-sig")


def data_options(panel, integrated):
    if integrated:
        return {**SIGNALS, "targets": list(TARGETS), "labels": LABELS,
                "candidateFeatures": discover(panel, {"date", "deal_id", *TARGETS}, names=FEATURES),
                "scenarios": SCENARIOS, "dates": panel.report_options("date"), "unit": "₽"}
    valid_dates = [col.name for col in panel.columns if col.kind == "date" and not col.missing]
    numeric = [col.name for col in panel.columns if col.kind == "numeric" and not col.missing]
    date_col = next((col for col in valid_dates if col.casefold() in
                     ("date", "report_date", "report_dttm", "дата", "отчётная дата")), valid_dates[0] if valid_dates else "")
    id_col = next((col.name for col in panel.columns if col.name != date_col and col.name.casefold() in
                   ("instrument_id", "deal_id", "id", "идентификатор", "номер сделки")), "")
    numeric = [col for col in numeric if col not in (date_col, id_col)]
    target = next((col for col in numeric if col.casefold() in ("npv", "pv", "present_value", "цель")),
                  numeric[0] if numeric else "")
    return {"dateColumn": date_col, "idColumn": id_col, "target": target, "targets": numeric,
            "labels": {}, "candidateFeatures": discover(panel, {date_col, id_col, target})}


def save_integration(settings, update):
    folder = DATA / uuid4().hex
    folder.mkdir()
    details = portfolio_history(settings, folder, update)
    update(len(details["periods"]), len(details["periods"]), "Сверка выгрузок и расчёт вкладов")
    return compute(folder, extract_csv(text_of(folder)), {"id": folder.name, **details},
                   {**SIGNALS, "mode": "valuation", "scenario": "base"})


def revalue_portfolio(request, update):
    workspace = current()
    if not workspace or workspace["id"] != request.get("workspaceId"):
        raise StaleReport("Открыт другой рабочий набор. Обновите страницу перед переоценкой.")
    active_revision(workspace, request)
    day, run_id = selected_curve_ref(request.get("curveSelection"))
    period = next((p for p in workspace.get("periods", []) if p["date"] == day.isoformat()), None)
    if period is None:
        raise ValueError("Эта дата отсутствует в сохранённом портфеле.")
    if period["runId"] == run_id:
        raise ValueError("Этот запуск уже использован для выбранной даты.")
    update(0, len(workspace["periods"]), "Проверяем готовый запуск кривых команды 2")
    curves, raw = market_curve_run(CurvesClient(curves_url()), day, run_id)
    folder = DATA / uuid4().hex
    folder.mkdir()
    details = revalue(run_folder(workspace["id"]), folder, workspace, day, curves, raw, update)
    result = workspace["report"]
    update(len(details["periods"]), len(details["periods"]), "Сверка переоценки и новое разложение NPV")
    return compute(folder, extract_csv(text_of(folder)), details,
                   {**SIGNALS, "mode": "valuation", "scenario": "base", "before": result.get("before"), "after": result.get("after")})


def import_history(encoded, update, provenance=None):
    if not isinstance(encoded, str) or len(encoded) > ARCHIVE_BODY:
        raise ValueError("Импортируйте ZIP размером до 16 МБ.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("ZIP не удалось прочитать.") from error
    folder = DATA / uuid4().hex
    folder.mkdir()
    details = unpack(raw, folder, update)
    if provenance == "bank" and details["portfolioSource"] != "synthetic":
        details["portfolioSource"] = "bank"
    return compute(folder, extract_csv(text_of(folder)), {"id": folder.name, **details},
                   {**SIGNALS, "mode": "valuation", "scenario": "base"})


def import_dataset(text, filename):
    panel = extract_csv(text)
    folder = DATA / uuid4().hex
    folder.mkdir()
    atomic_write(folder / "dataset.csv", text.encode())
    options = data_options(panel, False)
    profile = panel.profile()
    dates = []
    if options["dateColumn"]:
        dates = panel.report_options(options["dateColumn"])
    profile.update(dates=dates, distinctIds=len({row[options["idColumn"]] for row in panel.rows}) if options["idColumn"] else None,
                   preview=list(panel.rows[:5]))
    result = {"id": folder.name, "source": "imported", "portfolioSource": "external", "filename": Path(filename).name[:120],
              "options": options, "profile": profile, "report": None,
              "setupError": "Проверьте колонки, даты и единицу измерения в разделе «Данные»."}
    publish(folder, result, active=False)
    return result


def scenario_panel(folder, panel, periods, scenario):
    snapshots = {item['date']: load_snapshot(folder, item['date']) for item in periods}
    rows = []
    for row in panel.rows:
        snapshot = snapshots[row['date']]
        value = actual_pv(snapshot, row['deal_id'], scenario)
        rows.append({**row, 'stress_delta': str(value)})
    profile = profile_column('stress_delta', [row['stress_delta'] for row in rows])
    return replace(panel, rows=tuple(rows), columns=tuple(profile if col.name == 'stress_delta' else col for col in panel.columns))


def compute(folder, dataset, workspace, settings, *, diagnostics=False, revision=None):
    integrated = workspace['source'] in INTEGRATED
    target = settings.get('target', 'npv' if integrated else '')
    mode = settings.get('mode') or ('valuation' if integrated and target in ('npv', 'stress_delta') else 'ml')
    if mode not in ('valuation', 'ml'):
        raise ValueError('Выберите расчётный или ML-режим.')
    scenario = settings.get('scenario') or (workspace.get('scenario', 'parallel_up') if target == 'stress_delta' else 'base')
    if integrated:
        if not isinstance(scenario, str) or scenario not in CODES:
            raise ValueError('Укажите сценарий из согласованного набора.')
        if target not in TARGETS:
            raise ValueError('Укажите показатель для совместного расчёта.')
        if target == 'stress_delta' and scenario == 'base':
            scenario = 'parallel_up'
        settings = {**settings, 'dateColumn': 'date', 'idColumn': 'deal_id', 'unit': '₽'}
    if mode == 'valuation':
        if not integrated or target not in ('npv', 'stress_delta'):
            raise ValueError('Для расчётного режима выберите NPV или ΔPV и загрузите снимки калькулятора и кривых.')
        report = analyze_valuation(folder, workspace['periods'], settings.get('before'), settings.get('after'),
                                   'base' if target == 'npv' else scenario)
        if workspace.get('source') == 'historical':
            report['limitations'].append('Отсутствующий в снимке ID трактуется как выбытие. Проверьте полноту поставленных данных.')
    else:
        if integrated and target == 'stress_delta' and scenario != workspace.get('scenario'):
            dataset = scenario_panel(folder, dataset, workspace['periods'], scenario)
        report = analyze(dataset, {**settings, 'target': target}, protected=TARGETS if integrated else (),
                         preferred=FEATURES if integrated else (), diagnostics=diagnostics)
        if integrated:
            metadata = ('date', 'runId', 'sha256', 'curveSource', 'curveProvenance', 'curveParameters',
                        'curveCompletedAt', 'source')
            report['sources'] = [{key: item[key] for key in metadata if key in item} for item in workspace['periods']]
            if target == 'stress_delta':
                report['scenario'] = scenario
        else:
            report['sources'] = [{'filename': workspace['filename'], 'sha256': sha256((folder / 'dataset.csv').read_bytes()).hexdigest()}]
    options = data_options(dataset, integrated)
    options.update({key: settings[key] for key in ('dateColumn', 'idColumn')}, target=target,
                   unit=report['unit'], dates=report['profile']['dates'])
    canonical = {key: settings[key] for key in ('dateColumn', 'idColumn', 'features', 'forbidden', 'aggregation') if key in settings}
    report.update(schemaVersion=2, workspaceId=folder.name, analysisId=revision or uuid4().hex,
                  labels=options['labels'], dataSource=workspace.get('portfolioSource', 'synthetic' if integrated else 'external'),
                  portfolioSettings=workspace.get('settings'),
                  settings={**canonical, 'target': target, 'unit': report['unit'], 'before': report['before'], 'after': report['after'],
                            'mode': mode, 'scenario': scenario})
    result = {**workspace, 'profile': {**dataset.profile(), **(workspace.get('profile') or {}), **report['profile']},
              'options': options, 'report': report, 'setupError': ''}
    publish(folder, result)
    return result


def start_job(task, initial="Подготовка портфеля"):
    if not WORKSPACE_WRITE.acquire(blocking=False):
        raise ValueError("Дождитесь окончания текущего расчёта.")
    with LOCK:
        ident = uuid4().hex
        for item in list(JOBS)[:-8]:
            del JOBS[item]
        JOBS[ident] = {"id": ident, "state": "running", "done": 0, "total": 1, "message": initial}

    def update(done, total, message):
        with LOCK:
            JOBS[ident].update(done=done, total=total, message=message)

    def work():
        try:
            workspace = task(update)
        except ValueError as error:
            with LOCK:
                JOBS[ident].update(state="failed", message=str(error))
        except (OSError, subprocess.TimeoutExpired) as error:
            LOG.error("Local task failed: %s", type(error).__name__)
            with LOCK:
                JOBS[ident].update(state="failed", message="Не удалось завершить чтение или расчёт. Проверьте локальный стенд.")
        except Exception as error:
            LOG.error("Analytics task failed: %s", type(error).__name__)
            with LOCK:
                JOBS[ident].update(state="failed", message="Внутренняя ошибка аналитики. Подробности в журнале сервера.")
        else:
            with LOCK:
                JOBS[ident].update(state="ready", message="Расчёт готов", workspaceId=workspace["id"],
                                   analysisId=workspace["report"]["analysisId"])
        finally:
            WORKSPACE_WRITE.release()

    threading.Thread(target=work, daemon=True).start()
    return ident


def analysis_task(request, *, diagnostics=False, update=lambda *_: None):
    folder = run_folder(request.get('workspaceId'))
    workspace = load(folder)
    active_revision(workspace, request)
    if diagnostics:
        report = workspace.get('report')
        if not report or not report.get('analysisId'):
            raise ValueError('Сначала рассчитайте основной отчёт.')
        if report['mode'] == 'valuation':
            if report.get('cashDetails') and not report['cashDetails'].get('message'):
                return workspace
            detail = calculate_cash_details(folder, report, update)
            workspace = {**workspace, 'report': {**report, 'cashDetails': detail}}
            publish(folder, workspace)
            return workspace
        if report.get('diagnosticsReady'):
            return workspace
        return compute(folder, extract_csv(text_of(folder)), workspace, report['settings'], diagnostics=True,
                       revision=report['analysisId'])
    return compute(folder, extract_csv(text_of(folder)), workspace, request, diagnostics=not request.get('background'))


def preview_config(request):
    if request.get('aggregation', 'sum') != 'sum':
        raise ValueError('Для средних и коэффициентов нужна другая формула агрегации. Выберите суммируемую метрику.')
    folder = run_folder(request.get('workspaceId'))
    panel = extract_csv(text_of(folder))
    rows, dates = resolve_rows(panel, request)
    if len(dates) < 2:
        raise ValueError('Нужны наблюдения на двух разных датах.')
    before, after = request.get('before') or dates[-2], request.get('after') or dates[-1]
    if before not in dates or after not in dates or before >= after:
        raise ValueError('Выберите даты в хронологическом порядке.')
    excluded = {request['dateColumn'], request['idColumn'], request['target']}
    names = [item.name for item in panel.columns]
    if load(folder)['source'] in INTEGRATED:
        excluded.update(TARGETS)
        names = [name for name in names if name in FEATURES]
    training = [row for row in rows if row['date'] < before]
    features = feature_strings(request['features']) if request.get('features') is not None else None
    excluded_features = feature_strings(request.get('forbidden', []))
    picked, _, audit = pick_features(names, training, excluded, features, excluded_features)
    return {'dates': dates, 'before': before, 'after': after, 'trainingRows': len(training), 'featureAudit': audit,
            'distinctIds': len({row['id'] for row in rows}), 'featureCount': len(picked),
            'message': f'Колонки проверены. Обучающих строк {len(training)}, кандидатов в модель {len(picked)}.'}


def available_backup():
    workspace = current()
    if workspace and workspace.get('report') and not workspace['report'].get('analysisId'):
        settings = workspace['report']
        source = workspace.get('options', {})
        settings = {**settings, **{key: source[key] for key in ('dateColumn', 'idColumn') if key in source}}
        folder = run_folder(workspace['id'])
        try:
            compute(folder, extract_csv(text_of(folder)), workspace, settings)
        except (ValueError, FileNotFoundError):
            LOG.warning('Old report could not be upgraded. Open a new analysis to select a mode.')


def live_ok(url):
    try:
        with urlopen(url, timeout=1.8) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def services():
    try:
        core_path()
        calculator = True
    except ValueError:
        calculator = False
    selected = provider()
    status = selected.status
    if selected.name == "local" and status == "available":
        status = "available" if live_ok(model_endpoint() + "/models") else "unavailable"
    if selected.name == "deepseek" and status == "available":
        status = "configured"
    return {"calculator": calculator, "curves": live_ok(curves_url().rstrip("/") + "/openapi.json"),
            "llm": status in ("available", "configured"), "ai": {"provider": selected.name, "status": status}}


class Handler(BaseHTTPRequestHandler):
    server_version = "Spectrum"

    def send_data(self, status, data, mime, name=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        if name:
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reply(self, value, status=200):
        self.send_data(status, json_bytes(value), "application/json; charset=utf-8")

    def verify_request(self):
        expected = self.headers.get("Host", "")
        host = expected.partition(":")[0]
        origin = self.headers.get("Origin")
        if host not in ("127.0.0.1", "localhost") or (origin and origin != "http://" + expected):
            self.reply({"error": "Откройте «Спектр» по локальному адресу."}, 403)
            return False
        return True

    def payload(self, maximum=MAX_BODY):
        try:
            size = int(self.headers.get("Content-Length") or "0")
        except ValueError as exc:
            raise ValueError("Некорректный размер запроса.") from exc
        if size < 1 or size > maximum or self.headers.get_content_type() != "application/json":
            raise ValueError("Проверьте формат и размер запроса.")
        result = json.loads(self.rfile.read(size))
        if not isinstance(result, dict):
            raise ValueError("Ожидается объект JSON.")
        return result

    def do_GET(self):
        if not self.verify_request():
            return
        try:
            url = urlsplit(self.path)
            path = url.path
            if path in ("/", "/index.html"):
                return self.static("index.html", "text/html")
            mime = {"/studio.css": "text/css", "/studio.mjs": "text/javascript",
                    "/charts.mjs": "text/javascript", "/views.mjs": "text/javascript",
                    "/spectrum.svg": "image/svg+xml", "/InterVariable.woff2": "font/woff2"}
            if path in mime:
                return self.static(path[1:], mime[path])
            if path in ("/curve-ui/curves.js", "/curve-ui/curves.css"):
                content_type = "text/javascript" if path.endswith(".js") else "text/css"
                result = (curve_ui.assets() / path.rsplit("/", 1)[-1]).read_bytes()
                return self.send_data(200, result, content_type + "; charset=utf-8")
            if path.startswith("/api/v1/"):
                return self.curve_request("GET", url)
            if path == "/favicon.ico":
                return self.send_data(204, b"", "image/x-icon")
            if path == "/api/workspace":
                return self.reply(current())
            if path == "/api/services":
                return self.reply(services())
            if (match := re.fullmatch(r"/api/summary/(" + ID + ")/(" + ID + ")", path)):
                folder = run_folder(match[1]) / 'reports'
                saved = folder / (match[2] + '.summary.json')
                return self.reply(json.loads(saved.read_bytes()) if saved.is_file() else None)
            if (match := re.fullmatch(r"/api/job/(" + ID + ")", path)):
                with LOCK:
                    job = JOBS.get(match[1], {}).copy()
                return self.reply(job or {"error": "Запуск не найден."}, 200 if job else 404)
            if path == "/api/example.csv":
                return self.download(ROOT / "examples" / "analysis.csv", 'spectrum-example.csv')
            if (match := re.fullmatch(r"/api/export/(" + ID + ")/reports/(" + ID + ")/(" + REPORT_EXPORTS + ")", path)):
                folder = run_folder(match[1]) / 'reports'
                report = json.loads((folder / (match[2] + '.json')).read_bytes())
                summary = folder / (match[2] + '.summary.json')
                if not summary.is_file():
                    summary = folder / (match[2] + '.ai.json')
                include = parse_qs(url.query).get('includeSummary', ['1']) == ['1']
                ai = json.loads(summary.read_bytes()) if include and summary.is_file() else None
                data, mime = export(report, match[3], ai)
                return self.send_data(200, data, mime + '; charset=utf-8', match[3])
            if (match := re.fullmatch(r"/api/export/(" + ID + r")/history\.zip", path)):
                folder = run_folder(match[1])
                workspace = load(folder)
                if not workspace.get('periods'):
                    raise ValueError('В этом наборе есть только аналитическая таблица.')
                return self.send_data(200, pack(folder, workspace['periods'], workspace.get('portfolioSource', 'synthetic')),
                                      'application/zip', 'spectrum-history.zip')
            if (match := re.fullmatch(r"/api/export/(" + ID + r")/(dataset\.csv|workspace\.json)", path)):
                folder = run_folder(match[1])
                if match[2] == 'dataset.csv':
                    return self.send_data(200, safe_dataset(folder / match[2]), 'text/csv; charset=utf-8', match[2])
                return self.download(folder / match[2], match[2])
            if (match := re.fullmatch(r"/api/export/(" + ID + ")/(" + DAY +
                                      r")/(calculator_input\.csv|cashflows\.csv|deal_summary\.csv|discounted_deal_summary\.csv|discounted_cashflows\.csv|standard-result\.json)", path)):
                folder = run_folder(match[1]) / match[2]
                name = match[3]
                source = folder if name == "calculator_input.csv" else folder / ("curves" if name.endswith(".json") else "core")
                return self.download(source / name, name)
            if (match := re.fullmatch(r"/api/(deals|flows)/(" + ID + ")", path)):
                return self.reply(self.instrument_data(match[1], match[2], parse_qs(url.query)))
            return self.reply({"error": "Страница не найдена."}, 404)
        except FileNotFoundError:
            self.reply({"error": "Файл или расчёт не найден."}, 404)
        except (ValueError, csv.Error) as error:
            self.reply({"error": str(error)}, 400)

    def do_POST(self):
        if not self.verify_request():
            return
        try:
            url = urlsplit(self.path)
            path = url.path
            if path.startswith("/api/v1/"):
                return self.curve_request("POST", url, json_bytes(self.payload(curve_ui.MAX_CURVE_REQUEST)))
            max_body = {'/api/import-history': ARCHIVE_BODY, '/api/explain': 8192}.get(path, MAX_BODY)
            request = self.payload(max_body)
            if path == "/api/run":
                return self.reply({"job": start_job(lambda update: save_integration(request, update))}, 202)
            if path == "/api/revalue":
                return self.reply({"job": start_job(lambda update: revalue_portfolio(request, update))}, 202)
            if path == '/api/import-history':
                task = lambda update: import_history(request.get('archive'), update, request.get('provenance'))
                return self.reply({'job': start_job(task, 'Проверка архива исторических снимков')}, 202)
            if path == '/api/import':
                if not WORKSPACE_WRITE.acquire(blocking=False):
                    return self.reply({'error': 'Дождитесь окончания текущего расчёта.'}, 409)
                try:
                    return self.reply(import_dataset(request.get('text', ''), str(request.get('filename', 'dataset.csv'))))
                finally:
                    WORKSPACE_WRITE.release()
            if path == '/api/profile':
                return self.reply(preview_config(request))
            if path in ('/api/analyze', '/api/diagnostics'):
                detail = path == '/api/diagnostics'
                if detail or request.get('background') is True:
                    task = lambda update: analysis_task(request, diagnostics=detail, update=update)
                    return self.reply({'job': start_job(task, 'Расчёт аналитических показателей')}, 202)
                if not WORKSPACE_WRITE.acquire(blocking=False):
                    return self.reply({'error': 'Дождитесь окончания текущего расчёта.'}, 409)
                try:
                    return self.reply(analysis_task(request))
                finally:
                    WORKSPACE_WRITE.release()
            if path == '/api/explain':
                page = request.get('page', 'analysis')
                if page not in ('analysis', 'data', 'scenarios', 'portfolio', 'curves'):
                    raise ValueError('Выберите область объяснения.')
                identifier = request.get('workspaceId')
                folder = run_folder(identifier) if identifier is not None or page != 'curves' else None
                workspace = load(folder) if folder else {}
                assistant_revision(workspace, request, current())
                context = assistant_context(workspace, folder, request, page)
                summary = request.get('summary') is True
                rendered = explain(workspace, request.get('question', ''), allow_external=request.get('allowExternal') is True,
                                   focus_factor=request.get('focusFactor'), page=page, context=context,
                                   dialog_id=request.get('dialogId'), summary=summary)
                latest = load(folder) if folder else workspace
                assistant_revision(latest, request, current())
                if summary and rendered['analysisId'] and rendered['facts']:
                    atomic_write(folder / 'reports' / (rendered['analysisId'] + '.summary.json'), json_bytes(rendered))
                return self.reply(rendered)
            return self.reply({"error": "Страница не найдена."}, 404)
        except FileNotFoundError:
            self.reply({"error": "Рабочий набор не найден."}, 404)
        except (StaleReport, StaleDialog) as error:
            self.reply({"error": str(error)}, 409)
        except (ValueError, csv.Error) as error:
            self.reply({"error": str(error)}, 400)
        except Exception as error:
            LOG.error("Request failed: %s", type(error).__name__)
            self.reply({"error": "Внутренняя ошибка. Подробности в журнале сервера."}, 500)

    def download(self, path, filename):
        mime = "text/csv" if filename.endswith(".csv") else "application/json"
        data = safe_dataset(path, ';' if filename == 'calculator_input.csv' else ',') if filename.endswith('.csv') else path.read_bytes()
        return self.send_data(200, data, mime + "; charset=utf-8", filename)

    def curve_request(self, method, url, body=None):
        status, data = curve_ui.proxy(method, url.path, url.query, body)
        return self.send_data(status, data, "application/json; charset=utf-8")

    def static(self, name, mime):
        return self.send_data(200, (STATIC / name).read_bytes(), mime if mime.startswith("font/") else mime + "; charset=utf-8")

    def instrument_data(self, mode, workspace_id, args):
        folder = run_folder(workspace_id)
        workspace = json.loads((folder / "workspace.json").read_bytes())
        selected = args.get("date", [""])[0]
        if not selected or iso_date(selected) != selected:
            raise ValueError("Укажите отчётную дату.")
        options = workspace["options"]
        query = args.get("q", [""])[0][:100].casefold()
        if mode == "flows":
            identifier = args.get("id", [""])[0]
            root = folder / selected
            inputs = read_rows(root / "calculator_input.csv", ";")
            contract = next((row for row in inputs if row["deal_id"] == identifier), None)
            if contract is None:
                raise FileNotFoundError()
            fields = ("side", "currency_id", "deal_dttm", "maturity_dttm", "current_principal_amt",
                      "interest_rate", "base_indicator_rate", "rate_type_cd", "discriminator")
            summary = next((row for row in read_rows(root / "core" / "deal_summary.csv")
                            if row["instrument_id"] == identifier), {})
            return {"id": identifier, "date": selected,
                    "contract": {key: contract[key] for key in fields if contract.get(key)},
                    "totals": {key: summary[key] for key in ("total_principal", "total_interest") if summary.get(key)},
                    "prices": {row["curveCode"]: row["present_value"]
                               for row in read_rows(root / "core" / "discounted_deal_summary.csv") if row["instrument_id"] == identifier},
                    "rows": [row for row in read_rows(root / "core" / "cashflows.csv") if row["instrument_id"] == identifier]}
        index = max(0, int(args.get("page", ["0"])[0]))
        date_col, id_col = options["dateColumn"], options["idColumn"]
        if not date_col or not id_col:
            raise ValueError("Сначала выберите колонки даты и ID.")
        dataset = extract_csv(text_of(folder))
        selected_rows = [
            row for row in dataset.rows if iso_date(row[date_col]) == selected and query in row[id_col].casefold()
        ]
        selected_rows.sort(key=lambda row: (row[id_col].casefold() != query, -(number(row.get("principal", "")) or 0)))
        return {"date": selected, "size": len(selected_rows), "page": index, "pageSize": 25,
                "rows": selected_rows[index * 25:(index + 1) * 25]}

    def log_message(self, template, *args):
        LOG.debug(template, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SPECTRUM_PORT", "8780")))
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    available_backup()
    with ThreadingHTTPServer((args.bind, args.port), Handler) as application:
        print(f"Спектр открыт на http://127.0.0.1:{application.server_port}", flush=True)
        application.serve_forever()


if __name__ == "__main__":
    main()
