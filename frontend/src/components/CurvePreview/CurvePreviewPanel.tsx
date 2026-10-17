import { useId, useState } from 'react'
import type { CurvePreview } from '../../utils/curveTypes'
import { formatRate } from '../../utils/parameters'

export function CurvePreviewPanel({ preview }: { preview: CurvePreview | null }) {
  const [view, setView] = useState<'graph' | 'table'>('graph')
  const panelId = useId()
  if (!preview) return (
    <section className="results-panel" aria-live="polite"><div className="results-panel__header"><h2>Результаты расчёта</h2></div><div className="empty-state"><div className="empty-state__symbol" aria-hidden="true">⌁</div><h2>Нет исходных данных</h2><p>За выбранную дату ставки не загружены.<br />В прототипе доступен срез 31.07.2026.</p></div></section>
  )
  const W = 1000, H = 365, left = 45, right = 18, top = 15, bottom = 42
  const min = Math.floor(Math.min(...preview.points.map(p => p.rate))) - 1
  const max = Math.ceil(Math.max(...preview.points.map(p => p.rate))) + 1
  const x = (i: number) => left + i * (W - left - right) / (preview.points.length - 1)
  const y = (rate: number) => top + (max - rate) * (H - top - bottom) / (max - min)
  const ticks = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  return (
    <section className="results-panel" aria-label="Базовая кривая">
      <div className="results-panel__header"><div><h2>Базовая кривая</h2><p>31 июля 2026 · {preview.points.length} расчётных срока</p></div></div>
      <div className="results-panel__tabs"><div className="nav nav-tabs" role="tablist" aria-label="Вид результатов">{(['graph', 'table'] as const).map(type => <button key={type} id={`${panelId}-${type}`} className={`nav-link ${view === type ? 'active' : ''}`} type="button" role="tab" aria-selected={view === type} aria-controls={panelId} onClick={() => setView(type)}>{type === 'graph' ? 'График' : 'Таблица'}</button>)}</div><span>RUB · исходные ставки MOEX</span></div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view}`} tabIndex={0}>
        {view === 'graph' ? <div className="curve-chart"><p>Доходность, % годовых</p><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Базовая кривая доходности на 31 июля 2026 года"><title>Ставки на теноры бакетов, включая интерполяцию и экстраполяцию из Excel</title>{ticks.map(tick => <g key={tick}><path d={`M${left} ${y(tick)}H${W - right}`} stroke="var(--chart-grid)" /><text x={left - 12} y={y(tick) + 4} textAnchor="end">{tick}</text></g>)}{preview.points.map((point, i) => <text key={point.label} x={x(i)} y={H - 15} textAnchor="middle">{point.label}</text>)}<polyline points={preview.points.map((point, i) => `${x(i)},${y(point.rate)}`).join(' ')} fill="none" stroke="var(--chart-base)" strokeWidth="2.8" strokeLinejoin="round" /></svg><p className="curve-chart__x">Срок бакета</p></div>
        : <div className="table-responsive curve-table"><table className="table mb-0"><thead><tr><th scope="col">Бакет</th><th scope="col">Тенор, лет</th><th scope="col">Доходность, % годовых</th></tr></thead><tbody>{preview.points.map(point => <tr key={point.label}><th scope="row">{point.label}</th><td>{new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(point.tenorYears)}</td><td>{formatRate(point.rate)}</td></tr>)}</tbody></table></div>}
      </div>
      <div className="base-legend"><span />Базовая кривая</div>
      <div className="results-panel__footer">Сроки бакетов · теноры указаны в таблице</div>
    </section>
  )
}
