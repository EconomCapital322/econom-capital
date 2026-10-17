import type {
  CurveCalculation,
  CurvePreview,
  ScenarioParameters,
  StressScenarioCode,
} from './curveTypes'

export const STRESS_SCENARIOS = [
  { code: 'parallel-up', name: 'Параллельный вверх' },
  { code: 'parallel-down', name: 'Параллельный вниз' },
  { code: 'steepener', name: 'Увеличение наклона' },
  { code: 'flattener', name: 'Уменьшение наклона' },
  { code: 'short-up', name: 'Краткосрочные вверх' },
  { code: 'short-down', name: 'Краткосрочные вниз' },
] as const satisfies readonly { code: StressScenarioCode; name: string }[]

function getShift(code: StressScenarioCode, tenorYears: number, { p, k, d }: Readonly<ScenarioParameters>): number {
  const s = Math.exp(-tenorYears / 4)
  switch (code) {
    case 'parallel-up': return p
    case 'parallel-down': return -p
    case 'steepener': return -0.65 * k * s + 0.9 * d * (1 - s)
    case 'flattener': return 0.8 * k * s - 0.6 * d * (1 - s)
    case 'short-up': return k * s
    case 'short-down': return -k * s
  }
}

/** Rates are in percent per year; P/K/D are in percentage points (no /100).
 *  Pure calculation: its result owns copies of the input points and parameters.
 */
export function calculateStressCurves(
  source: CurvePreview,
  parameters: Readonly<ScenarioParameters>,
): CurveCalculation {
  if (![parameters.p, parameters.k, parameters.d].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('P, K и D должны быть конечными числами больше нуля.')
  }
  if (!source.points.length) throw new Error('Нет ставок для расчёта.')
  if (source.points.some(point => !Number.isFinite(point.rate) || !Number.isFinite(point.tenorYears) || point.tenorYears < 0)) {
    throw new Error('Проверьте исходные ставки и расчётные сроки.')
  }

  const snapshot = { ...parameters }
  const baseCurve = source.points.map(point => ({ ...point }))
  const stressCurves = STRESS_SCENARIOS.map(({ code }) => ({
    code,
    points: baseCurve.map(point => {
      const rate = point.rate + getShift(code, point.tenorYears, snapshot)
      if (!Number.isFinite(rate)) throw new Error('Не удалось рассчитать кривые: числовое переполнение. Проверьте параметры.')
      return { ...point, rate }
    }),
  }))

  return { reportDate: source.reportDate, parameters: snapshot, baseCurve, stressCurves }
}
