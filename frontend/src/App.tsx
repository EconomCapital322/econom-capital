import { useState } from 'react'
import { Header } from './components/Header/Header'
import { ParametersControl } from './components/Parameters/ParametersControl'
import { CurvePreviewPanel } from './components/CurvePreview/CurvePreviewPanel'
import { getCurvePreview } from './api/curvePreview'
import { STANDARD_PARAMETERS } from './utils/parameters'
import { Button } from './components/ui/Button'
import { calculateStressCurves } from './utils/calculateStressCurves'
import type { CurveCalculation, ScenarioParameters } from './utils/curveTypes'
import './App.css'

function App() {
  const [reportDate, setReportDate] = useState('2026-07-31')
  const [parameters, setParameters] = useState<ScenarioParameters>({ ...STANDARD_PARAMETERS })
  const [calculation, setCalculation] = useState<CurveCalculation | null>(null)
  const [calculationError, setCalculationError] = useState<string | null>(null)
  const preview = getCurvePreview(reportDate)
  const displayedCalculation = calculation?.reportDate === reportDate ? calculation : null
  const parametersChanged = displayedCalculation !== null &&
    (parameters.p !== displayedCalculation.parameters.p ||
      parameters.k !== displayedCalculation.parameters.k ||
      parameters.d !== displayedCalculation.parameters.d)

  function changeDate(nextDate: string) {
    if (nextDate === reportDate) return
    setReportDate(nextDate)
    setCalculation(null)
    setCalculationError(null)
  }

  function runCalculation() {
    if (!preview) return
    try {
      setCalculation(calculateStressCurves(preview, parameters))
      setCalculationError(null)
    } catch (error) {
      setCalculationError(error instanceof Error ? error.message : 'Не удалось рассчитать кривые.')
    }
  }

  return (
    <div className="curve-app">
      <Header />
      <main className="curve-page">
        <div className="curve-page__heading"><div><h1>Кривые доходности</h1><p>Базовая кривая и шесть сценариев изменения ставок</p></div><span className="prototype-tag">Интерактивный прототип</span></div>
        <section className="calculation-controls" aria-label="Настройка расчёта">
          <div className="report-date"><label className="form-label" htmlFor="report-date">Отчётная дата</label><input className="form-control" id="report-date" type="date" value={reportDate} onChange={event => changeDate(event.currentTarget.value)} onInput={event => changeDate(event.currentTarget.value)} /></div>
          <ParametersControl value={parameters} onChange={(next) => { setParameters(next); setCalculationError(null) }} disabled={!preview} />
          <Button className="run-calculation" onClick={runCalculation} disabled={!preview}>Запустить расчёт</Button>
        </section>
        {parametersChanged && <p className="calculation-hint" role="status">Параметры изменены. Нажмите «Запустить расчёт», чтобы обновить кривые.</p>}
        {calculationError && <div className="alert calculation-error" role="alert">{calculationError}</div>}
        <CurvePreviewPanel preview={preview} calculation={displayedCalculation} />
        <div className="data-availability" role="status">{preview ? <><span>Ставки за дату доступны</span><span>MOEX · 31.07.2026, {preview.sourceTime}</span></> : <span>Нет ставок за выбранную дату</span>}</div>
      </main>
      <footer className="app-footer"><span>Демонстрационные значения из Excel. Подключение к MOEX и БД не выполняется.</span><span>Методика IRRBB · Банк России, 8-МР</span></footer>
    </div>
  )
}

export default App
