"""Local HTTP entry point for the integrated Spectrum workspace."""

from __future__ import annotations

import argparse
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

from .attribution import analyze
from .explanations import explain, model_endpoint
from .integration import FEATURES, LABELS, ROOT, TARGETS, core_path, curves_url, portfolio_history, read_rows
from .panel import discover, extract_csv, iso_date, number

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


def publish(folder, workspace):
    atomic_write(folder / "workspace.json", json_bytes(workspace))
    atomic_write(DATA / "current", folder.name.encode())


def text_of(folder):
    return (folder / "dataset.csv").read_text(encoding="utf-8-sig")


def data_options(panel, integrated):
    if integrated:
        return {**SIGNALS, "targets": list(TARGETS), "labels": LABELS,
                "candidateFeatures": discover(panel, {"date", "deal_id", *TARGETS}, names=FEATURES)}
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
    ident = uuid4().hex
    folder = DATA / ident
    folder.mkdir()
    details = portfolio_history(settings, folder, update)
    dataset = extract_csv(text_of(folder))
    update(len(details["periods"]), len(details["periods"]), "Проверка модели и расчёт вкладов")
    return compute(folder, dataset, {"id": ident, **details}, SIGNALS)


def import_dataset(text, filename):
    panel = extract_csv(text)
    ident = uuid4().hex
    destination = DATA / ident
    destination.mkdir()
    atomic_write(destination / "dataset.csv", text.encode())
    options = data_options(panel, False)
    report = None
    setup_error = ""
    if all(options.get(key) for key in SIGNALS):
        try:
            report = analyze(panel, options)
        except ValueError as error:
            setup_error = str(error)
    info = {"id": ident, "source": "imported", "filename": Path(filename).name[:120],
            "options": options, "profile": panel.profile(), "report": report, "setupError": setup_error}
    publish(destination, info)
    return info


def compute(folder, dataset, workspace, settings):
    integrated = workspace["source"] == "integrated"
    if integrated:
        settings = {**settings, "dateColumn": "date", "idColumn": "deal_id"}
        if settings.get("target") not in TARGETS:
            raise ValueError("Выберите показатель, рассчитанный для этого набора.")
    report = analyze(dataset, settings, protected=TARGETS if integrated else (),
                     preferred=FEATURES if integrated else ())
    options = {**data_options(dataset, integrated), **{key: settings[key] for key in SIGNALS}}
    info = {**workspace, "profile": dataset.profile(), "options": options, "report": report, "setupError": ""}
    publish(folder, info)
    return info


def start_job(settings):
    if not WORKSPACE_WRITE.acquire(blocking=False):
        raise ValueError("Дождитесь окончания текущего расчёта.")
    with LOCK:
        ident = uuid4().hex
        for item in list(JOBS)[:-8]:
            del JOBS[item]
        JOBS[ident] = {"id": ident, "state": "running", "done": 0, "total": 1, "message": "Подготовка портфеля"}

    def update(done, total, message):
        with LOCK:
            JOBS[ident].update(done=done, total=total, message=message)

    def work():
        try:
            workspace = save_integration(settings, update)
        except (ValueError, OSError, subprocess.TimeoutExpired) as error:
            with LOCK:
                JOBS[ident].update(state="failed", message=str(error))
        except Exception:
            LOG.exception("Portfolio run failed")
            with LOCK:
                JOBS[ident].update(state="failed", message="Внутренняя ошибка аналитики. Подробности в журнале сервера.")
        else:
            with LOCK:
                JOBS[ident].update(state="ready", message="Расчёт готов", workspaceId=workspace["id"])
        finally:
            WORKSPACE_WRITE.release()

    threading.Thread(target=work, daemon=True).start()
    return ident


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
    try:
        llm = live_ok(model_endpoint() + "/models")
    except ValueError:
        llm = False
    return {"calculator": calculator, "curves": live_ok(curves_url().rstrip("/") + "/openapi.json"), "llm": llm}


