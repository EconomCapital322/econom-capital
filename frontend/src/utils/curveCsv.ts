import type { CurveCalculation } from './curveTypes'
import { STRESS_SCENARIOS } from './calculateStressCurves'

/** A complete result contains every scenario on the same grid as its base. */
export function canExportCurveCalculation(result: CurveCalculation | null): result is CurveCalculation {
  if (!result || !result.baseCurve.length || result.stressCurves.length !== STRESS_SCENARIOS.length) return false
  if (![result.parameters.p, result.parameters.k, result.parameters.d].every(value => Number.isFinite(value) && value > 0)) return false
  if (result.baseCurve.some(point => !Number.isFinite(point.rate) || !Number.isFinite(point.tenorYears) || point.tenorYears < 0)) return false
  return STRESS_SCENARIOS.every(({ code }) => {
    const matches = result.stressCurves.filter(curve => curve.code === code)
    return matches.length === 1 && matches[0].points.length === result.baseCurve.length &&
      matches[0].points.every((point, i) => Number.isFinite(point.rate) &&
        point.label === result.baseCurve[i].label && point.tenorYears === result.baseCurve[i].tenorYears)
  })
}

// Semicolon-separated CSV with decimal commas suits Russian Excel.
// Quote every value, double embedded quotes and preserve full numeric precision.
function csvCell(value: string | number): string {
  const text = typeof value === 'number' ? String(value).replace('.', ',') : value
  return `"${text.replaceAll('"', '""')}"`
}

export function buildCurveCsv(result: CurveCalculation): string {
  if (!canExportCurveCalculation(result)) throw new Error('Для выгрузки нужен полный завершённый расчёт.')
  const rows: (string | number)[][] = [[
    'Отчётная дата', 'Сценарий', 'Бакет', 'Расчётный тенор, лет',
    'Доходность, % годовых', 'P, п.п.', 'K, п.п.', 'D, п.п.',
  ]]
  const curves = [
    { name: 'Базовая кривая', points: result.baseCurve },
    ...STRESS_SCENARIOS.map(({ code, name }) => ({
      name,
      points: result.stressCurves.find(curve => curve.code === code)!.points,
    })),
  ]
  for (const curve of curves) {
    for (const point of curve.points) {
      rows.push([result.reportDate, curve.name, point.label, point.tenorYears, point.rate,
        result.parameters.p, result.parameters.k, result.parameters.d])
    }
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n'
}

export function downloadCurveCsv(result: CurveCalculation): void {
  const blob = new Blob([buildCurveCsv(result)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `curves_${result.reportDate}.csv`
  document.body.append(link)
  try { link.click() } finally {
    link.remove()
    // Let the browser start reading the Blob before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
