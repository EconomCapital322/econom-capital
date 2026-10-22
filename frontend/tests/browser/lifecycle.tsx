import { act, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { CurvesApiContext } from '../../src/store/CurvesApiContext'
import { useCurveCalculation } from '../../src/hooks/useCurveCalculation'
import { calculateStressCurves } from '../../src/utils/calculateStressCurves'
import type { CurvesService, CalculateCurvesRequest } from '../../src/api/types'
import type { CurveCalculation, CurvePreview } from '../../src/utils/curveTypes'

// Run through Vite at /tests/browser/; this file is not a production entry point.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const root = createRoot(document.getElementById('fixture')!)
const output = document.getElementById('results')!
const messages: string[] = []
let api: ReturnType<typeof useCurveCalculation>
const requests: { request: CalculateCurvesRequest; signal: AbortSignal; resolve: (value: CurveCalculation) => void }[] = []
const service: CurvesService = {
  adapter: {
    async getBaseCurve() { return null },
    calculateCurves(request, { signal }) {
      // Deliberately ignore cancellation: an old HTTP response may still arrive.
      return new Promise(resolve => { requests.push({ request, signal, resolve }) })
    },
  },
}
export function Harness({ date, ready, scope }: { date: string; ready: boolean; scope: string }) {
  const source: CurvePreview | null = ready ? { reportDate: date, source: 'MOEX', sourceTime: '18:49:59', points: [{ label: '1y', tenorYears: 1, rate: 12 }] } : null
  const calculation = useCurveCalculation({ reportDate: date, source, scope })
  useEffect(() => { api = calculation })
  return <p>{calculation.state.status}</p>
}
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  messages.push(`✓ ${message}`)
  output.textContent = messages.join('\n')
}
async function render(date: string, ready = true, scope = 'normal') {
  await act(async () => {
    root.render(<StrictMode><CurvesApiContext.Provider value={service}><Harness date={date} ready={ready} scope={scope} /></CurvesApiContext.Provider></StrictMode>)
  })
}
function response(index: number) {
  return calculateStressCurves({ reportDate: requests[index].request.reportDate, source: 'MOEX', sourceTime: '18:49:59',
    points: [{ label: '1y', tenorYears: 1, rate: 12 }] }, requests[index].request.parameters)
}
async function complete(index: number, result = response(index)) {
  await act(async () => { requests[index].resolve(result) })
}
async function runTests() {
  await render('2026-07-31')
  assert(requests.length === 1, 'StrictMode не дублирует автоматический запуск')
  assert(api.state.status === 'running', 'Автоматический расчёт запускается без кнопки')
  await act(async () => { void api.run('2026-07-31', { p: 8, k: 9, d: 10 }) })
  assert(requests.length === 1, 'Повторный запуск заблокирован до завершения')
  await render('2026-08-01')
  assert(requests[0].signal.aborted, 'Смена даты отменяет ожидание старого расчёта')
  await complete(0)
  assert(api.state.status === 'running', 'Поздний ответ предыдущей даты не становится результатом')
  await complete(1)
  assert(api.state.status === 'ready' && api.state.result.reportDate === '2026-08-01', 'Показан результат только текущей даты')
  await render('2026-08-01')
  assert(requests.length === 2, 'Перерисовка не запускает расчёт повторно')
  await act(async () => { void api.run('2026-08-01', { p: 1.5, k: 2, d: 3 }) })
  await complete(2)
  assert(api.state.status === 'ready' && api.state.result.parameters.p === 1.5, 'Ручной перерасчёт использует пользовательские параметры')
  await render('2026-08-02')
  assert(requests[3].request.parameters.p === 4 && requests[3].request.parameters.k === 5 && requests[3].request.parameters.d === 3,
    'Новая дата запускается со стандартными параметрами')
  await complete(3, { ...response(3), reportDate: '2026-07-31' })
  assert(api.state.status === 'error', 'Ответ с неправильной датой отклонён')
  await act(async () => { void api.run('2026-08-02', { p: 4, k: 5, d: 3 }) })
  await complete(4, { ...response(4), stressCurves: [] })
  assert(api.state.status === 'error', 'Неполный комплект кривых отклонён')
  await act(async () => { void api.run('2026-08-02', { p: 4, k: 5, d: 3 }) })
  await complete(5, { ...response(5), parameters: { p: 9, k: 5, d: 3 } })
  assert(api.state.status === 'error', 'Ответ с другими параметрами отклонён')
  await act(async () => { void api.run('2026-08-02', { p: 4, k: 5, d: 3 }) })
  await complete(6)
  assert(api.state.status === 'ready', 'После ошибки возможен успешный повторный запуск')
  await render('2026-08-03', false)
  assert(api.state.status === 'idle' && requests.length === 7, 'Без исходных данных расчёт не запускается')
  await render('2026-08-03', true)
  assert(requests.length === 8, 'Появление исходных данных запускает расчёт')
  await act(async () => { root.unmount() })
  assert(requests[7].signal.aborted, 'Размонтирование отменяет ожидание расчёта')
  await complete(7)
  messages.push('\nВсе проверки пройдены.')
  output.textContent = messages.join('\n')
}
void runTests().catch(error => {
  output.textContent = [...messages, `\nОШИБКА: ${error instanceof Error ? error.message : String(error)}`].join('\n')
  throw error
})
