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
