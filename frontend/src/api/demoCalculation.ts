import { calculateStressCurves } from '../utils/calculateStressCurves'
import type { CurveCalculation, CurvePreview, ScenarioParameters } from '../utils/curveTypes'

/** Local demonstration only: no HTTP, MOEX request or database connection. */
export async function runDemoCalculation(
  source: CurvePreview,
  parameters: Readonly<ScenarioParameters>,
  { signal, fail = false, delayMs = 1200 }: { signal: AbortSignal; fail?: boolean; delayMs?: number },
): Promise<CurveCalculation> {
  signal.throwIfAborted()
  // Capture inputs when launched, before the demonstration delay.
  const snapshot = { ...source, points: source.points.map(point => ({ ...point })) }
  const selectedParameters = { ...parameters }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  signal.throwIfAborted()
  if (fail) throw new Error('Демонстрационная ошибка расчёта. Попробуйте ещё раз.')
  return calculateStressCurves(snapshot, selectedParameters)
}
