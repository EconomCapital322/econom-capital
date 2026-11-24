$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$RepoDir = Split-Path -Parent $ScriptDir

$Port = if ($env:SPECTRUM_PORT) { $env:SPECTRUM_PORT } else { "8780" }
$AppUrl = "http://127.0.0.1:$Port/"
$CurvesUrl = if ($env:SPECTRUM_CURVES_URL) { $env:SPECTRUM_CURVES_URL } else { "http://127.0.0.1:8000" }
$env:SPECTRUM_CURVES_URL = $CurvesUrl

# Проверка, работает ли уже сервер
try {
    $res = Invoke-WebRequest -Uri "${AppUrl}api/workspace" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($res.StatusCode -eq 200) {
        Write-Host "Спектр уже работает: $AppUrl"
        Start-Process $AppUrl
        exit 0
    }
} catch {}

if (-not (Test-Path ".local")) {
    New-Item -ItemType Directory -Path ".local" | Out-Null
}

# Поиск Python venv
$PythonCandidates = @(
    (Join-Path $RepoDir ".venv\Scripts\python.exe"),
    (Join-Path $RepoDir ".venv\bin\python.exe")
)
$PythonBin = $PythonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$UvCandidates = @(
    (Get-Command uv -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    (Join-Path $env:USERPROFILE ".local\bin\uv.exe")
)
$UvBin = $UvCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $PythonBin) {
    if ($UvBin) {
        Write-Host "Создание окружения Python через uv..."
        & $UvBin venv --python 3.12 (Join-Path $RepoDir ".venv")
        $PythonBin = $PythonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($PythonBin) {
            & $UvBin pip install -r requirements.txt --python $PythonBin
        }
    } else {
        Write-Host "Создание виртуального окружения python -m venv..."
        python -m venv (Join-Path $RepoDir ".venv")
        $PythonBin = $PythonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($PythonBin) {
            & $PythonBin -m pip install -r requirements.txt
        }
    }
}

if (-not $PythonBin) {
    Write-Error "Python 3.11+ не найден. Установите Python или задайте SPECTRUM_PYTHON."
    exit 1
}

# Проверка пакетов
$hasDeps = & $PythonBin -c "import sklearn, shap" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Установка зависимостей..."
    if ($UvBin) {
        & $UvBin pip install -r requirements.txt --python $PythonBin
    } else {
        & $PythonBin -m pip install -r requirements.txt
    }
}

# Проверка/сборка калькулятора cfcore
if (-not $env:SPECTRUM_CFCORE) {
    $cfcoreCandidates = @(
        (Join-Path $ScriptDir ".local\bin\cfcore.exe"),
        (Join-Path $RepoDir "calculator\build\core\cfcore.exe"),
        (Join-Path $RepoDir "calculator\build\core\Release\cfcore.exe")
    )
    $hasCore = $cfcoreCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $hasCore) {
        Write-Host "Сборка калькулятора cfcore..."
        cmake -S (Join-Path $RepoDir "calculator") -B (Join-Path $RepoDir "calculator\build") -DCMAKE_BUILD_TYPE=Release
        cmake --build (Join-Path $RepoDir "calculator\build") --config Release --target cfcore_cli -j 4
    }
}

# Проверка доступности API кривых
try {
    Invoke-WebRequest -Uri "$CurvesUrl/openapi.json" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
} catch {
    Write-Warning "API кривых недоступен. Можно открыть последний расчёт и использовать сохранённые кривые."
}

# Открытие браузера в фоне
Start-Job -ScriptBlock {
    param($url)
    Start-Sleep -Seconds 2
    Start-Process $url
} -ArgumentList $AppUrl | Out-Null

Write-Host "Спектр запускается на $AppUrl"
& $PythonBin -m service.server --port $Port
