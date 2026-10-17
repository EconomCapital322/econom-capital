import { useState } from 'react'
import { Header } from './components/Header/Header'
import { ParametersControl } from './components/Parameters/ParametersControl'
import { CurvePreviewPanel } from './components/CurvePreview/CurvePreviewPanel'
import { getCurvePreview } from './api/curvePreview'
import { STANDARD_PARAMETERS } from './utils/parameters'
import type { ScenarioParameters } from './utils/curveTypes'
import './App.css'

function App() {
  const [reportDate, setReportDate] = useState('2026-07-31')
  const [parameters, setParameters] = useState<ScenarioParameters>({ ...STANDARD_PARAMETERS })
  const preview = getCurvePreview(reportDate)

  return (
    <div className="curve-app">
      <Header />
      <main className="curve-page">
        <div className="curve-page__heading"><div><h1>Кривые доходности</h1><p>Базовая кривая и шесть сценариев изменения ставок</p></div><span className="prototype-tag">Интерактивный прототип</span></div>
        <section className="calculation-controls" aria-label="Настройка расчёта">
          <div className="report-date"><label className="form-label" htmlFor="report-date">Отчётная дата</label><input className="form-control" id="report-date" type="date" value={reportDate} onChange={event => setReportDate(event.currentTarget.value)} onInput={event => setReportDate(event.currentTarget.value)} /></div>
          <ParametersControl value={parameters} onChange={setParameters} disabled={!preview} />
        </section>
        <CurvePreviewPanel preview={preview} />
        <div className="data-availability" role="status">{preview ? <><span>Ставки за дату доступны</span><span>MOEX · 31.07.2026, {preview.sourceTime}</span></> : <span>Нет ставок за выбранную дату</span>}</div>
      </main>
      <footer className="app-footer"><span>Демонстрационные значения из Excel. Подключение к MOEX и БД не выполняется.</span><span>Методика IRRBB · Банк России, 8-МР</span></footer>
    </div>
  )
}

export default App
