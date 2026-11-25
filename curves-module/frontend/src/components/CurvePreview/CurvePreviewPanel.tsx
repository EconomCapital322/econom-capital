import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { CurveCalculation, CurvePreview, StressScenarioCode } from '../../utils/curveTypes'
import { formatRate, formatParameter } from '../../utils/parameters'
import { canExportCurveCalculation, downloadCurveCsv } from '../../utils/curveCsv'
import { Button } from '../ui/Button'

const exportIcon = new URL('../../assets/images/export.svg', import.meta.url).href
const chevronIcon = new URL('../../assets/images/curves-chevron.svg', import.meta.url).href

const SCENARIO_DETAILS: Partial<Record<StressScenarioCode, string>> = {
  steepener: 'короткие вниз, длинные вверх',
  flattener: 'короткие вверх, длинные вниз',
}

const SCENARIO_NAMES: Record<StressScenarioCode, string> = {
  'parallel-up': 'Общий рост ставок',
  'parallel-down': 'Общее снижение ставок',
  steepener: 'Увеличение наклона кривой', flattener: 'Уменьшение наклона кривой',
  'short-up': 'Рост краткосрочных ставок', 'short-down': 'Снижение краткосрочных ставок',
}
const DISPLAY_ORDER: StressScenarioCode[] = ['parallel-down', 'parallel-up', 'steepener', 'flattener', 'short-up', 'short-down']

const SCENARIO_STYLES: Record<StressScenarioCode, { color: string; dash?: string }> = {
  'parallel-up': { color: 'var(--chart-parallel-up)' },
  'parallel-down': { color: 'var(--chart-parallel-down)', dash: '7 4' },
  steepener: { color: 'var(--chart-steepener)' },
  flattener: { color: 'var(--chart-flattener)', dash: '7 4' },
  'short-up': { color: 'var(--chart-short-up)' },
  'short-down': { color: 'var(--chart-short-down)', dash: '9 3 2 3' },
}

export interface CurvePreviewPanelProps {
  preview: CurvePreview | null
  calculation: CurveCalculation | null
  error?: string
  message?: string
  graphRevision?: number
  rawPreview?: CurvePreview | null
  compact?: boolean
  runId?: string
  onExplain?: (scenario: string) => void
  onContext?: (scenario: string | null) => void
}

