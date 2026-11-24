"""Same-origin access to the public routes used by the embedded curves UI."""

from http.client import HTTPException
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .integration import CurvesClient, curves_url


RUN = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
ROUTES = {
    "GET": re.compile(rf"/(?:input-rates|curve-preparations|curve-runs(?:/standard-result|/{RUN}(?:/result)?)?)"),
    "POST": re.compile(rf"/(?:curve-preparations|curve-runs(?:/{RUN}/recalculations)?)"),
}
MAX_REPLY = 8_000_000
MAX_CURVE_REQUEST = 16_384


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirect())


def assets():
    module = Path(__file__).resolve().parents[2] / "curves-module" / "frontend"
    return Path(os.environ.get("SPECTRUM_CURVE_ASSETS", module / "dist-spectrum"))


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
