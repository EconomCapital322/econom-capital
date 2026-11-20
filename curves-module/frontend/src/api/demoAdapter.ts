import { getCurvePreview } from './curvePreview'
import { runDemoCalculation } from './demoCalculation'
import type { CurvesService, DemoMode } from './types'

/** All fixture access and synthetic failures are confined to this adapter. */
export function createDemoCurvesService(): CurvesService {
  let mode: DemoMode = 'normal'
  let errorPending = false
  return {
    demonstration: {
      setMode(nextMode) {
        mode = nextMode
        errorPending = nextMode === 'error-once'
      },
    },
    adapter: {
      async getBaseCurve({ reportDate }, { signal }) {
        signal.throwIfAborted()
        const source = mode === 'no-data' ? null : getCurvePreview(reportDate)
        return source ? { ...source, points: source.points.map(point => ({ ...point })) } : null
      },
      async calculateCurves({ reportDate, parameters }, { signal }) {
        signal.throwIfAborted()
        const source = mode === 'no-data' ? null : getCurvePreview(reportDate)
        if (!source) throw new Error('Нет исходных данных за выбранную дату.')
        const fail = errorPending
        errorPending = false
        return runDemoCalculation(source, parameters, { signal, fail })
      },
    },
  }
}
