import exportIcon from '../../assets/images/export.svg'
import { useId, useState } from 'react'
import type { CurveCalculation, CurvePreview, StressScenarioCode } from '../../utils/curveTypes'
import { formatRate, formatParameter } from '../../utils/parameters'
import { canExportCurveCalculation, downloadCurveCsv } from '../../utils/curveCsv'
import { Button } from '../ui/Button'

const SCENARIO_DETAILS: Partial<Record<StressScenarioCode, string>> = {
  steepener: 'короткие вниз, длинные вверх',
  flattener: 'короткие вверх, длинные вниз',
}

const SCENARIO_NAMES: Record<StressScenarioCode, string> = {
  'parallel-up': 'Параллельный сдвиг вверх',
  'parallel-down': 'Параллельный сдвиг вниз',
  steepener: 'Увеличение наклона', flattener: 'Уменьшение наклона',
  'short-up': 'Краткосрочные вверх', 'short-down': 'Краткосрочные вниз',
}
const DISPLAY_ORDER: StressScenarioCode[] = ['parallel-down', 'parallel-up', 'steepener', 'flattener', 'short-up', 'short-down']

const SCENARIO_STYLES: Record<StressScenarioCode, { color: string; dash?: string }> = {
  'parallel-up': { color: 'var(--chart-parallel-up)' },
  'parallel-down': { color: 'var(--chart-parallel-down)', dash: '7 4' },
  steepener: { color: 'var(--chart-steepener)' },
  flattener: { color: 'var(--chart-flattener)', dash: '7 4' },
  'short-up': { color: 'var(--chart-short-up)', dash: '2 4' },
  'short-down': { color: 'var(--chart-short-down)', dash: '9 3 2 3' },
}

interface CurvePreviewPanelProps {
  preview: CurvePreview | null
  calculation: CurveCalculation | null
}

