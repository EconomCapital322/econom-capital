"""Build the local curves UI and proxy its public API routes."""

from http.client import HTTPException
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .config import load_env
from .integration import ROOT, CurvesClient, curves_url


RUN = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
ROUTES = {
    "GET": re.compile(rf"/(?:input-rates|curve-preparations|curve-runs(?:/standard-result|/{RUN}(?:/result)?)?)"),
    "POST": re.compile(rf"/(?:curve-preparations|curve-runs(?:/{RUN}/recalculations)?)"),
}
MAX_REPLY = 8_000_000
MAX_CURVE_REQUEST = 16_384
FRONTEND = ROOT.parent / "curves-module" / "frontend"
BUILD_FILES = ("curves.css", "curves.js")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirect())


def assets():
    return Path(os.environ.get("SPECTRUM_CURVE_ASSETS", FRONTEND / "dist-spectrum"))


def build_local():
    target = assets().resolve()
    outputs = [target / name for name in BUILD_FILES]
    if all(path.is_file() for path in outputs):
        built_at = min(path.stat().st_mtime_ns for path in outputs)
        inputs = [*(FRONTEND / 'src').rglob('*'), FRONTEND / 'vite.config.ts', FRONTEND / 'package-lock.json']
        if all(path.stat().st_mtime_ns <= built_at for path in inputs if path.is_file()):
            return
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm or not (FRONTEND / "package-lock.json").is_file():
        raise FileNotFoundError("Для сборки нужны исходники команды 2 и npm.")

    print("Собираем встроенный интерфейс кривых…", flush=True)
    build_env = {key: value for key, value in os.environ.items()
                 if not key.startswith(("DEEPSEEK_", "SPECTRUM_"))}
    if not (FRONTEND / "node_modules" / "vite" / "package.json").is_file():
        subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=FRONTEND,
                       env=build_env, check=True, timeout=150)
    target.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=target, prefix=".build-") as staging:
        build_env["SPECTRUM_CURVE_BUILD_DIR"] = staging
        subprocess.run([npm, "run", "build:embedded"], cwd=FRONTEND,
                       env=build_env, check=True, timeout=90)
        for name in BUILD_FILES:
            (Path(staging) / name).replace(target / name)


def proxy(method, path, query, body=None):
    suffix = path.removeprefix("/api/v1")
    if not ROUTES[method].fullmatch(suffix):
        return 404, b'{"error":{"code":"NOT_FOUND"}}'
    if len(query) > 120:
        return 400, b'{"error":{"code":"INVALID_QUERY"}}'
    values = parse_qs(query, keep_blank_values=True)
    if values.keys() - {"reportDate"} or any(len(items) != 1 for items in values.values()):
        return 400, b'{"error":{"code":"INVALID_QUERY"}}'
    try:
        upstream = CurvesClient(curves_url()).base + suffix
        if values:
            upstream += "?" + urlencode(values, doseq=True)
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(upstream, data=body, headers=headers, method=method)
        try:
            reply = OPENER.open(request, timeout=15)
        except HTTPError as error:
            if not 400 <= error.code < 600:
                error.close()
                raise ValueError("Unexpected upstream response") from error
            reply = error
        with reply:
            data = reply.read(MAX_REPLY + 1)
            if len(data) > MAX_REPLY or reply.headers.get_content_type() != "application/json":
                raise ValueError("Unexpected upstream response")
            return reply.status, data
    except (HTTPException, OSError, ValueError):
        return 503, b'{"error":{"code":"CURVES_UNAVAILABLE"}}'


if __name__ == "__main__":
    load_env(ROOT)
    try:
        build_local()
    except (OSError, subprocess.SubprocessError):
        print("Сборка кривых недоступна. Проверьте Node.js 22.12+ и npm или запустите «Спектр» через Docker.",
              file=sys.stderr)
        sys.exit(1)
