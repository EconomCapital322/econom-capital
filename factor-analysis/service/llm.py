"""Bounded outbound provider calls. The provider returns a plan, never report data."""

from dataclasses import dataclass
import json
import math
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def flag(name, default=False):
    value = os.environ.get(name)
    return default if value is None else value.casefold() in ('1', 'true', 'yes', 'on')


def model_endpoint():
    url = os.environ.get('SPECTRUM_LLM_URL', 'http://127.0.0.1:8089/v1')
    parsed = urlsplit(url)
    if (parsed.scheme not in ('http', 'https') or parsed.hostname not in ('localhost', '127.0.0.1', '::1')
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError('Для локальной модели допустим только адрес на этом компьютере.')
    return url.rstrip('/')


def deepseek_endpoint():
    url = os.environ.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').rstrip('/')
    if url != 'https://api.deepseek.com':
        raise ValueError('Для DeepSeek допустим официальный HTTPS-адрес.')
    return url


def timeout():
    try:
        value = float(os.environ.get('SPECTRUM_LLM_TIMEOUT', '12'))
    except ValueError:
        return 12.
    return min(20., max(1., value)) if math.isfinite(value) else 12.


@dataclass(frozen=True)
class LLMProvider:
    name: str
    model: str = ''
    status: str = 'disabled'

    def complete(self, messages):
        raise ProviderError(self.status)


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class LocalProvider(LLMProvider):
    name: str = 'local'
    status: str = 'available'

    def complete(self, messages):
        return chat(model_endpoint(), self.model, messages)


@dataclass(frozen=True)
class DeepSeekProvider(LLMProvider):
    name: str = 'deepseek'
    status: str = 'available'

    def complete(self, messages):
        return chat(deepseek_endpoint(), self.model, messages, auth=os.environ['DEEPSEEK_API_KEY'].strip())


class DisabledProvider(LLMProvider):
    pass


def provider():
    selected = os.environ.get('SPECTRUM_LLM_PROVIDER', 'local').casefold()
    if not flag('SPECTRUM_LLM_ENABLED', True) or selected in ('off', 'disabled', 'facts'):
        return DisabledProvider('facts')
    try:
        if selected == 'deepseek':
            if not flag('SPECTRUM_ALLOW_EXTERNAL_LLM'):
                return DisabledProvider(selected, status='forbidden')
            key = os.environ.get('DEEPSEEK_API_KEY', '').strip()
            if not key or len(key) > 300 or any(not 33 <= ord(char) <= 126 for char in key):
                return DisabledProvider(selected, status='unconfigured')
            deepseek_endpoint()
            return DeepSeekProvider(model=os.environ.get('DEEPSEEK_MODEL') or 'deepseek-flash')
        if selected == 'local':
            model_endpoint()
            return LocalProvider(model=os.environ.get('SPECTRUM_LLM_MODEL') or 'mlx-community/Qwen2.5-1.5B-Instruct-4bit')
    except ValueError:
        pass
    return DisabledProvider(selected if selected in ('deepseek', 'local') else 'facts', status='unconfigured')


def chat(endpoint, model, messages, auth=None):
    data = {'model': model, 'messages': messages, 'temperature': 0, 'max_tokens': 300 if auth else 120, 'stream': False}
    headers = {'Content-Type': 'application/json'}
    if auth:
        data.update(response_format={'type': 'json_object'}, thinking={'type': 'disabled'})
        headers['Authorization'] = 'Bearer ' + auth
    body = json.dumps(data, ensure_ascii=False).encode()
    if len(body) > 16_384:
        raise ProviderError('context_limit')
    request = Request(endpoint + '/chat/completions', body, headers)
    opener = build_opener(ProxyHandler({}), NoRedirect)
    deadline = time.monotonic() + timeout()
    for attempt in range(2 if auth else 1):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('timeout')
            with opener.open(request, timeout=remaining) as response:
                raw = response.read(64_001)
            if len(raw) > 64_000:
                raise ProviderError('invalid_response')
            choice = json.loads(raw)['choices'][0]
            finish = choice.get('finish_reason')
            if finish in ('length', 'insufficient_system_resource', 'content_filter'):
                raise ProviderError('response_limit')
            output = choice['message']['content']
            if not isinstance(output, str) or not output.strip() or len(output) > 8_000:
                raise ProviderError('invalid_response')
            return output.strip()
        except HTTPError as error:
            transient = error.code in (429, 500, 502, 503, 504)
            status = {400: 'request_rejected', 401: 'authorization', 402: 'payment', 403: 'authorization',
                      404: 'model_unavailable', 422: 'request_rejected', 429: 'limited'}.get(error.code, 'unavailable')
            error.close()
            if not transient or attempt or not auth or time.monotonic() + .4 >= deadline:
                raise ProviderError(status) from None
            time.sleep(.35)
        except TimeoutError:
            raise ProviderError('timeout') from None
        except (URLError, OSError):
            raise ProviderError('unavailable') from None
        except (UnicodeError, ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError('invalid_response') from None
    raise ProviderError('unavailable')
