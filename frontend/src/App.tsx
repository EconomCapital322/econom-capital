import { useState } from 'react'
import type { ReactElement } from 'react'
import { RunHistory } from './components/RunHistory/RunHistory'
import { ReportDatePicker } from './components/ReportDate/ReportDatePicker'
import { Header } from './components/Header/Header'
import { ParametersControl } from './components/Parameters/ParametersControl'
import { CurvePreviewPanel } from './components/CurvePreview/CurvePreviewPanel'
import { useCurvePreview } from './hooks/useCurvePreview'
import { STANDARD_PARAMETERS } from './utils/parameters'
import { Button } from './components/ui/Button'
import { useCurveCalculation } from './hooks/useCurveCalculation'
import type { ScenarioParameters } from './utils/curveTypes'
import { isReportDate } from './utils/validateCurves'
import { useRemoteCurves } from './hooks/useRemoteCurves'
import { inputPreview } from './api/httpContract'
import './App.css'

function App(): ReactElement {
  const [reportDate, setReportDate] = useState(() => {
    const date = new URL(window.location.href).searchParams.get('reportDate')
    const today = new Date()
    const currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    return isReportDate(date) ? date : currentDate
  })
  const [graphRevision, setGraphRevision] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [parameters, setParameters] = useState<ScenarioParameters>({ ...STANDARD_PARAMETERS })
  const server = useRemoteCurves(reportDate)
  const demoQuery = useCurvePreview(reportDate, 'normal', !server.enabled)
  const sourceQuery = server.enabled ? server.query : demoQuery
  const validDate = isReportDate(reportDate)
  const preview = server.enabled ? server.preview : validDate && !demoQuery.isError ? demoQuery.data ?? null : null
  const local = useCurveCalculation({
    reportDate,
    source: server.enabled ? null : preview,
    scope: 'normal',
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
    setHistoryOpen(false)
    server.clearSelection(nextDate)
    setReportDate(nextDate)
    const url = new URL(window.location.href)
    if (isReportDate(nextDate)) url.searchParams.set('reportDate', nextDate)
    else url.searchParams.delete('reportDate')
    url.searchParams.delete('runId')
    window.history.replaceState(window.history.state, '', url)
    setParameters({ ...STANDARD_PARAMETERS })
    reset()
  }

  function runCalculation() {
    if (!canStart || isRunning) return
    setGraphRevision(value => value + 1)
    if (server.enabled) void server.start(parameters)
    else void local.run(reportDate, parameters)
  }

  function checkSource() {
    if (!validDate || sourceQuery.isFetching) return
    if (server.enabled) server.refresh()
    else void sourceQuery.refetch({ cancelRefetch: false })
  }

  return (
    <div className="curve-app">
      <Header />
      <main className="curve-page">
        <div className="curve-page__heading"><div><h1>Кривые доходности</h1><p>Базовая кривая и шесть сценариев изменения ставок</p></div></div>
        <div className="calculation-toolbar">
        <section className="calculation-controls" aria-label="Настройка расчёта">
          <ReportDatePicker value={reportDate} onChange={changeDate} />
          <ParametersControl onOpen={() => setHistoryOpen(false)} value={parameters} onChange={setParameters} disabled={isRunning} errors={server.validation &&
            ['p', 'k', 'd'].every(key => parameters[key as keyof ScenarioParameters] === server.validation?.parameters[key as keyof ScenarioParameters])
            ? server.validation.fields : undefined} />
          <Button className="run-calculation" onClick={runCalculation} disabled={!canStart || isRunning}>{isRunning ? <><span className="spinner-border spinner-border-sm" aria-hidden="true" />Выполняется…</> : server.enabled && server.preparationFailed ? 'Повторить загрузку' : state.status === 'error' ? 'Повторить расчёт' : 'Пересчитать кривые'}</Button>
        </section>
        {server.enabled && <RunHistory reportDate={reportDate} selectedRunId={server.selectedRunId} onSelect={server.selectRun} open={historyOpen} onOpenChange={setHistoryOpen} />}
        </div>
        {parametersChanged && <p className="calculation-hint" role="status">{server.enabled ? 'Выбранные параметры отличаются от параметров готового расчёта.' : 'Параметры изменены.'} Нажмите «Пересчитать кривые», чтобы применить их к новому расчёту.</p>}
        {!server.enabled && preview && state.status !== 'error' && <div className={`calculation-status calculation-status--${state.status}`} role="status">
          {state.status === 'idle' && 'Исходные данные доступны. Расчёт начнётся автоматически.'}
          {state.status === 'running' && 'Подготавливаем базовую и шесть стрессовых кривых. Результаты появятся после завершения.'}
          {state.status === 'ready' && 'Расчёт готов: базовая и шесть стрессовых кривых.'}
        </div>}
        {server.enabled ? <div className="results-region" aria-busy={isRunning || sourceQuery.isFetching}>
          <CurvePreviewPanel rawPreview={server.query.data?.input.available ? inputPreview(server.query.data.input) : null} graphRevision={graphRevision} preview={displayedCalculation ? preview : null} calculation={displayedCalculation}
            error={sourceQuery.isError ? (sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Не удалось получить данные сервера.') : state.status === 'error' ? state.message : undefined}
            message={!validDate ? 'Выберите отчётную дату.' : sourceQuery.isPending ? 'Получаем данные за выбранную дату…' : server.isPreparing ? 'Загружаем ставки из MOEX за выбранную дату…' : isRunning ? 'Выполняется серверный расчёт. Результат появится после завершения.' : !displayedCalculation && preview && state.status !== 'error' && !sourceQuery.isError ? 'Исходные ставки доступны. Готового расчёта пока нет. Нажмите «Пересчитать кривые».' : undefined} />
        </div> : !validDate ? <div className="source-state" role="status">Выберите отчётную дату.</div> : sourceQuery.isFetching && !preview ? <div className="source-state" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" />Получаем данные за выбранную дату…</div>
          : sourceQuery.isError ? <div className="source-state" role="alert"><p>Не удалось получить данные за выбранную дату.</p><Button variant="outline" onClick={checkSource} disabled={sourceQuery.isFetching}>Повторить получение данных</Button></div>
          : <div className="results-region" aria-busy={isRunning}><CurvePreviewPanel graphRevision={graphRevision} preview={preview} calculation={displayedCalculation} error={state.status === 'error' ? state.message : undefined} /></div>}
        <div className="data-availability" role="status">{preview && (!server.enabled || server.query.data?.input.available) ? <><span>Ставки за дату доступны</span><span>{server.enabled && server.query.data?.input.dataProvenance === 'synthetic' ? 'Синтетические данные' : preview.source} · {server.enabled && server.query.data?.input.sourceAsOf ? `${new Date(server.query.data.input.sourceAsOf).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК` : `${new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU')}, ${preview.sourceTime}`}</span></> : <span>{!validDate ? 'Отчётная дата не выбрана' : server.enabled && server.isPreparing ? 'Загружаем ставки из MOEX' : sourceQuery.isFetching ? 'Получаем исходные ставки' : sourceQuery.isError ? 'Исходные ставки недоступны' : 'Нет ставок за выбранную дату'}</span>}</div>
      </main>
      <footer className="app-footer"><span>Методика IRRBB · Банк России, 8-МР</span></footer>
    </div>
  )
}

export default App
