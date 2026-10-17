export interface ScenarioParameters {
  p: number
  k: number
  d: number
}

export interface CurvePoint {
  label: string
  tenorYears: number
  rate: number
}

export interface CurvePreview {
  reportDate: string
  source: 'MOEX'
  sourceTime: string
  points: readonly CurvePoint[]
}

export type StressScenarioCode =
  | 'parallel-up'
  | 'parallel-down'
  | 'steepener'
  | 'flattener'
  | 'short-up'
  | 'short-down'

export interface StressCurve {
  readonly code: StressScenarioCode
  readonly points: readonly CurvePoint[]
}

export interface CurveCalculation {
  readonly reportDate: string
  readonly parameters: Readonly<ScenarioParameters>
  readonly baseCurve: readonly CurvePoint[]
  readonly stressCurves: readonly StressCurve[]
}