export function CurvePreviewPanel({ preview, calculation }: CurvePreviewPanelProps) {
  const [view, setView] = useState<'graph' | 'table'>('table')
  const [selectedCurves, setSelectedCurves] = useState<string[]>(['base'])
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null)
  const [focusedPoint, setFocusedPoint] = useState<number | null>(null)
  const panelId = useId()
  const tooltipId = `${panelId}-tooltip`

  function toggleScenario(code: string) {
    setSelectedCurves(current => current.includes(code)
      ? current.filter(value => value !== code)
      : [...current, code])
    setHoveredPoint(null)
    setFocusedPoint(null)
  }

  if (!preview) return (
    <section className="results-panel" aria-live="polite">
      <div className="results-panel__header"><h2>Результаты</h2></div>
      <div className="empty-state">
        <div className="empty-state__symbol" aria-hidden="true">⌁</div>
        <h2>Нет исходных данных</h2>
        <p>За выбранную дату ставки не загружены.<br />Выберите другую дату или повторите позже.</p>
      </div>
    </section>
  )

  // Only a result belonging to this date can appear beside the source curve.
  const result = calculation?.reportDate === preview.reportDate ? calculation : null
  const exportAvailable = canExportCurveCalculation(result)
  const basePoints = result?.baseCurve ?? preview.points
  const curves = [
    { code: 'base', name: 'Базовая кривая', points: basePoints, color: 'var(--chart-base)', dash: undefined as string | undefined },
    ...([...(result?.stressCurves ?? [])].sort((a, b) => DISPLAY_ORDER.indexOf(a.code) - DISPLAY_ORDER.indexOf(b.code)).map(curve => ({
      code: curve.code,
      name: SCENARIO_NAMES[curve.code],
      points: curve.points,
      ...SCENARIO_STYLES[curve.code],
    }))),
  ]
  const visibleCurves = curves.filter(curve => selectedCurves.includes(curve.code))
  const legendOrder = ['base', 'parallel-up', 'parallel-down', 'short-up', 'short-down', 'steepener', 'flattener']
  const legendCurves = [...curves].sort((a, b) => legendOrder.indexOf(a.code) - legendOrder.indexOf(b.code))
  const activePoint = hoveredPoint ?? focusedPoint
  const selectedPoint = activePoint !== null ? basePoints[activePoint] : null
  const dateLabel = new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', }).replace(' г.', '')
  const heading = result ? 'Базовая и стрессовые кривые' : 'Базовая кривая'
  const W = 1319, H = 263, left = 31, right = 25, top = 9, bottom = 42
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

  return (
    <section className={`results-panel results-panel--${view}`} aria-label={heading}>
      <div className="results-panel__header">
        <div>
          <h2>Результаты</h2>
          <p>{dateLabel} · {basePoints.length} расчётных срока{result ? ' · 7 кривых' : ''}</p>

        </div>
        <div className="nav nav-tabs results-view-tabs" role="tablist" aria-label="Вид результатов">
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
          <Button variant="outline" disabled={!exportAvailable} onClick={() => { if (canExportCurveCalculation(result)) downloadCurveCsv(result) }} aria-describedby={`${panelId}-export-note`} title="CSV — формат прототипа. Окончательный формат ещё согласуется.">
            <img src={exportIcon} alt="" width="18" height="20" />Скачать CSV
          </Button>
        </div>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view}`} tabIndex={0}>
        {view === 'graph' ? (
          <div className="curve-chart" tabIndex={0} role="region" aria-label="График кривых с горизонтальной прокруткой">
            <p>Доходность, % годовых</p>
            {visibleCurves.length === 0 ? <div className="curve-chart__empty" role="status">Выберите кривую для отображения</div> : <div className="curve-chart__plot">
            <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${heading} на ${dateLabel}. Выберите срок клавишей Tab, затем используйте стрелки.`}>
              <title>{result ? 'Базовая кривая и шесть сценариев IRRBB' : 'Ставки на теноры бакетов, включая интерполяцию и экстраполяцию из Excel'}</title>
              {ticks.map((tick, i) => <g key={i}><path d={`M${left} ${y(tick)}H${W - right}`} stroke="var(--chart-grid)" /><text x={left - 12} y={y(tick) + 4} textAnchor="end">{formatTick(tick)}</text></g>)}
              {basePoints.map((point, i) => <text key={point.label} x={x(i)} y={H - 15} textAnchor="middle">{point.label}</text>)}
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
                  aria-describedby={activePoint === i ? tooltipId : undefined}
                  onMouseEnter={() => { setFocusedPoint(null); setHoveredPoint(i) }} onMouseLeave={() => setHoveredPoint(null)}
                  onFocus={() => { setHoveredPoint(null); setFocusedPoint(i) }} onBlur={() => setFocusedPoint(null)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') { setHoveredPoint(null); setFocusedPoint(null) }
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      const next = event.key === 'Home' ? 0 : event.key === 'End' ? basePoints.length - 1 : Math.max(0, Math.min(basePoints.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))
                      const target = event.currentTarget.parentElement?.querySelectorAll<SVGRectElement>('.curve-chart__hit')[next]
                      target?.focus()
                    }
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocusedPoint(i) }
                  }} />
              ))}
            </svg>
            {selectedPoint && activePoint !== null && <div className={`curve-chart__tooltip ${activePoint > basePoints.length / 2 ? 'curve-chart__tooltip--left' : ''}`} id={tooltipId} role="tooltip" style={{ left: `${x(activePoint) / W * 100}%` }}>
              <strong>{selectedPoint.label} · тенор {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(selectedPoint.tenorYears)} года</strong>
              {visibleCurves.map(curve => <div key={curve.code}><span>{curve.name}</span><b>{formatRate(curve.points[activePoint].rate)}%</b></div>)}
            </div>}
            </div>}
            <p className="curve-chart__x">Срок бакета</p>
          </div>
        ) : (
          <div className="table-responsive curve-table" tabIndex={0} role="region" aria-label="Таблица ставок с горизонтальной прокруткой">
            <table className="table mb-0">
              <thead><tr><th scope="col">Бакет</th><th scope="col">Тенор (лет)</th>{curves.map(curve => <th key={curve.code} scope="col">{curve.name}{!result ? ', % годовых' : ''}</th>)}</tr></thead>
              <tbody>{basePoints.map((point, i) => (
                <tr key={point.label}>
                  <th scope="row">{point.label}</th>
                  <td>{new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(point.tenorYears)}</td>
                  {curves.map(curve => <td key={curve.code}>{formatRate(curve.points[i].rate)}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      {view === 'graph' && <div className="curve-legend" aria-label="Выбор кривых">
        {legendCurves.map(curve => (
          <button key={curve.code} type="button" className={`scenario-option ${curve.code === 'base' ? 'scenario-option--base' : ''}`} aria-pressed={selectedCurves.includes(curve.code)} onClick={() => toggleScenario(curve.code)} title={SCENARIO_DETAILS[curve.code as StressScenarioCode]}>
            <svg width="23" height="10" viewBox="0 0 23 10" aria-hidden="true"><path d="M0 5H23" stroke={curve.color} strokeWidth={curve.code === 'base' ? '3' : '2.2'} strokeDasharray={curve.dash} /></svg>
            <span>{curve.code === 'parallel-up' ? 'Параллельный вверх' : curve.code === 'parallel-down' ? 'Параллельный вниз' : curve.name}</span>
          </button>
        ))}
      </div>}
      {result && <p className="result-parameters" aria-label="Параметры расчёта" aria-live="polite"><span className="visually-hidden">Параметры расчёта: </span>P = {formatParameter(result.parameters.p)} п. п. · K = {formatParameter(result.parameters.k)} п. п. · D = {formatParameter(result.parameters.d)} п. п. · RUB</p>}
      <p className="visually-hidden" id={`${panelId}-export-note`}>CSV — формат прототипа. Окончательный формат ещё согласуется.</p>
    </section>
  )
}
