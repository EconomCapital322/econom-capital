import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCurvesApi } from './useCurvesApi'
import { STANDARD_PARAMETERS } from '../utils/parameters'
import { matchesCurveSource, previewSourceKey } from '../utils/curveSource'
import type { CurveSourceSnapshot } from '../utils/curveSource'
import { isCompleteCalculation } from '../utils/validateCurves'
import type { CurveCalculation, CurvePreview, ScenarioParameters } from '../utils/curveTypes'

type CalculationState =
  | { status: 'idle' }
  | { status: 'running'; sourceKey: string }
  | { status: 'ready'; sourceKey: string; result: CurveCalculation }
  | { status: 'error'; sourceKey: string; message: string }

interface CalculationContext {
  reportDate: string
  source: CurvePreview | null
  scope: string
}

export function useCurveCalculation({ reportDate, source, scope }: CalculationContext) {
  const { adapter } = useCurvesApi()
  const [state, setState] = useState<CalculationState>({ status: 'idle' })
  const controller = useRef<AbortController | null>(null)
  const sourceKey = previewSourceKey(source)
  // Parse our own canonical key to obtain an independent, stable snapshot.
  // New objects with identical values keep the same snapshot and callbacks.
  const snapshot = useMemo<CurveSourceSnapshot | null>(() => sourceKey ? JSON.parse(sourceKey) : null, [sourceKey])

  useEffect(() => () => {
    controller.current?.abort()
    controller.current = null
  }, [])

  const reset = useCallback(() => {
    controller.current?.abort()
    controller.current = null
    setState({ status: 'idle' })
  }, [])

  const run = useCallback(async (reportDate: string, parameters: ScenarioParameters) => {
    // Ref also prevents a second launch before React commits the disabled button.
    if (controller.current || !sourceKey || !snapshot || snapshot.reportDate !== reportDate) return
    const current = new AbortController()
    controller.current = current
    const requestedParameters = { ...parameters }
    setState({ status: 'running', sourceKey })
    try {
      const result = await adapter.calculateCurves({ reportDate, parameters: { ...requestedParameters } }, { signal: current.signal })
      if (controller.current !== current || current.signal.aborted) return
      if (!isCompleteCalculation(result) || result.reportDate !== reportDate ||
        result.parameters.p !== requestedParameters.p || result.parameters.k !== requestedParameters.k ||
        result.parameters.d !== requestedParameters.d) {
        setState({ status: 'error', sourceKey, message: 'Получен неполный расчёт или результат с другой датой или параметрами. Повторите расчёт.' })
        return
      }
      if (!matchesCurveSource(result, snapshot)) {
        setState({ status: 'error', sourceKey, message: 'Базовая кривая результата не соответствует исходным данным. Проверьте данные и повторите расчёт.' })
        return
      }
      setState({ status: 'ready', sourceKey, result })
    } catch (error) {
      if (controller.current === current && !current.signal.aborted) {
        setState({ status: 'error', sourceKey, message: error instanceof Error ? error.message : 'Не удалось рассчитать кривые. Попробуйте ещё раз.' })
      }
    } finally {
      if (controller.current === current) controller.current = null
    }
  }, [adapter, sourceKey, snapshot])

  // StrictMode may replay effects: the cancelled microtask must not launch.
  // Only changed numerical inputs/date/scope trigger a default calculation.
  useEffect(() => {
    if (!snapshot || snapshot.reportDate !== reportDate) return
    let active = true
    queueMicrotask(() => { if (active) void run(reportDate, STANDARD_PARAMETERS) })
    return () => {
      active = false
      reset()
    }
  }, [reportDate, snapshot, scope, run, reset])

  // Hide stale results during render, before effect cleanup runs.
  const visibleState: CalculationState = state.status !== 'idle' && state.sourceKey !== sourceKey
    ? { status: 'idle' }
    : state
  return { state: visibleState, run, reset }
}
