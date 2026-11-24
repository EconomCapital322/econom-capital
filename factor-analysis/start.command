#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
if [[ "$(uname -s)" == "Darwin" ]]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
module_dir="$PWD"
repo_dir="$(cd .. && pwd)"
port="${SPECTRUM_PORT:-8780}"
app="http://127.0.0.1:$port/"
curves="${SPECTRUM_CURVES_URL:-http://127.0.0.1:8000}"
export SPECTRUM_CURVES_URL="$curves"

present() {
  curl --silent --fail --max-time 2 --output /dev/null "$1"
}

open_browser() {
  if [[ "${SPECTRUM_OPEN_BROWSER:-1}" == "1" ]]; then
    if command -v open >/dev/null 2>&1; then
      open "$app"
    elif command -v start >/dev/null 2>&1; then
      start "$app"
    elif command -v cmd.exe >/dev/null 2>&1; then
      cmd.exe /c start "$app" >/dev/null 2>&1 || true
    fi
  fi
}

if present "${app}api/workspace"; then
  printf 'Спектр уже работает: %s\n' "$app"
  open_browser
  exit 0
fi

mkdir -p .local
python_bin=""
for candidate in "$repo_dir/.venv/bin/python" "$repo_dir/.venv/Scripts/python.exe" "$repo_dir/.venv/bin/python.exe"; do
  if [[ -x "$candidate" ]]; then
    python_bin="$candidate"
    break
  fi
done

if [[ -z "$python_bin" ]]; then
  py_cmd="${SPECTRUM_PYTHON:-python3}"
  if ! command -v "$py_cmd" >/dev/null 2>&1 && command -v python >/dev/null 2>&1; then
    py_cmd="python"
  fi
  if ! "$py_cmd" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
    printf 'Для аналитики нужен Python 3.11 или новее. Задайте SPECTRUM_PYTHON.\n' >&2
    exit 1
  fi
  "$py_cmd" -m venv "$repo_dir/.venv"
  for candidate in "$repo_dir/.venv/bin/python" "$repo_dir/.venv/Scripts/python.exe" "$repo_dir/.venv/bin/python.exe"; do
    if [[ -x "$candidate" ]]; then
      python_bin="$candidate"
      break
    fi
  done
fi

if ! "$python_bin" -c 'import sklearn, shap' >/dev/null 2>&1; then
  "$python_bin" -m pip install -r requirements.txt
fi

if [[ -z "${SPECTRUM_CFCORE:-}" && ! -x "$module_dir/.local/bin/cfcore" && ! -x "$module_dir/.local/bin/cfcore.exe" && ! -x "$repo_dir/calculator/build/core/cfcore" && ! -x "$repo_dir/calculator/build/core/cfcore.exe" && ! -x "$repo_dir/calculator/build/core/Release/cfcore.exe" ]]; then
  cmake -S "$repo_dir/calculator" -B "$repo_dir/calculator/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$repo_dir/calculator/build" --target cfcore_cli -j 4
fi

if [[ "$curves" == "http://127.0.0.1:8000" ]] && ! present "$curves/openapi.json"; then
  (
    cd "$repo_dir"
    if ! docker info >/dev/null 2>&1 && command -v open >/dev/null 2>&1; then
      open -g -a Docker
      for _ in {1..35}; do
        if docker info >/dev/null 2>&1; then break; fi
        sleep 1
      done
    fi
    make configure
    export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-econ-spectrum-local}"
    export AUTOMATION__ENABLED="${AUTOMATION__ENABLED:-false}"
    config=(-f docker-compose.yaml)
    ca="${SPECTRUM_MOEX_CA:-$module_dir/.local/certs/moex-ca.pem}"
    if [[ -f "$ca" ]]; then
      export SPECTRUM_MOEX_CA="$ca"
      config+=(-f factor-analysis/compose.moex-ca.yaml)
    fi
    docker compose "${config[@]}" up -d --wait postgres migrate api worker stress frontend
  ) || printf 'API кривых недоступен. Можно открыть последний расчёт и использовать сохранённые кривые.\n' >&2
fi

llm="${SPECTRUM_LLM_URL:-http://127.0.0.1:8089/v1}"
export SPECTRUM_LLM_URL="$llm"
if [[ "$llm" == "http://127.0.0.1:8089/v1" && -x .local/llm/bin/mlx_lm.server ]] && ! present "$llm/models"; then
  HF_HUB_DISABLE_TELEMETRY=1 .local/llm/bin/mlx_lm.server --host 127.0.0.1 --port 8089 \
    --allowed-origins "http://127.0.0.1:$port" --model "${SPECTRUM_LLM_MODEL:-mlx-community/Qwen2.5-1.5B-Instruct-4bit}" \
    > .local/llm.log 2>&1 &
  model_pid="$!"
fi

"$python_bin" -m service.server --port "$port" &
app_pid="$!"
trap 'kill "$app_pid" 2>/dev/null || true; if [[ -n "${model_pid:-}" ]]; then kill "$model_pid" 2>/dev/null || true; fi' EXIT
for _ in {1..20}; do
  if present "${app}api/workspace"; then open_browser; break; fi
  if ! kill -0 "$app_pid" 2>/dev/null; then break; fi
  sleep 1
done
wait "$app_pid"