class Handler(BaseHTTPRequestHandler):
    server_version = "Spectrum"

    def send_data(self, status, data, mime, name=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
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

    def payload(self):
        try:
            size = int(self.headers.get("Content-Length") or "0")
        except ValueError as exc:
            raise ValueError("Некорректный размер запроса.") from exc
        if size < 1 or size > MAX_BODY or self.headers.get_content_type() != "application/json":
            raise ValueError("Ожидается JSON размером до 7 МБ.")
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
                    "/charts.mjs": "text/javascript", "/views.mjs": "text/javascript"}
            if path in mime:
                return self.static(path[1:], mime[path])
            if path == "/favicon.ico":
                return self.send_data(204, b"", "image/x-icon")
            if path == "/api/workspace":
                return self.reply(current())
            if path == "/api/services":
                return self.reply(services())
            if (match := re.fullmatch(r"/api/job/(" + ID + ")", path)):
                with LOCK:
                    job = JOBS.get(match[1], {}).copy()
                return self.reply(job or {"error": "Запуск не найден."}, 200 if job else 404)
            if (match := re.fullmatch(r"/api/export/(" + ID + r")/(dataset\.csv|workspace\.json)", path)):
                folder = run_folder(match[1])
                return self.download(folder / match[2], match[2])
            if (match := re.fullmatch(r"/api/export/(" + ID + ")/(" + DAY +
                                      r")/(calculator_input\.csv|cashflows\.csv|deal_summary\.csv|discounted_deal_summary\.csv|standard-result\.json)", path)):
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
            path = urlsplit(self.path).path
            request = self.payload()
            if path == "/api/run":
                return self.reply({"job": start_job(request)}, 202)
            if path == "/api/import":
                if not WORKSPACE_WRITE.acquire(blocking=False):
                    return self.reply({"error": "Дождитесь окончания текущего расчёта."}, 409)
                try:
                    return self.reply(import_dataset(request.get("text", ""), str(request.get("filename", "dataset.csv"))))
                finally:
                    WORKSPACE_WRITE.release()
            if path in ("/api/explain", "/api/analyze"):
                folder = run_folder(request.get("workspaceId"))
                workspace = json.loads((folder / "workspace.json").read_bytes())
                if path == "/api/explain":
                    return self.reply(explain(workspace, request.get("question", "")))
                if not WORKSPACE_WRITE.acquire(blocking=False):
                    return self.reply({"error": "Дождитесь окончания текущего расчёта."}, 409)
                try:
                    return self.reply(compute(folder, extract_csv(text_of(folder)), workspace, request))
                finally:
                    WORKSPACE_WRITE.release()
            return self.reply({"error": "Страница не найдена."}, 404)
        except FileNotFoundError:
            self.reply({"error": "Рабочий набор не найден."}, 404)
        except (ValueError, csv.Error) as error:
            self.reply({"error": str(error)}, 400)
        except Exception:
            LOG.exception("Request failed")
            self.reply({"error": "Внутренняя ошибка. Подробности в журнале сервера."}, 500)

    def download(self, path, filename):
        mime = "text/csv" if filename.endswith(".csv") else "application/json"
        return self.send_data(200, path.read_bytes(), mime + "; charset=utf-8", filename)

    def static(self, name, mime):
        return self.send_data(200, (STATIC / name).read_bytes(), mime + "; charset=utf-8")

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
            filename = folder / selected / "core" / "cashflows.csv"
            return {"id": identifier, "date": selected, "rows": [
                row for row in read_rows(filename) if row["instrument_id"] == identifier
            ]}
        index = max(0, int(args.get("page", ["0"])[0]))
        date_col, id_col = options["dateColumn"], options["idColumn"]
        if not date_col or not id_col:
            raise ValueError("Сначала выберите колонки даты и ID.")
        dataset = extract_csv(text_of(folder))
        selected_rows = [
            row for row in dataset.rows if iso_date(row[date_col]) == selected and query in row[id_col].casefold()
        ]
        selected_rows.sort(key=lambda row: -(number(row.get("principal", "")) or 0))
        return {"date": selected, "size": len(selected_rows), "page": index, "pageSize": 25,
                "rows": selected_rows[index * 25:(index + 1) * 25]}

    def log_message(self, template, *args):
        LOG.debug(template, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("SPECTRUM_PORT", "8780")))
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as application:
        print(f"Спектр открыт на http://127.0.0.1:{args.port}", flush=True)
        application.serve_forever()


if __name__ == "__main__":
    main()
