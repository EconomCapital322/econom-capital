import { useRef, useState } from 'react'
import { Header } from './components/Header/Header'
import { ParametersControl } from './components/Parameters/ParametersControl'
import { CurvePreviewPanel } from './components/CurvePreview/CurvePreviewPanel'
import { getCurvePreview } from './api/curvePreview'
import { STANDARD_PARAMETERS } from './utils/parameters'
import { Button } from './components/ui/Button'
import { useCurveCalculation } from './hooks/useCurveCalculation'
import type { ScenarioParameters } from './utils/curveTypes'
import './App.css'

function App() {
  const [reportDate, setReportDate] = useState('2026-07-31')
  const [parameters, setParameters] = useState<ScenarioParameters>({ ...STANDARD_PARAMETERS })
  const [demoMode, setDemoMode] = useState('normal')
  const demoErrorPending = useRef(false)
  const { state, run, reset } = useCurveCalculation()
  const preview = demoMode === 'no-data' ? null : getCurvePreview(reportDate)
  const isRunning = state.status === 'running'
  const displayedCalculation = state.status === 'ready' && state.result.reportDate === reportDate ? state.result : null
  const parametersChanged = displayedCalculation !== null &&
    (parameters.p !== displayedCalculation.parameters.p ||
      parameters.k !== displayedCalculation.parameters.k ||
      parameters.d !== displayedCalculation.parameters.d)

  function changeDate(nextDate: string) {
    if (nextDate === reportDate) return
    setReportDate(nextDate)
    reset()
  }

  function runCalculation() {
    if (!preview || isRunning) return
    const fail = demoErrorPending.current
    demoErrorPending.current = false
    void run(preview, parameters, fail)
  }

  function changeDemoMode(value: string) {
    reset()
    setDemoMode(value)
    demoErrorPending.current = value === 'error-once'
  }

  return (
    <div className="curve-app">
      <Header />
      <main className="curve-page">
        <div className="curve-page__heading"><div><h1>Кривые доходности</h1><p>Базовая кривая и шесть сценариев изменения ставок</p></div><span className="prototype-tag">Интерактивный прототип</span></div>
        <section className="calculation-controls" aria-label="Настройка расчёта">
          <div className="report-date"><label className="form-label" htmlFor="report-date">Отчётная дата</label><input className="form-control" id="report-date" type="date" value={reportDate} onChange={event => changeDate(event.currentTarget.value)} onInput={event => changeDate(event.currentTarget.value)} /></div>
          <ParametersControl value={parameters} onChange={setParameters} disabled={!preview || isRunning} />
          <Button className="run-calculation" onClick={runCalculation} disabled={!preview || isRunning}>{isRunning ? <><span className="spinner-border spinner-border-sm" aria-hidden="true" />Выполняется…</> : state.status === 'error' ? 'Повторить расчёт' : 'Запустить расчёт'}</Button>
        </section>
        {parametersChanged && <p className="calculation-hint" role="status">Параметры изменены. Нажмите «Запустить расчёт», чтобы обновить кривые.</p>}
        {preview && <div className={`calculation-status calculation-status--${state.status}`} role={state.status === 'error' ? 'alert' : 'status'}>
          {state.status === 'idle' && 'Исходные данные доступны. Расчёт ещё не выполнен.'}
          {state.status === 'running' && 'Рассчитываем шесть стрессовых кривых. Результаты появятся после завершения.'}
          {state.status === 'ready' && 'Расчёт готов: базовая и шесть стрессовых кривых.'}
          {state.status === 'error' && state.message}
        </div>}
        <div aria-busy={isRunning}><CurvePreviewPanel preview={preview} calculation={displayedCalculation} /></div>
        <details className="demo-tools">
          <summary>Демонстрация состояний · без подключения к серверу</summary>
          <label htmlFor="demo-mode">Сценарий прототипа</label>
          <select id="demo-mode" className="form-select form-select-sm" value={demoMode} onChange={event => changeDemoMode(event.target.value)}>
            <option value="normal">Обычный расчёт</option>
            <option value="error-once">Ошибка при ближайшем запуске</option>
            <option value="no-data">Нет исходных данных</option>
          </select>
          <p>Расчёт выполняется локально с демонстрационной задержкой. Ошибка возникает один раз: повторная попытка доступна сразу. Данные Excel есть только за 31.07.2026.</p>
          {demoMode === 'no-data' && <p role="status">Отсутствие данных показано для демонстрации.</p>}
        </details>
        <div className="data-availability" role="status">{preview ? <><span>Ставки за дату доступны</span><span>MOEX · 31.07.2026, {preview.sourceTime}</span></> : <span>Нет ставок за выбранную дату</span>}</div>
      </main>
      <footer className="app-footer"><span>Демонстрационные значения из Excel. Подключение к MOEX и БД не выполняется.</span><span>Методика IRRBB · Банк России, 8-МР</span></footer>
    </div>
  )
}

export default App
