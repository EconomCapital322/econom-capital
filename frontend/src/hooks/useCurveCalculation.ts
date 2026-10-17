import { useEffect, useRef, useState } from 'react'
import { runDemoCalculation } from '../api/demoCalculation'
import type { CurveCalculation, CurvePreview, ScenarioParameters } from '../utils/curveTypes'

type CalculationState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; result: CurveCalculation }
  | { status: 'error'; message: string }

export function useCurveCalculation() {
  const [state, setState] = useState<CalculationState>({ status: 'idle' })
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  function reset() {
    controller.current?.abort()
    controller.current = null
    setState({ status: 'idle' })
  }

  async function run(source: CurvePreview, parameters: ScenarioParameters, fail: boolean) {
    // Ref also prevents a second launch before React commits the disabled button.
    if (controller.current) return
    const current = new AbortController()
    controller.current = current
    setState({ status: 'running' })
    try {
      const result = await runDemoCalculation(source, parameters, { signal: current.signal, fail })
      if (controller.current === current && !current.signal.aborted) setState({ status: 'ready', result })
    } catch (error) {
      if (controller.current === current && !current.signal.aborted) {
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось рассчитать кривые. Попробуйте ещё раз.' })
      }
    } finally {
      if (controller.current === current) controller.current = null
    }
  }

  return { state, run, reset }
}
