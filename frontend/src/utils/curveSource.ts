import type { CurveCalculation, CurvePoint, CurvePreview } from './curveTypes'

export interface CurveSourceSnapshot {
  reportDate: string
  points: readonly CurvePoint[]
}

/** Content identity for calculation inputs, not a server revision or run ID.
 * Publication time and object identity do not change the numerical inputs.
 */
export function curveSourceKey(source: CurveSourceSnapshot): string {
  return JSON.stringify({ reportDate: source.reportDate, points: source.points.map(({ label, tenorYears, rate }) => ({ label, tenorYears, rate })) })
}

export function matchesCurveSource(result: CurveCalculation, source: CurveSourceSnapshot): boolean {
  return curveSourceKey({ reportDate: result.reportDate, points: result.baseCurve }) === curveSourceKey(source)
}

export function previewSourceKey(source: CurvePreview | null): string | null {
  return source ? curveSourceKey(source) : null
}
