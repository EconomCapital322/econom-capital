@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
set "MODULE_DIR=%CD%"
cd ..
set "REPO_DIR=%CD%"
cd /d "%MODULE_DIR%"

if "%SPECTRUM_PORT%"=="" set "SPECTRUM_PORT=8780"
set "APP_URL=http://127.0.0.1:%SPECTRUM_PORT%/"
if "%SPECTRUM_CURVES_URL%"=="" set "SPECTRUM_CURVES_URL=http://127.0.0.1:8000"

rem Проверка, работает ли уже сервер
curl -s -f -m 2 -o nul "%APP_URL%api/workspace" >nul 2>&1
if not errorlevel 1 (
    echo Спектр уже работает: %APP_URL%
    start "" "%APP_URL%"
    exit /b 0
)

if not exist ".local" mkdir .local

rem Поиск виртуального окружения Python
set "PYTHON_EXE="
if exist "%REPO_DIR%\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%REPO_DIR%\.venv\Scripts\python.exe"
) else if exist "%REPO_DIR%\.venv\bin\python.exe" (
    set "PYTHON_EXE=%REPO_DIR%\.venv\bin\python.exe"
)

rem Поиск uv
set "UV_EXE="
where uv >nul 2>&1
if not errorlevel 1 (
    set "UV_EXE=uv"
) else if exist "%USERPROFILE%\.local\bin\uv.exe" (
    set "UV_EXE=%USERPROFILE%\.local\bin\uv.exe"
)

if "!PYTHON_EXE!"=="" (
    if not "!UV_EXE!"=="" (
        echo Создание окружения Python через uv...
        "!UV_EXE!" venv --python 3.12 "%REPO_DIR%\.venv"
        if exist "%REPO_DIR%\.venv\Scripts\python.exe" set "PYTHON_EXE=%REPO_DIR%\.venv\Scripts\python.exe"
        if exist "%REPO_DIR%\.venv\bin\python.exe" set "PYTHON_EXE=%REPO_DIR%\.venv\bin\python.exe"
        if not "!PYTHON_EXE!"=="" (
            "!UV_EXE!" pip install -r requirements.txt --python "!PYTHON_EXE!"
        )
    ) else (
        where python >nul 2>&1
        if not errorlevel 1 (
            echo Создание окружения через python -m venv...
            python -m venv "%REPO_DIR%\.venv"
            if exist "%REPO_DIR%\.venv\Scripts\python.exe" set "PYTHON_EXE=%REPO_DIR%\.venv\Scripts\python.exe"
            if exist "%REPO_DIR%\.venv\bin\python.exe" set "PYTHON_EXE=%REPO_DIR%\.venv\bin\python.exe"
            if not "!PYTHON_EXE!"=="" (
                "!PYTHON_EXE!" -m pip install -r requirements.txt
            )
        )
    )
)

if "!PYTHON_EXE!"=="" (
    echo [ОШИБКА] Python 3 не найден. Установите Python 3.11+ или задайте SPECTRUM_PYTHON.
    exit /b 1
)

rem Проверка установленных пакетов
"!PYTHON_EXE!" -c "import sklearn, shap" >nul 2>&1
if errorlevel 1 (
    echo Установка зависимостей из requirements.txt...
    if not "!UV_EXE!"=="" (
        "!UV_EXE!" pip install -r requirements.txt --python "!PYTHON_EXE!"
    ) else (
        "!PYTHON_EXE!" -m pip install -r requirements.txt
    )
)

rem Проверка/сборка калькулятора cfcore
if "%SPECTRUM_CFCORE%"=="" (
    if not exist "%MODULE_DIR%\.local\bin\cfcore.exe" (
        if not exist "%REPO_DIR%\calculator\build\core\cfcore.exe" (
            if not exist "%REPO_DIR%\calculator\build\core\Release\cfcore.exe" (
                echo Сборка калькулятора cfcore...
                cmake -S "%REPO_DIR%\calculator" -B "%REPO_DIR%\calculator\build" -DCMAKE_BUILD_TYPE=Release
                cmake --build "%REPO_DIR%\calculator\build" --config Release --target cfcore_cli -j 4
            )
        )
    )
)

rem Проверка доступности API кривых
curl -s -f -m 2 -o nul "%SPECTRUM_CURVES_URL%/openapi.json" >nul 2>&1
if errorlevel 1 (
    echo API кривых недоступен. Можно открыть последний расчет и использовать сохраненные кривые.
)

rem Автоматическое открытие браузера
start "" cmd /c "timeout /t 2 /nobreak >nul & start %APP_URL%"

echo Спектр запускается на %APP_URL%
"!PYTHON_EXE!" -m service.server --port %SPECTRUM_PORT%
