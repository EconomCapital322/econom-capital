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
  const [hiddenScenarios, setHiddenScenarios] = useState<StressScenarioCode[]>([])
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null)
  const [focusedPoint, setFocusedPoint] = useState<number | null>(null)
  const panelId = useId()
  const tooltipId = `${panelId}-tooltip`

  function toggleScenario(code: StressScenarioCode) {
    setHiddenScenarios(current => current.includes(code)
      ? current.filter(value => value !== code)
      : [...current, code])
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
  const visibleCurves = curves.filter(curve => curve.code === 'base' || !hiddenScenarios.includes(curve.code as StressScenarioCode))
  const activePoint = hoveredPoint ?? focusedPoint
  const selectedPoint = activePoint !== null ? basePoints[activePoint] : null
  const dateLabel = new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', }).replace(' г.', '')
  const heading = result ? 'Базовая и стрессовые кривые' : 'Базовая кривая'
  const W = 1000, H = 365, left = 45, right = 18, top = 15, bottom = 42
  const rates = curves.flatMap(curve => curve.points.map(point => point.rate))
  const min = Math.floor(Math.min(...rates)) - 1
  const max = Math.ceil(Math.max(...rates)) + 1
  // Normalization keeps finite but very large user parameters from overflowing
  // the chart span. Tick count is bounded independently of the rate range.
  const scale = Math.max(1, Math.abs(min), Math.abs(max))
  const normalizedSpan = max / scale - min / scale
  const x = (i: number) => left + i * (W - left - right) / Math.max(1, basePoints.length - 1)
  const y = (rate: number) => normalizedSpan === 0
    ? (H - bottom + top) / 2
    : top + (max / scale - rate / scale) * (H - top - bottom) / normalizedSpan
  const ticks = Array.from({ length: 7 }, (_, i) => min * (1 - i / 6) + max * (i / 6))
  const formatTick = (tick: number) => Math.abs(tick) >= 1e6
    ? tick.toExponential(1)
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(tick)

  return (
    <section className="results-panel" aria-label={heading}>
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
          <Button variant="outline" disabled={!exportAvailable} onClick={() => { if (canExportCurveCalculation(result)) downloadCurveCsv(result) }} aria-describedby={`${panelId}-export-note`}>
            <img src={exportIcon} alt="" width="18" height="20" />Скачать CSV
          </Button>
        </div>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view}`} tabIndex={0}>
        {view === 'graph' ? (
          <div className="curve-chart" tabIndex={0} role="region" aria-label="График кривых с горизонтальной прокруткой">
            <p>Доходность, % годовых</p>
            <div className="curve-chart__plot">
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
            </div>
            <p className="curve-chart__x">Срок бакета</p>
          </div>
        ) : (
          <div className="table-responsive curve-table" tabIndex={0} role="region" aria-label="Таблица ставок с горизонтальной прокруткой">
            <table className="table mb-0">
              <thead><tr><th scope="col">Бакет</th><th scope="col">Тенор (лет)</th>{visibleCurves.map(curve => <th key={curve.code} scope="col">{curve.name}{!result ? ', % годовых' : ''}</th>)}</tr></thead>
              <tbody>{basePoints.map((point, i) => (
                <tr key={point.label}>
                  <th scope="row">{point.label}</th>
                  <td>{new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(point.tenorYears)}</td>
                  {visibleCurves.map(curve => <td key={curve.code}>{formatRate(curve.points[i].rate)}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      <details className="result-tools" open={view === 'graph' ? true : undefined}>
        <summary>Сценарии и параметры расчёта</summary>
        {result && <p className="result-parameters" aria-live="polite">Параметры расчёта: P = {formatParameter(result.parameters.p)}, K = {formatParameter(result.parameters.k)}, D = {formatParameter(result.parameters.d)} п.п.</p>}
      <div className={`curve-legend ${result ? 'curve-legend--multiple' : ''}`} aria-label="Выбор сценариев">
        {curves.map(curve => (
          <label key={curve.code} className={`scenario-option ${curve.code === 'base' ? 'scenario-option--base' : ''}`}>
            {curve.code !== 'base' && <input className="form-check-input" type="checkbox" checked={!hiddenScenarios.includes(curve.code as StressScenarioCode)} onChange={() => toggleScenario(curve.code as StressScenarioCode)} />}
            <svg width="23" height="10" viewBox="0 0 23 10" aria-hidden="true"><path d="M0 5H23" stroke={curve.color} strokeWidth="2.5" strokeDasharray={curve.dash} /></svg>
            <span>{curve.name}{curve.code === 'base' ? <small>Всегда видна</small> : SCENARIO_DETAILS[curve.code as StressScenarioCode] && <small>{SCENARIO_DETAILS[curve.code as StressScenarioCode]}</small>}</span>
          </label>
        ))}
      </div>
        <p className="export-note" id={`${panelId}-export-note`}>CSV — формат прототипа. Окончательный формат ещё согласуется.</p>
      </details>
      <div className="results-panel__footer">{result ? `Показано ${visibleCurves.length} из 7 кривых · Масштаб рассчитан по всем сценариям · ` : ''}Сроки бакетов · теноры указаны в таблице{result ? ' · Ставки в % годовых' : ''}</div>
    </section>
  )
}
