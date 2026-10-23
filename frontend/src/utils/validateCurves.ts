import { isPositiveParameter } from './parameters'
import type { CurveCalculation, CurvePoint, CurvePreview } from './curveTypes'

const SCENARIO_CODES = ['parallel-up', 'parallel-down', 'steepener', 'flattener', 'short-up', 'short-down'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isReportDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Reject incomplete, duplicate or unsorted grids before rendering/indexing them. */
function isPointGrid(value: unknown): value is CurvePoint[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const labels = new Set<string>()
  let previousTenor = -Infinity
  for (const point of value) {
    if (!isRecord(point) || typeof point.label !== 'string' || !point.label.trim() || labels.has(point.label) ||
      typeof point.rate !== 'number' || !Number.isFinite(point.rate) ||
      typeof point.tenorYears !== 'number' || !Number.isFinite(point.tenorYears) ||
      point.tenorYears < 0 || point.tenorYears <= previousTenor) return false
    labels.add(point.label)
    previousTenor = point.tenorYears
  }
  return true
}

export function isCurvePreview(value: unknown): value is CurvePreview {
  return isRecord(value) && isReportDate(value.reportDate) && value.source === 'MOEX' &&
    typeof value.sourceTime === 'string' && isPointGrid(value.points)
}

export function isCompleteCalculation(value: unknown): value is CurveCalculation {
  if (!isRecord(value) || !isReportDate(value.reportDate) || !isPointGrid(value.baseCurve) ||
    !isRecord(value.parameters) || !['p', 'k', 'd'].every(key => {
      const parameter = (value.parameters as Record<string, unknown>)[key]
      return typeof parameter === 'number' && isPositiveParameter(parameter)
    }) || !Array.isArray(value.stressCurves) || value.stressCurves.length !== SCENARIO_CODES.length) return false
  const base = value.baseCurve
  const curves = value.stressCurves
  return SCENARIO_CODES.every(code => {
    const matches = curves.filter(curve => isRecord(curve) && curve.code === code)
    if (matches.length !== 1 || !isRecord(matches[0]) || !isPointGrid(matches[0].points)) return false
    return matches[0].points.length === base.length && matches[0].points.every((point, i) =>
      point.label === base[i].label && point.tenorYears === base[i].tenorYears)
  })
}
