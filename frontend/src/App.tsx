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
import './App.css'

function App() {
  const [reportDate, setReportDate] = useState('2026-07-31')
  const [parameters, setParameters] = useState<ScenarioParameters>({ ...STANDARD_PARAMETERS })
  const demonstration = useDemonstration()
  const demoMode = demonstration.mode
  const sourceQuery = useCurvePreview(reportDate, demonstration.available ? demoMode : 'api')
  const validDate = isReportDate(reportDate)
  const preview = validDate && !sourceQuery.isError ? sourceQuery.data ?? null : null
  const { state, run, reset } = useCurveCalculation({
    reportDate,
    source: preview,
    scope: demonstration.available ? demoMode : 'api',
  })
  const isRunning = state.status === 'running'
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
    if (!preview || isRunning) return
    void run(reportDate, parameters)
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
          <ParametersControl value={parameters} onChange={setParameters} disabled={!preview || isRunning} />
          <Button className="run-calculation" onClick={runCalculation} disabled={!preview || isRunning}>{isRunning ? <><span className="spinner-border spinner-border-sm" aria-hidden="true" />Выполняется…</> : state.status === 'error' ? 'Повторить расчёт' : 'Пересчитать кривые'}</Button>
        </section>
        {parametersChanged && <p className="calculation-hint" role="status">Параметры изменены. Нажмите «Пересчитать кривые», чтобы применить их к новому расчёту.</p>}
        {preview && <div className={`calculation-status calculation-status--${state.status}`} role={state.status === 'error' ? 'alert' : 'status'}>
          {state.status === 'idle' && 'Исходные данные доступны. Расчёт начнётся автоматически.'}
          {state.status === 'running' && 'Подготавливаем базовую и шесть стрессовых кривых. Результаты появятся после завершения.'}
          {state.status === 'ready' && 'Расчёт готов: базовая и шесть стрессовых кривых.'}
          {state.status === 'error' && state.message}
        </div>}
        {!validDate ? <div className="source-state" role="status">Выберите отчётную дату.</div> : sourceQuery.isFetching && !preview ? <div className="source-state" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" />Получаем данные за выбранную дату…</div>
          : sourceQuery.isError ? <div className="source-state" role="alert"><p>Не удалось получить данные за выбранную дату.</p><Button variant="outline" onClick={checkSource} disabled={sourceQuery.isFetching}>Повторить получение данных</Button></div>
          : <div className="results-region" aria-busy={isRunning}><CurvePreviewPanel preview={preview} calculation={displayedCalculation} /></div>}
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
        <div className="data-availability" role="status">{preview ? <><span>Ставки за дату доступны</span><span>{preview.source} · {new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU')}, {preview.sourceTime}</span></> : <span>{!validDate ? 'Отчётная дата не выбрана' : sourceQuery.isFetching ? 'Получаем исходные ставки' : sourceQuery.isError ? 'Исходные ставки недоступны' : 'Нет ставок за выбранную дату'}</span>}{validDate && !sourceQuery.isError && <Button variant="outline" className="source-refresh" onClick={checkSource} disabled={sourceQuery.isFetching}>{sourceQuery.isFetching ? 'Проверяем данные…' : 'Проверить наличие данных'}</Button>}</div>
      </main>
      <footer className="app-footer"><span>{demonstration.available ? 'Демонстрационные значения из Excel. Подключение к MOEX и БД не выполняется.' : 'Данные предоставлены сервером модуля кривых.'}</span><span>Методика IRRBB · Банк России, 8-МР</span></footer>
    </div>
  )
}

export default App
