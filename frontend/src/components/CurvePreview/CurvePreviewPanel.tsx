import { useId, useState } from 'react'
import type { CurveCalculation, CurvePreview, StressScenarioCode } from '../../utils/curveTypes'
import { STRESS_SCENARIOS } from '../../utils/calculateStressCurves'
import { formatRate } from '../../utils/parameters'

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
  const [view, setView] = useState<'graph' | 'table'>('graph')
  const panelId = useId()

  if (!preview) return (
    <section className="results-panel" aria-live="polite">
      <div className="results-panel__header"><h2>Результаты расчёта</h2></div>
      <div className="empty-state">
        <div className="empty-state__symbol" aria-hidden="true">⌁</div>
        <h2>Нет исходных данных</h2>
        <p>За выбранную дату ставки не загружены.<br />В прототипе доступен срез 31.07.2026.</p>
      </div>
    </section>
  )

  // Only a result belonging to this date can appear beside the source curve.
  const result = calculation?.reportDate === preview.reportDate ? calculation : null
  const basePoints = result?.baseCurve ?? preview.points
  const curves = [
    { code: 'base', name: 'Базовая кривая', points: basePoints, color: 'var(--chart-base)', dash: undefined as string | undefined },
    ...(result?.stressCurves.map(curve => ({
      code: curve.code,
      name: STRESS_SCENARIOS.find(scenario => scenario.code === curve.code)!.name,
      points: curve.points,
      ...SCENARIO_STYLES[curve.code],
    })) ?? []),
  ]
  const dateLabel = new Date(`${preview.reportDate}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(' г.', '')
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
          <h2>{heading}</h2>
          <p>{dateLabel} · {basePoints.length} расчётных срока{result ? ' · 7 кривых' : ''}</p>
          {result && <p className="result-parameters" aria-live="polite">Параметры расчёта: P = {formatRate(result.parameters.p)}, K = {formatRate(result.parameters.k)}, D = {formatRate(result.parameters.d)} п.п.</p>}
        </div>
      </div>
      <div className="results-panel__tabs">
        <div className="nav nav-tabs" role="tablist" aria-label="Вид результатов">
          {(['graph', 'table'] as const).map(type => (
            <button key={type} id={`${panelId}-${type}`} className={`nav-link ${view === type ? 'active' : ''}`} type="button" role="tab" aria-selected={view === type} aria-controls={panelId} onClick={() => setView(type)}>
              {type === 'graph' ? 'График' : 'Таблица'}
            </button>
          ))}
        </div>
        <span>RUB · исходные ставки MOEX</span>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view}`} tabIndex={0}>
        {view === 'graph' ? (
          <div className="curve-chart">
            <p>Доходность, % годовых</p>
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${heading} на ${dateLabel}`}>
              <title>{result ? 'Базовая кривая и шесть сценариев IRRBB' : 'Ставки на теноры бакетов, включая интерполяцию и экстраполяцию из Excel'}</title>
              {ticks.map((tick, i) => <g key={i}><path d={`M${left} ${y(tick)}H${W - right}`} stroke="var(--chart-grid)" /><text x={left - 12} y={y(tick) + 4} textAnchor="end">{formatTick(tick)}</text></g>)}
              {basePoints.map((point, i) => <text key={point.label} x={x(i)} y={H - 15} textAnchor="middle">{point.label}</text>)}
              {curves.map(curve => (
                <polyline key={curve.code} data-scenario={curve.code} points={curve.points.map((point, i) => `${x(i)},${y(point.rate)}`).join(' ')} fill="none" stroke={curve.color} strokeWidth={curve.code === 'base' ? '2.8' : '2.1'} strokeDasharray={curve.dash} strokeLinejoin="round" />
              ))}
            </svg>
            <p className="curve-chart__x">Срок бакета</p>
          </div>
        ) : (
          <div className="table-responsive curve-table">
            <table className="table mb-0">
              <thead><tr><th scope="col">Бакет</th><th scope="col">Тенор, лет</th>{curves.map(curve => <th key={curve.code} scope="col">{curve.name}{!result ? ', % годовых' : ''}</th>)}</tr></thead>
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
      <div className={`curve-legend ${result ? 'curve-legend--multiple' : ''}`} aria-label="Кривые на графике">
        {curves.map(curve => <div key={curve.code}><svg width="23" height="10" viewBox="0 0 23 10" aria-hidden="true"><path d="M0 5H23" stroke={curve.color} strokeWidth="2.5" strokeDasharray={curve.dash} /></svg>{curve.name}</div>)}
      </div>
      <div className="results-panel__footer">{result ? 'Рассчитан полный комплект из 7 кривых · ' : ''}Сроки бакетов · теноры указаны в таблице{result ? ' · Ставки в % годовых' : ''}</div>
    </section>
  )
}
