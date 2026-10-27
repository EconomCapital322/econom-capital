import { isPositiveParameter, STANDARD_PARAMETERS } from '../utils/parameters'
import { isReportDate } from '../utils/validateCurves'
import type { ScenarioParameters } from '../utils/curveTypes'
import type { CurvesService } from './types'
import { invalidResponse, parseInput, parseList, parseResult, parseState, record, runId } from './httpContract'
import type { RemoteSnapshot } from './httpContract'

export interface RemoteCurvesApi {
  cacheKey: string
  snapshot(reportDate: string, signal: AbortSignal, preferredRunId?: string): Promise<RemoteSnapshot>
  start(reportDate: string, parameters: ScenarioParameters, parentRunId?: string): Promise<string>
}
function httpMessage(status: number, code?: unknown): string {
  if (code === 'INPUT_DATA_NOT_READY') return 'Исходные ставки за эту дату ещё не готовы. Проверьте наличие данных.'
  if (code === 'RESULT_NOT_READY') return 'Расчёт ещё не завершён. Повторите получение результата.'
  if (code === 'RUN_STATE_CONFLICT') return 'Этот запуск нельзя пересчитать. Проверьте его состояние.'
  if (status === 422) return 'Сервер отклонил запрос. Текущая версия API допускает P/K/D не больше 25 п. п.'
  if (status === 404) return 'Запрошенный расчёт не найден на сервере.'
  if (status >= 500) return 'Сервер временно недоступен или не настроен для расчёта. Попробуйте позже.'
  return 'Не удалось выполнить запрос. Повторите попытку.'
}
/** Actual FastAPI routes. No MOEX requests, local mathematics or demo fallback. */
export function createHttpCurvesService(baseUrl = '', fetcher: typeof fetch = fetch): CurvesService {
  const origin = baseUrl.replace(/\/+$/, '')
  async function request(path: string, options: { signal?: AbortSignal; body?: unknown } = {}): Promise<unknown> {
    const timeout = new AbortController()
    const onAbort = () => timeout.abort(options.signal?.reason)
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => timeout.abort(), 30_000)
    let response: Response | undefined
    let value: unknown
    try {
      response = await fetcher(`${origin}/api/v1${path}`, {
        method: options.body === undefined ? 'GET' : 'POST', signal: timeout.signal, cache: 'no-store',
        headers: options.body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
      value = await response.json()
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      if (timeout.signal.aborted) throw new Error(options.body === undefined
        ? 'Время ожидания ответа сервера истекло. Повторите получение данных.'
        : 'Ответ на запуск не получен. Проверьте список расчётов перед повторной попыткой.', { cause: error })
      if (response) throw new Error(response.ok ? 'Сервер вернул ответ в неизвестном формате.' : httpMessage(response.status), { cause: error })
      if (error instanceof TypeError) throw new Error('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.', { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (!response) return invalidResponse()
    if (!response.ok) {
      const envelope = value && typeof value === 'object' ? (value as { error?: { code?: unknown } }).error : undefined
      throw new Error(httpMessage(response.status, envelope?.code))
    }
    if (options.body !== undefined && response.status !== 202) return invalidResponse()
    return value
  }
  const remote: RemoteCurvesApi = {
    cacheKey: origin,
    async snapshot(reportDate, signal, preferredRunId) {
      if (!isReportDate(reportDate)) throw new Error('Выберите корректную отчётную дату.')
      const query = `?reportDate=${encodeURIComponent(reportDate)}`
      const [rawInput, rawList] = await Promise.all([request(`/input-rates${query}`, { signal }), request(`/curve-runs${query}`, { signal })])
      const input = parseInput(rawInput, reportDate), runs = parseList(rawList, reportDate)
      const id = preferredRunId ?? runs[0]?.runId
      if (!id) return { input, runs, run: null, result: null }
      const run = parseState(await request(`/curve-runs/${runId(id)}`, { signal }), reportDate, id)
      const result = run.status === 'ready' ? parseResult(await request(`/curve-runs/${id}/result`, { signal }), run) : null
      return { input, runs, run, result }
    },
    async start(reportDate, parameters, parentRunId) {
      if (!isReportDate(reportDate) || ![parameters.p, parameters.k, parameters.d].every(isPositiveParameter)) throw new Error('Проверьте дату и параметры расчёта.')
      const standard = parameters.p === STANDARD_PARAMETERS.p && parameters.k === STANDARD_PARAMETERS.k && parameters.d === STANDARD_PARAMETERS.d
      const scenarioParameters = standard ? { mode: 'standard' } : { mode: 'custom', ...parameters }
      const path = parentRunId ? `/curve-runs/${runId(parentRunId)}/recalculations` : '/curve-runs'
      // No component-lifetime AbortSignal for POST: disconnecting the UI does not cancel a server job.
      const accepted = record(await request(path, { body: parentRunId ? { scenarioParameters } : { reportDate, scenarioParameters } }))
      if (accepted.status !== 'queued') return invalidResponse()
      return runId(accepted.runId)
    },
  }
  return {
    remote,
    adapter: {
      async getBaseCurve() { throw new Error('Используйте получение состояния серверного расчёта.') },
      async calculateCurves() { throw new Error('Локальный расчёт отключён в режиме API.') },
    },
  }
}
