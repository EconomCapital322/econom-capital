import { useState } from 'react'
import { Header } from './components/Header/Header'
import { ParametersControl } from './components/Parameters/ParametersControl'
import { CurvePreviewPanel } from './components/CurvePreview/CurvePreviewPanel'
import { useCurvePreview } from './hooks/useCurvePreview'
import { useDemonstration } from './hooks/useDemonstration'
import type { DemoMode } from './api/types'
import { STANDARD_PARAMETERS } from './utils/parameters'
import { Button } from './components/ui/Button'
import { useCurveCalculation } from './hooks/useCurveCalculation'
import type { ScenarioParameters } from './utils/curveTypes'
import { isReportDate } from './utils/validateCurves'
import { useRemoteCurves } from './hooks/useRemoteCurves'
import './App.css'

function App() {
  const [reportDate, setReportDate] = useState('2026-07-31')
  const [parameters, setParameters] = useState<ScenarioParameters>({ ...STANDARD_PARAMETERS })
  const demonstration = useDemonstration()
  const demoMode = demonstration.mode
  const server = useRemoteCurves(reportDate)
  const demoQuery = useCurvePreview(reportDate, demonstration.available ? demoMode : 'api', !server.enabled)
  const sourceQuery = server.enabled ? server.query : demoQuery
  const validDate = isReportDate(reportDate)
  const preview = server.enabled ? server.preview : validDate && !demoQuery.isError ? demoQuery.data ?? null : null
  const local = useCurveCalculation({
    reportDate,
    source: server.enabled ? null : preview,
    scope: demonstration.available ? demoMode : 'api',
  })
  const { reset } = local
  const state = server.enabled ? server.state : local.state
  const isRunning = state.status === 'running' || (server.enabled && server.isSubmitting)
  const canStart = server.enabled ? server.canStart : !!preview
  const displayedCalculation = state.status === 'ready' && state.result.reportDate === reportDate ? state.result : null
  const parametersChanged = displayedCalculation !== null &&
    (parameters.p !== displayedCalculation.parameters.p ||
      parameters.k !== displayedCalculation.parameters.k ||
      parameters.d !== displayedCalculation.parameters.d)

  function changeDate(nextDate: string) {
    if (nextDate === reportDate) return
    setReportDate(nextDate)
    setParameters({ ...STANDARD_PARAMETERS })
    reset()
  }

  function runCalculation() {
    if (!canStart || isRunning) return
    if (server.enabled) void server.start(parameters)
    else void local.run(reportDate, parameters)
  }

  function checkSource() {
    if (!validDate || sourceQuery.isFetching) return
    void sourceQuery.refetch({ cancelRefetch: false })
  }

  function changeDemoMode(value: DemoMode) {
    if (value === demoMode) return
    reset()
    demonstration.changeMode(value)
  }

  return (
    <div className="curve-app">
      <Header />
      <main className="curve-page">
        <div className="curve-page__heading"><div><h1>Кривые доходности</h1><p>Базовая кривая и шесть сценариев изменения ставок</p></div></div>
        <section className="calculation-controls" aria-label="Настройка расчёта">
          <div className="report-date"><label className="form-label" htmlFor="report-date">Отчётная дата</label><input className="form-control" id="report-date" type="date" value={reportDate} onChange={event => changeDate(event.currentTarget.value)} onInput={event => changeDate(event.currentTarget.value)} /></div>
          <ParametersControl value={parameters} onChange={setParameters} disabled={!canStart || isRunning} />
          <Button className="run-calculation" onClick={runCalculation} disabled={!canStart || isRunning}>{isRunning ? <><span className="spinner-border spinner-border-sm" aria-hidden="true" />Выполняется…</> : state.status === 'error' ? 'Повторить расчёт' : 'Пересчитать кривые'}</Button>
        </section>
        {parametersChanged && <p className="calculation-hint" role="status">{server.enabled ? 'Выбранные параметры отличаются от параметров готового расчёта.' : 'Параметры изменены.'} Нажмите «Пересчитать кривые», чтобы применить их к новому расчёту.</p>}
        {!server.enabled && preview && state.status !== 'error' && <div className={`calculation-status calculation-status--${state.status}`} role="status">
          {state.status === 'idle' && 'Исходные данные доступны. Расчёт начнётся автоматически.'}
          {state.status === 'running' && 'Подготавливаем базовую и шесть стрессовых кривых. Результаты появятся после завершения.'}
          {state.status === 'ready' && 'Расчёт готов: базовая и шесть стрессовых кривых.'}
        </div>}
        {server.enabled ? <div className="results-region" aria-busy={isRunning || sourceQuery.isFetching}>
          <CurvePreviewPanel preview={displayedCalculation ? preview : null} calculation={displayedCalculation}
            error={sourceQuery.isError ? (sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Не удалось получить данные сервера.') : state.status === 'error' ? state.message : undefined}
            message={!validDate ? 'Выберите отчётную дату.' : sourceQuery.isPending ? 'Получаем данные за выбранную дату…' : isRunning ? 'Выполняется серверный расчёт. Результат появится после завершения.' : !displayedCalculation && preview && state.status !== 'error' && !sourceQuery.isError ? 'Исходные ставки доступны. Готового расчёта пока нет — нажмите «Пересчитать кривые».' : undefined} />
        </div> : !validDate ? <div className="source-state" role="status">Выберите отчётную дату.</div> : sourceQuery.isFetching && !preview ? <div className="source-state" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" />Получаем данные за выбранную дату…</div>
          : sourceQuery.isError ? <div className="source-state" role="alert"><p>Не удалось получить данные за выбранную дату.</p><Button variant="outline" onClick={checkSource} disabled={sourceQuery.isFetching}>Повторить получение данных</Button></div>
          : <div className="results-region" aria-busy={isRunning}><CurvePreviewPanel preview={preview} calculation={displayedCalculation} error={state.status === 'error' ? state.message : undefined} /></div>}
        {demonstration.available && <details className="demo-tools">
          <summary>Демонстрация состояний · без подключения к серверу</summary>
          <label htmlFor="demo-mode">Сценарий прототипа</label>
          <select id="demo-mode" className="form-select form-select-sm" value={demoMode} onChange={event => changeDemoMode(event.target.value as DemoMode)}>
            <option value="normal">Обычный расчёт</option>
            <option value="error-once">Ошибка при ближайшем запуске</option>
            <option value="no-data">Нет исходных данных</option>
          </select>
          <p>Расчёт выполняется локально с демонстрационной задержкой. Ошибка возникает один раз: повторная попытка доступна сразу. Данные Excel есть только за 31.07.2026.</p>
          {demoMode === 'no-data' && <p role="status">Отсутствие данных показано для демонстрации.</p>}
        </details>}
        <div className="data-availability" role="status">{preview && (!server.enabled || server.query.data?.input.available) ? <><span>Ставки за дату доступны</span><span>{preview.source} · {server.enabled && server.query.data?.input.sourceAsOf ? `${new Date(server.query.data.input.sourceAsOf).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК` : `${new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU')}, ${preview.sourceTime}`}</span></> : <span>{!validDate ? 'Отчётная дата не выбрана' : sourceQuery.isFetching ? 'Получаем исходные ставки' : sourceQuery.isError ? 'Исходные ставки недоступны' : 'Нет ставок за выбранную дату'}</span>}{validDate && (!sourceQuery.isError || server.enabled) && <Button variant="outline" className="source-refresh" onClick={checkSource} disabled={sourceQuery.isFetching}>{sourceQuery.isFetching ? 'Проверяем данные…' : sourceQuery.isError ? 'Повторить получение данных' : 'Проверить наличие данных'}</Button>}</div>
      </main>
      <footer className="app-footer"><span>{demonstration.available ? 'Демонстрационные значения из Excel. Подключение к MOEX и БД не выполняется.' : 'Данные предоставлены сервером модуля кривых.'}</span><span>Методика IRRBB · Банк России, 8-МР</span></footer>
    </div>
  )
}

export default App