export function CurvePreviewPanel({ preview, calculation, error, message, graphRevision = 0, rawPreview = null,
  compact = false, runId, onExplain, onContext }: CurvePreviewPanelProps): ReactElement {
  const [viewState, setViewState] = useState<{ view: 'graph' | 'table'; revision: number }>({ view: 'graph', revision: graphRevision })
  const view = viewState.revision === graphRevision ? viewState.view : 'graph'
  const setView = (view: 'graph' | 'table') => setViewState({ view, revision: graphRevision })
  const [sourceScope, setSourceScope] = useState<string | null>(null)
  const scope = `${preview?.reportDate}:${graphRevision}`
  const sourceOnly = !!rawPreview && rawPreview === preview && !calculation
  const showSource = !!rawPreview && rawPreview.reportDate === preview?.reportDate && (sourceOnly || sourceScope === scope)
  const [selectedCurves, setSelectedCurves] = useState<string[]>(['base'])
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null)
  const [focusedPoint, setFocusedPoint] = useState<number | null>(null)
  const [pin, setPin] = useState<{ scope: string; label: string } | null>(null)
  const [legendExpanded, setLegendExpanded] = useState(true)
  const plotRef = useRef<HTMLDivElement | null>(null)
  const [plotSize, setPlotSize] = useState({ width: 1319, height: 263 })
  const panelId = useId()
  useEffect(() => {
    const plot = plotRef.current
    if (!plot) return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(compact ? 250 : 1000, entry.contentRect.width)
      const height = Math.max(180, entry.contentRect.height)
      setPlotSize(current => current.width === width && current.height === height ? current : { width, height })
    })
    observer.observe(plot)
    return () => observer.disconnect()
  }, [view, preview, error, selectedCurves.length, compact])
  const tooltipId = `${panelId}-tooltip`
  const result = calculation?.reportDate === preview?.reportDate ? calculation : null
  const activeScenario = selectedCurves.findLast(code => code !== 'base' && result?.stressCurves.some(curve => curve.code === code)) ?? 'base'
  const scenarioCode = activeScenario.startsWith('short-') ? activeScenario.replace('short-', 'short_rate_') : activeScenario.replace('-', '_')
  const pinScope = `${scope}:${runId ?? ''}:${showSource}`

  useEffect(() => {
    onContext?.(result && !showSource && !error && !message ? scenarioCode : null)
  }, [onContext, result, scenarioCode, error, message, showSource])

  function toggleScenario(code: string) {
    setSelectedCurves(current => current.includes(code)
      ? current.filter(value => value !== code)
      : [...current, code])
    setHoveredPoint(null)
    setFocusedPoint(null)
  }

  if (error) return (
    <section className="results-panel results-panel--error" role="alert" aria-label="Ошибка расчёта">
      <p>{error}</p>
    </section>
  )

  if (message) return (
    <section className="results-panel results-panel--error" role="status"><p>{message}</p></section>
  )

  if (!preview) return (
    <section className="results-panel results-panel--empty" aria-live="polite">
      <div className="empty-state">
        <div className="empty-state__symbol" aria-hidden="true">⌁</div>
        <h2>Нет исходных данных</h2>
        <p>За выбранную дату ставки не загружены.<br />Выберите другую дату или повторите позже.</p>
      </div>
    </section>
  )

  const exportAvailable = canExportCurveCalculation(result)
  const basePoints = showSource ? rawPreview.points : result?.baseCurve ?? preview.points
  const curves = [
    { code: 'base', name: showSource ? rawPreview.source : 'Базовая кривая', points: basePoints, color: 'var(--chart-base)', dash: undefined as string | undefined },
    ...([...((showSource ? [] : result?.stressCurves) ?? [])].sort((a, b) => DISPLAY_ORDER.indexOf(a.code) - DISPLAY_ORDER.indexOf(b.code)).map(curve => ({
      code: curve.code,
      name: SCENARIO_NAMES[curve.code],
      points: curve.points,
      ...SCENARIO_STYLES[curve.code],
    }))),
  ]
  const visibleCurves = showSource ? curves : curves.filter(curve => selectedCurves.includes(curve.code))
  const legendOrder = ['base', 'parallel-up', 'parallel-down', 'short-up', 'short-down', 'steepener', 'flattener']
  const legendCurves = [...curves].sort((a, b) => legendOrder.indexOf(a.code) - legendOrder.indexOf(b.code))
  const pinned = pin?.scope === pinScope ? basePoints.findIndex((point) => point.label === pin.label) : -1
  const activePoint = pinned >= 0 ? pinned : hoveredPoint ?? focusedPoint
  const selectedPoint = activePoint !== null ? basePoints[activePoint] : null
  const dateLabel = new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', }).replace(' г.', '')
  const heading = showSource ? 'Исходные ставки' : result ? 'Базовая и стрессовые кривые' : 'Базовая кривая'
  const W = plotSize.width, H = plotSize.height, left = 31, right = 25, top = 9, bottom = 42
  const rates = curves.flatMap(curve => curve.points.map(point => point.rate))
  const lowest = Math.min(...rates), highest = Math.max(...rates)
  const magnitude = Math.max(1, Math.abs(lowest), Math.abs(highest))
  const roughStep = magnitude * Math.max((highest / magnitude - lowest / magnitude) / 7, Number.EPSILON)
  const power = 10 ** Math.floor(Math.log10(roughStep))
  const step = ([1, 2, 5, 10].find(value => value * power >= roughStep) ?? 10) * power
  const roundedMin = Math.floor(lowest / step) * step
  const roundedMax = Math.ceil(highest / step) * step
  const min = Number.isFinite(roundedMin) ? roundedMin : lowest
  const max = Number.isFinite(roundedMax) ? roundedMax : highest
  // Normalization keeps finite but very large user parameters from overflowing
  // the chart span. Tick count is bounded independently of the rate range.
  const scale = Math.max(1, Math.abs(min), Math.abs(max))
  const normalizedSpan = max / scale - min / scale
  const x = (i: number) => left + i * (W - left - right) / Math.max(1, basePoints.length - 1)
  const y = (rate: number) => normalizedSpan === 0
    ? (H - bottom + top) / 2
    : top + (max / scale - rate / scale) * (H - top - bottom) / normalizedSpan
  const tickCount = Math.max(2, Math.min(9, Math.round((max / magnitude - min / magnitude) / (step / magnitude)) + 1))
  const ticks = Array.from({ length: tickCount }, (_, i) => min * (1 - i / (tickCount - 1)) + max * (i / (tickCount - 1)))
  const formatTick = (tick: number) => Math.abs(tick) >= 1e6
    ? tick.toExponential(1)
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(tick)
  const tickStride = compact ? Math.max(1, Math.ceil(basePoints.length * 37 / (W - left - right))) : 1

  function togglePin(i: number) {
    setPin(pinned === i ? null : { scope: pinScope, label: basePoints[i].label })
    setFocusedPoint(i)
  }

  return (
    <section className={`results-panel results-panel--${view}`} aria-label={heading}>
      <div className="results-panel__header">
        <div>
          <h2>{compact ? heading : 'Результаты'}</h2>
          {!compact && <p>{dateLabel} · {basePoints.length} {showSource ? 'исходных сроков MOEX' : 'расчётных срока'}{result && !showSource ? ' · 7 кривых' : ''}</p>}
          {!sourceOnly && rawPreview?.reportDate === preview.reportDate && <button className="source-curve-toggle" type="button" aria-pressed={showSource} onClick={() => {
            setSourceScope(showSource ? null : scope)
            setHoveredPoint(null)
            setFocusedPoint(null)
          }}>{showSource ? 'К расчётным кривым' : 'Показать исходную MOEX'}</button>}

        </div>
        <div className="nav nav-tabs results-view-tabs" data-view={view} role="tablist" aria-label="Вид результатов">
          {(['graph', 'table'] as const).map(type => (
            <button key={type} id={`${panelId}-${type}`} className={`nav-link ${view === type ? 'active' : ''}`} type="button" role="tab" tabIndex={view === type ? 0 : -1} aria-selected={view === type} aria-controls={panelId} onClick={() => setView(type)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const nextView = event.key === 'Home' ? 'graph' : event.key === 'End' ? 'table' : type === 'graph' ? 'table' : 'graph'
              setView(nextView)
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[id="${panelId}-${nextView}"]`)?.focus()
            }}>
              {type === 'graph' ? 'График' : 'Таблица'}
            </button>
          ))}
        </div>
        <div className="result-export">
          {onExplain && result && !showSource && <Button variant="outline" onClick={() => onExplain(scenarioCode)}>Спросить AI</Button>}
          <Button variant="outline" disabled={!exportAvailable} onClick={() => { if (canExportCurveCalculation(result)) downloadCurveCsv(result) }} aria-describedby={`${panelId}-export-note`} title="CSV — формат прототипа. Окончательный формат ещё согласуется.">
            <img src={exportIcon} alt="" width="18" height="20" />Скачать CSV
          </Button>
        </div>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view}`} tabIndex={0}>
        {view === 'graph' ? (
          <div className="curve-chart" tabIndex={0} role="region" aria-label="График кривых с горизонтальной прокруткой">
            <p>Доходность, % годовых</p>
            {visibleCurves.length === 0 ? <div className="curve-chart__empty" role="status">Выберите кривую для отображения</div> : <div className="curve-chart__plot" ref={plotRef}>
            <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${heading} на ${dateLabel}. Выберите срок клавишей Tab, затем используйте стрелки.`}>
              <title>{result ? 'Базовая кривая и шесть сценариев IRRBB' : 'Доходность по расчётным срокам'}</title>
              {ticks.map((tick, i) => <g key={i}><path d={`M${left} ${y(tick)}H${W - right}`} stroke="var(--chart-grid)" /><text x={left - 12} y={y(tick) + 4} textAnchor="end">{formatTick(tick)}</text></g>)}
              {basePoints.map((point, i) => (i === basePoints.length - 1 || (i % tickStride === 0 && i < basePoints.length - tickStride)) &&
                <text key={point.label} x={x(i)} y={H - 15} textAnchor="middle">{point.label}</text>)}
              {visibleCurves.map(curve => (
                <polyline key={curve.code} data-scenario={curve.code} points={curve.points.map((point, i) => `${x(i)},${y(point.rate)}`).join(' ')} fill="none" stroke={curve.color} strokeWidth={curve.code === 'base' ? '2.8' : '2.1'} strokeDasharray={curve.dash} strokeLinejoin="round" />
              ))}
              {selectedPoint && activePoint !== null && <g aria-hidden="true" pointerEvents="none">
                <path d={`M${x(activePoint)} ${top}V${H - bottom}`} stroke="var(--page-muted)" strokeDasharray="3 4" />
                {visibleCurves.map(curve => <circle key={curve.code} cx={x(activePoint)} cy={y(curve.points[activePoint].rate)} r="3.5" fill={curve.color} stroke="white" />)}
              </g>}
              {basePoints.map((point, i) => (
                <rect key={point.label} className="curve-chart__hit" x={x(i) - (W - left - right) / Math.max(1, basePoints.length - 1) / 2} y={top} width={(W - left - right) / Math.max(1, basePoints.length - 1)} height={H - top - bottom} fill="transparent" role="button" tabIndex={i === (focusedPoint ?? 0) ? 0 : -1}
                  aria-label={`${point.label}, тенор ${point.tenorYears} года. ${visibleCurves.map(curve => `${curve.name}: ${formatRate(curve.points[i].rate)}%`).join('; ')}`}
                  aria-describedby={activePoint === i ? tooltipId : undefined} aria-pressed={pinned === i}
                  onClick={() => togglePin(i)}
                  onMouseEnter={() => { setFocusedPoint(null); setHoveredPoint(i) }} onMouseLeave={() => setHoveredPoint(null)}
                  onFocus={() => { setHoveredPoint(null); setFocusedPoint(i) }} onBlur={() => setFocusedPoint(null)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') { setHoveredPoint(null); setFocusedPoint(null); setPin(null) }
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      const next = event.key === 'Home' ? 0 : event.key === 'End' ? basePoints.length - 1 : Math.max(0, Math.min(basePoints.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))
                      const target = event.currentTarget.parentElement?.querySelectorAll<SVGRectElement>('.curve-chart__hit')[next]
                      if (pinned >= 0) setPin({ scope: pinScope, label: basePoints[next].label })
                      target?.focus()
                    }
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePin(i) }
                  }} />
              ))}
            </svg>
            {selectedPoint && activePoint !== null && <div className={`curve-chart__tooltip ${activePoint > basePoints.length / 2 ? 'curve-chart__tooltip--left' : ''}`} id={tooltipId} role="tooltip" style={{ left: `${x(activePoint) / W * 100}%` }}>
              <strong>{selectedPoint.label} · тенор {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(selectedPoint.tenorYears)} года</strong>
              {visibleCurves.map(curve => <div key={curve.code}><span>{curve.name}</span><b>{formatRate(curve.points[activePoint].rate)}%</b></div>)}
              {pinned >= 0 && <small>Закреплено · Esc для сброса</small>}
            </div>}
            </div>}
            <p className="curve-chart__x">Срок бакета</p>
          </div>
        ) : (
          <div className={`table-responsive curve-table ${showSource ? 'curve-table--source' : ''}`} tabIndex={0} role="region" aria-label={compact ? 'Таблица ставок с прокруткой' : 'Таблица ставок с горизонтальной прокруткой'}>
            <table className="table mb-0">
              <thead><tr><th scope="col">Бакет</th><th scope="col">Тенор (лет)</th>{curves.map(curve => <th key={curve.code} scope="col">{curve.name}{!result ? ', % годовых' : ''}</th>)}</tr></thead>
              <tbody tabIndex={compact ? undefined : 0} aria-label={compact ? undefined : 'Строки ставок с вертикальной прокруткой'}>{basePoints.map((point, i) => (
                <tr key={point.label}>
                  <th scope="row">{point.label}</th>
                  <td>{new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(point.tenorYears)}</td>
                  {curves.map(curve => <td key={curve.code}>{formatRate(curve.points[i].rate)}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      {view === 'graph' && !showSource && <>
      <button type="button" className="curve-legend-toggle" aria-label={legendExpanded ? 'Свернуть выбор кривых' : 'Развернуть выбор кривых'} aria-expanded={legendExpanded} aria-controls={`${panelId}-legend`} onClick={() => setLegendExpanded(current => !current)}>
        {compact && 'Выбор кривых'}
        <img src={chevronIcon} width="18" height="10" alt="" />
      </button>
      <div id={`${panelId}-legend`} className="curve-legend" aria-label="Выбор кривых" hidden={!legendExpanded}>
        {legendCurves.map(curve => (
          <button key={curve.code} type="button" className={`scenario-option ${curve.code === 'base' ? 'scenario-option--base' : ''}`} aria-pressed={selectedCurves.includes(curve.code)} onClick={() => toggleScenario(curve.code)} title={SCENARIO_DETAILS[curve.code as StressScenarioCode]}>
            <svg width="23" height="10" viewBox="0 0 23 10" aria-hidden="true"><path d="M0 5H23" stroke={curve.color} strokeWidth={curve.code === 'base' ? '3' : '2.2'} strokeDasharray={curve.dash} /></svg>
            <span>{curve.name}</span>
          </button>
        ))}
      </div>
      </>}
      </div>
      {showSource && <p className="result-parameters">{rawPreview.source} · {rawPreview.sourceTime} МСК. Исходные точки без интерполяции и экстраполяции.</p>}
      {result && !showSource && <p className="result-parameters" aria-label="Параметры расчёта" aria-live="polite"><span className="visually-hidden">Параметры расчёта: </span>P = {formatParameter(result.parameters.p)} п. п. · K = {formatParameter(result.parameters.k)} п. п. · D = {formatParameter(result.parameters.d)} п. п. · RUB{result.dataProvenance && <> · {result.dataProvenance === 'synthetic' ? 'Синтетические данные' : 'Рыночные данные'}</>}{result.runOrigin && <> · {result.runOrigin === 'manual' ? 'Ручной запуск' : 'Автоматический запуск'}</>}</p>}
      <p className="visually-hidden" id={`${panelId}-export-note`}>CSV — формат прототипа. Окончательный формат ещё согласуется.</p>
    </section>
  )
}
