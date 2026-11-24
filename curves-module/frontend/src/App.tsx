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
import { SavedCurvePanel } from './components/CurvePreview/SavedCurvePanel'
import './App.css'

export interface CurveLocation {
  reportDate: string
  runId?: string
  workspaceId?: string
}

export interface CurveEmbedding {
  active: boolean
  location: CurveLocation
  onLocation: (next: CurveLocation) => void
  onRunSelect: (reportDate: string, runId: string) => void
  onUse: (selection: { reportDate: string; runId: string }) => void
  onExplain?: (selection: { reportDate: string; runId: string; workspaceId?: string; scenario: string }) => void
  valuationRunId?: string
  portalTarget: ShadowRoot
}

function App({ embedding }: { embedding?: CurveEmbedding } = {}): ReactElement {
  const [standaloneDate, setReportDate] = useState(() => {
    const date = new URL(window.location.href).searchParams.get('reportDate')
    const today = new Date()
    const currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    return isReportDate(date) ? date : currentDate
  })
  const reportDate = embedding?.location.reportDate ?? standaloneDate
  const archived = embedding?.location.workspaceId
  const active = embedding?.active ?? true
  const [graphRevision, setGraphRevision] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState<{ date: string; value: ScenarioParameters }>()
  const server = useRemoteCurves(reportDate, embedding && {
    active: active && !archived, runId: embedding.location.runId, onSelect: embedding.onRunSelect,
  })
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
  const parameters = draft?.date === reportDate ? draft.value : displayedCalculation?.parameters ?? { ...STANDARD_PARAMETERS }
  const run = server.query.data?.run
  const [lastReady, setLastReady] = useState<{ id: string; result: NonNullable<typeof displayedCalculation> }>()
  if (embedding && displayedCalculation && run && lastReady?.id !== run.runId) {
    setLastReady({ id: run.runId, result: displayedCalculation })
  }
  const previous = !displayedCalculation && lastReady?.result.reportDate === reportDate ? lastReady : null
  const input = server.query.data?.input
  const raw = input?.available ? inputPreview(input) : null
  const rawPreview = raw && input?.dataProvenance === 'synthetic' ? { ...raw, source: 'Учебные ставки' } : raw
  const canUse = displayedCalculation && run?.status === 'ready' && run.dataProvenance === 'market' &&
    run.usedParameters.mode === 'standard' && displayedCalculation.baseCurve.length === 23
  const parametersChanged = displayedCalculation !== null &&
    (parameters.p !== displayedCalculation.parameters.p ||
      parameters.k !== displayedCalculation.parameters.k ||
      parameters.d !== displayedCalculation.parameters.d)

  function changeDate(nextDate: string) {
    if (nextDate === reportDate) return
    setHistoryOpen(false)
    server.clearSelection(nextDate)
    if (embedding) embedding.onLocation({ reportDate: nextDate })
    else {
      setReportDate(nextDate)
      const url = new URL(window.location.href)
      if (isReportDate(nextDate)) url.searchParams.set('reportDate', nextDate)
      else url.searchParams.delete('reportDate')
      url.searchParams.delete('runId')
      window.history.replaceState(window.history.state, '', url)
    }
    setDraft(undefined)
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

  if (embedding && archived) return <SavedCurvePanel active={active} workspaceId={archived} reportDate={reportDate}
    runId={embedding.location.runId} onExplain={embedding.onExplain} onBack={() => embedding.onLocation({ reportDate })} />

  const Page = embedding ? 'section' : 'main'
  const explainRunId = displayedCalculation && run?.status === 'ready' ? run.runId : previous?.id
  const explain = embedding?.onExplain
  const preparationFailure = server.enabled && server.preparationFailed && state.status === 'error'
  const calculateButton = (
    <Button className="run-calculation" onClick={runCalculation} disabled={!canStart || isRunning}>
      {isRunning ? <><span className="spinner-border spinner-border-sm" aria-hidden="true" />Выполняется…</>
        : preparationFailure ? 'Повторить загрузку' : state.status === 'error' ? 'Повторить расчёт' : 'Пересчитать кривые'}
    </Button>
  )
  return (
    <div className="curve-app">
      {!embedding && <Header />}
      <Page className="curve-page">
        <div className="curve-page__heading"><h1>Кривые доходности</h1><p>Базовая кривая и шесть сценариев изменения ставок</p></div>
        <div className="calculation-toolbar">
        <section className="calculation-controls" aria-label="Настройка расчёта">
          <ReportDatePicker value={reportDate} onChange={changeDate} />
          <ParametersControl onOpen={() => setHistoryOpen(false)} value={parameters}
            onChange={value => setDraft({ date: reportDate, value })} disabled={isRunning}
            portalTarget={embedding?.portalTarget} active={active} compact={!!embedding} errors={server.validation &&
            ['p', 'k', 'd'].every(key => parameters[key as keyof ScenarioParameters] === server.validation?.parameters[key as keyof ScenarioParameters])
            ? server.validation.fields : undefined} />
          {!preparationFailure && calculateButton}
        </section>
        {server.enabled && <RunHistory reportDate={reportDate} selectedRunId={server.selectedRunId} onSelect={id => { setDraft(undefined); server.selectRun(id) }} open={active && historyOpen} onOpenChange={setHistoryOpen} />}
        </div>
        {parametersChanged && <p className="calculation-hint" role="status">{server.enabled ? 'Выбранные параметры отличаются от параметров готового расчёта.' : 'Параметры изменены.'} Нажмите «Пересчитать кривые», чтобы применить их к новому расчёту.</p>}
        {!server.enabled && preview && state.status !== 'error' && <div className={`calculation-status calculation-status--${state.status}`} role="status">
          {state.status === 'idle' && 'Исходные данные доступны. Расчёт начнётся автоматически.'}
          {state.status === 'running' && 'Подготавливаем базовую и шесть стрессовых кривых. Результаты появятся после завершения.'}
          {state.status === 'ready' && 'Расчёт готов: базовая и шесть стрессовых кривых.'}
        </div>}
        {server.enabled ? <div className="results-region" aria-busy={isRunning || sourceQuery.isFetching}>
          {embedding && <div className="curve-status" role="status">
            {displayedCalculation ? `Расчёт готов · ${run?.dataProvenance === 'market' ? 'MOEX' : 'учебные ставки'}`
              : server.isPreparing ? 'Загружаем исходные ставки' : isRunning ? 'Сервер рассчитывает кривые' : 'Источник ставок · MOEX'}
          </div>}
          {preparationFailure && <div className="curve-preparation-error">
            <p className="curve-result-message" role="alert">{state.message}</p>
            {calculateButton}
          </div>}
          {embedding && !preparationFailure && !displayedCalculation && (isRunning || state.status === 'error') && <p className="curve-result-message"
            role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? state.message
              : server.isPreparing ? 'Подготовка данных MOEX продолжается.' : 'Запуск находится в очереди или рассчитывается.'}</p>}
          {embedding && previous && <p className="curve-result-message">Последний готовый результат · <code>{previous.id}</code></p>}
          {(!preparationFailure || previous || (embedding && rawPreview)) && <CurvePreviewPanel rawPreview={rawPreview} graphRevision={graphRevision}
            preview={displayedCalculation ? preview : previous ? { reportDate, source: 'MOEX', sourceTime: '', points: previous.result.baseCurve }
              : embedding ? rawPreview : null}
            calculation={displayedCalculation ?? previous?.result ?? null}
            compact={!!embedding}
            onExplain={explain && explainRunId ? scenario => explain({ reportDate, runId: explainRunId, scenario }) : undefined}
            error={embedding || preparationFailure ? undefined : state.status === 'error' ? state.message : undefined}
            message={previous || (embedding && rawPreview) ? undefined : !validDate ? 'Выберите отчётную дату.'
              : sourceQuery.isPending ? 'Получаем данные за выбранную дату…'
                : server.isPreparing || isRunning ? 'Результат появится после завершения.'
                  : !displayedCalculation && server.query.data?.preparation.status === 'no_data' ? 'Нет публикации MOEX за выбранную дату.'
                    : !displayedCalculation && preview && state.status !== 'error' && !sourceQuery.isError ? 'Исходные ставки доступны. Готового расчёта пока нет. Нажмите «Пересчитать кривые».' : undefined} />}
        </div> : !validDate ? <div className="source-state" role="status">Выберите отчётную дату.</div> : sourceQuery.isFetching && !preview ? <div className="source-state" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" />Получаем данные за выбранную дату…</div>
          : sourceQuery.isError ? <div className="source-state" role="alert"><p>Не удалось получить данные за выбранную дату.</p><Button variant="outline" onClick={checkSource} disabled={sourceQuery.isFetching}>Повторить получение данных</Button></div>
          : <div className="results-region" aria-busy={isRunning}><CurvePreviewPanel graphRevision={graphRevision} preview={preview} calculation={displayedCalculation} error={state.status === 'error' ? state.message : undefined} /></div>}
        {(!preparationFailure || preview) && <div className="data-availability" role="status">{preview && (!server.enabled || server.query.data?.input.available) ? <><span>Ставки за дату доступны</span><span>{server.enabled && server.query.data?.input.dataProvenance === 'synthetic' ? 'Синтетические данные' : preview.source} · {server.enabled && server.query.data?.input.sourceAsOf ? `${new Date(server.query.data.input.sourceAsOf).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК` : `${new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU')}, ${preview.sourceTime}`}</span></> : <span>{!validDate ? 'Отчётная дата не выбрана' : server.enabled && server.isPreparing ? 'Загружаем ставки из MOEX' : sourceQuery.isFetching ? 'Получаем исходные ставки' : sourceQuery.isError ? 'Исходные ставки недоступны' : 'Нет ставок за выбранную дату'}</span>}</div>}
        {embedding && displayedCalculation && run && <div className="curve-integration">
          {embedding.valuationRunId && embedding.valuationRunId !== run.runId && <p>В текущем отчёте использован другой снимок кривых. Отчёт сохраняет кривые своей ревизии.</p>}
          {canUse ? <Button variant="outline" onClick={() => embedding.onUse({ reportDate, runId: run.runId })}>Использовать для оценки портфеля</Button>
            : <p>Для оценки портфеля нужны готовые рыночные кривые с 23 сроками и стандартными P = 4, K = 5, D = 3. Этот запуск доступен для просмотра и выгрузки.</p>}
          <details>
            <summary>Источник и методика</summary>
            <p>Run ID <code>{run.runId}</code> · {run.usedParameters.mode === 'standard' ? 'стандартный запуск' : 'пользовательский пересчёт'}</p>
            <p>Методика модуля кривых IRRBB · Банк России, 8-МР. На графике доходность в процентах годовых. Для оценки используются готовые дисконт-факторы.</p>
          </details>
        </div>}
      </Page>
      {!embedding && <footer className="app-footer"><span>Методика IRRBB · Банк России, 8-МР</span></footer>}
    </div>
  )
}

export default App
