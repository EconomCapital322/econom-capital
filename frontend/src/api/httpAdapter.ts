import { isPositiveParameter, STANDARD_PARAMETERS } from '../utils/parameters'
import { isReportDate } from '../utils/validateCurves'
import type { ScenarioParameters } from '../utils/curveTypes'
import type { CurvesService } from './types'
import { invalidResponse, parsePreparation, parseInput, parseList, parseResult, parseState, record, runId, isRunId } from './httpContract'
import type { RemoteSnapshot, RunDto } from './httpContract'

export interface RemoteCurvesApi {
  cacheKey: string
  list(reportDate: string, signal: AbortSignal): Promise<RunDto[]>
  prepare(reportDate: string, retry?: boolean): Promise<void>
  snapshot(reportDate: string, signal: AbortSignal, preferredRunId?: string, readOnly?: boolean): Promise<RemoteSnapshot>
  start(reportDate: string, parameters: ScenarioParameters, parentRunId?: string): Promise<string>
}
export class ApiRequestError extends Error {
  readonly status: number
  readonly fieldErrors: Partial<Record<keyof ScenarioParameters, string>>
  constructor(message: string, status: number,
    fieldErrors: Partial<Record<keyof ScenarioParameters, string>> = {}) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
    this.name = 'ApiRequestError'
  }
}
function httpMessage(status: number, code?: unknown): string {
  if (code === 'INPUT_DATA_NOT_READY') return 'Исходные ставки за эту дату ещё не готовы. Проверьте наличие данных.'
  if (code === 'RESULT_NOT_READY') return 'Расчёт ещё не завершён. Повторите получение результата.'
  if (code === 'RUN_STATE_CONFLICT') return 'Этот запуск нельзя пересчитать. Проверьте его состояние.'
  if (code === 'BASE_CURVE_FAILED') return 'Не удалось построить базовую кривую. Повторите расчёт.'
  if (code === 'CALCULATION_TIMEOUT') return 'Серверный расчёт превысил время ожидания.'
  if (code === 'CALCULATION_INTERRUPTED') return 'Серверный расчёт прерван. Повторите расчёт.'
  if (code === 'CALCULATION_FAILED') return 'Не удалось рассчитать стрессовые кривые. Повторите расчёт.'
  if (status === 422) return 'Сервер отклонил запрос. Проверьте дату и параметры.'
  if (status === 404) return 'Запрошенный расчёт не найден на сервере.'
  if (status >= 500) return 'Сервер временно недоступен или не настроен для расчёта. Попробуйте позже.'
  return 'Не удалось выполнить запрос. Повторите попытку.'
}
function responseError(status: number, value: unknown): ApiRequestError {
  const info = value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined
  const error = info && typeof info === 'object' ? info as { code?: unknown; details?: unknown } : undefined
  const fields: Partial<Record<keyof ScenarioParameters, string>> = {}
  if (status === 422 && Array.isArray(error?.details)) {
    for (const detail of error.details) {
      if (!detail || typeof detail !== 'object' || !('field' in detail)) continue
      const field: unknown = detail['field']
      if (typeof field !== 'string') continue
      const match = /^(?:scenarioParameters\.)?([pkd])$/.exec(field)
      if (match) {
        // The public backend currently hides validation reasons as 'Invalid value'.
        // Do not infer its bounds from the independent product limit of 50.
        fields[match[1] as keyof ScenarioParameters] = 'Сервер отклонил значение. Проверьте допустимые параметры.'
      }
    }
  }
  // Server message/reason may contain internal paths or exception text. Only
  // recognized codes/field names reach the UI through safe Russian messages.
  return new ApiRequestError(httpMessage(status, error?.code), status, fields)
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
      throw responseError(response.status, value)
    }
    if (options.body !== undefined && ![200, 202].includes(response.status)) return invalidResponse()
    return value
  }
  // Date preparation is server-idempotent. One in-flight POST per date survives
  // StrictMode and concurrent snapshots; lost replies are recovered with GET.
  const preparations = new Map<string, Promise<void>>()
  const preparationErrors = new Map<string, unknown>()
  async function prepare(reportDate: string, retry = false): Promise<void> {
    if (!isReportDate(reportDate)) throw new Error('Выберите корректную отчётную дату.')
    if (retry || !preparations.has(reportDate)) {
      preparationErrors.delete(reportDate)
      const pending = request('/curve-preparations', { body: { reportDate, retry } })
        .then(value => { parsePreparation(value, reportDate) })
        .catch(error => { preparationErrors.set(reportDate, error) })
      preparations.set(reportDate, pending)
    }
    await preparations.get(reportDate)
  }
  const remote: RemoteCurvesApi = {
    cacheKey: origin,
    prepare,
    async list(reportDate, signal) {
      if (!isReportDate(reportDate)) throw new Error('Выберите корректную отчётную дату.')
      return parseList(await request(`/curve-runs?reportDate=${encodeURIComponent(reportDate)}`, { signal }), reportDate)
    },
    async snapshot(reportDate, signal, preferredRunId, readOnly = false) {
      if (!isReportDate(reportDate)) throw new Error('Выберите корректную отчётную дату.')
      // An explicit historical selection is read-only, even after a reload.
      if (preferredRunId && !isRunId(preferredRunId)) throw new ApiRequestError('Ссылка на расчёт некорректна. Выберите запуск в истории.', 422)
      if (!preferredRunId && !readOnly) await prepare(reportDate)
      const query = `?reportDate=${encodeURIComponent(reportDate)}`
      const [rawInput, rawList, rawPreparation] = await Promise.all([request(`/input-rates${query}`, { signal }), request(`/curve-runs${query}`, { signal }), request(`/curve-preparations${query}`, { signal })])
      const preparation = parsePreparation(rawPreparation, reportDate)
      if (!preferredRunId && !readOnly && preparation.status === 'idle' && preparationErrors.has(reportDate)) throw preparationErrors.get(reportDate)
      const input = parseInput(rawInput, reportDate)
      let runs = parseList(rawList, reportDate)
      // The source worker may commit between the parallel GETs. Do not lose
      // its newly created run because the first list was read a moment earlier.
      if (preparation.runId && !runs.some(item => item.runId === preparation.runId)) {
        runs = parseList(await request(`/curve-runs${query}`, { signal }), reportDate)
      }
      const id = preferredRunId ?? runs[0]?.runId ?? preparation.runId
      if (!id) return { input, runs, preparation, run: null, result: null }
      let availableRuns = runs
      let rawState: unknown
      let selectedId = id
      try {
        rawState = await request(`/curve-runs/${runId(selectedId)}`, { signal })
      } catch (error) {
        // Only a missing explicitly selected run may fall back. Transport errors
        // must remain errors; never hide them by opening a different calculation.
        if (!preferredRunId || !(error instanceof ApiRequestError) || error.status !== 404) throw error
        const latest = parseList(await request(`/curve-runs${query}`, { signal }), reportDate)
        availableRuns = latest
        selectedId = latest.find(item => item.runId !== preferredRunId)?.runId ?? ''
        if (!selectedId) return { input, runs: latest, preparation, run: null, result: null }
        rawState = await request(`/curve-runs/${runId(selectedId)}`, { signal })
      }
      const run = parseState(rawState, reportDate, selectedId)
      const result = run.status === 'ready' ? parseResult(await request(`/curve-runs/${selectedId}/result`, { signal }), run) : null
      return { input, runs: availableRuns, preparation, run, result }
    },
    async start(reportDate, parameters, parentRunId) {
      if (!isReportDate(reportDate) || ![parameters.p, parameters.k, parameters.d].every(isPositiveParameter)) throw new Error('Проверьте дату и параметры расчёта.')
      const standard = parameters.p === STANDARD_PARAMETERS.p && parameters.k === STANDARD_PARAMETERS.k && parameters.d === STANDARD_PARAMETERS.d
      const scenarioParameters = standard ? { mode: 'standard' } : { mode: 'custom', ...parameters }
      const path = parentRunId ? `/curve-runs/${runId(parentRunId)}/recalculations` : '/curve-runs'
      // No component-lifetime AbortSignal for POST: disconnecting the UI does not cancel a server job.
      const accepted = record(await request(path, { body: parentRunId ? { scenarioParameters } : { reportDate, scenarioParameters } }))
      if (!['queued', 'running', 'ready'].includes(String(accepted.status))) return invalidResponse()
      return runId(accepted.runId)
    },
  }
  return {
    remote,
    adapter: {
      async getBaseCurve(): Promise<never> { throw new Error('Используйте получение состояния серверного расчёта.') },
      async calculateCurves(): Promise<never> { throw new Error('Локальный расчёт отключён в режиме API.') },
    },
  }
}
