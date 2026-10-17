import type { CurvePreview } from '../utils/curveTypes'

// Local UI preview, not an HTTP request. Extracted from the checked Excel:
// «практика_Т1_перепроверено.xlsx», sheet Лист1, B2:X3 and B17:X17.
const PREVIEW: CurvePreview = {
  reportDate: '2026-07-31',
  source: 'MOEX',
  sourceTime: '18:49:59',
  points: [
  {
    "label": "1d",
    "tenorYears": 0.0028,
    "rate": 14.45
  },
  {
    "label": "1m",
    "tenorYears": 0.0417,
    "rate": 14.26644791576124
  },
  {
    "label": "3m",
    "tenorYears": 0.1667,
    "rate": 13.82990352019296
  },
  {
    "label": "6m",
    "tenorYears": 0.375,
    "rate": 13.469999999999999
  },
  {
    "label": "9m",
    "tenorYears": 0.625,
    "rate": 13.385
  },
  {
    "label": "1y",
    "tenorYears": 0.875,
    "rate": 13.525
  },
  {
    "label": "1,5y",
    "tenorYears": 1.25,
    "rate": 13.89
  },
  {
    "label": "2y",
    "tenorYears": 1.75,
    "rate": 14.365
  },
  {
    "label": "3y",
    "tenorYears": 2.5,
    "rate": 14.82
  },
  {
    "label": "4y",
    "tenorYears": 3.5,
    "rate": 15.17
  },
  {
    "label": "5y",
    "tenorYears": 4.5,
    "rate": 15.35
  },
  {
    "label": "6y",
    "tenorYears": 5.5,
    "rate": 15.465
  },
  {
    "label": "7y",
    "tenorYears": 6.5,
    "rate": 15.54
  },
  {
    "label": "8y",
    "tenorYears": 7.5,
    "rate": 15.594999999999999
  },
  {
    "label": "9y",
    "tenorYears": 8.5,
    "rate": 15.64
  },
  {
    "label": "10y",
    "tenorYears": 9.5,
    "rate": 15.675
  },
  {
    "label": "15y",
    "tenorYears": 12.5,
    "rate": 15.765
  },
  {
    "label": "20y",
    "tenorYears": 17.5,
    "rate": 15.895
  },
  {
    "label": "30y",
    "tenorYears": 25.0,
    "rate": 16.025
  },
  {
    "label": "35y",
    "tenorYears": 32.5,
    "rate": 16.137500000000003
  },
  {
    "label": "40y",
    "tenorYears": 37.5,
    "rate": 16.212500000000002
  },
  {
    "label": "45y",
    "tenorYears": 42.5,
    "rate": 16.287500000000005
  },
  {
    "label": "50y",
    "tenorYears": 47.5,
    "rate": 16.362500000000004
  }
],
}

export function getCurvePreview(reportDate: string): CurvePreview | null {
  return reportDate === PREVIEW.reportDate ? PREVIEW : null
}
