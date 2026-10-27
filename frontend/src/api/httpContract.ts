import type { CurveCalculation, CurvePoint, CurvePreview, ScenarioParameters, StressScenarioCode } from '../utils/curveTypes'
import { isCompleteCalculation, isReportDate } from '../utils/validateCurves'

export type RunStatus = 'queued' | 'running' | 'ready' | 'failed'
export type RunStage = 'base' | 'stress'
export interface UsedParameters extends ScenarioParameters { mode: 'standard' | 'custom' }
export interface InputRatesDto {
  reportDate: string; available: boolean; source: 'moex'
  sourceAsOf: string | null; loadedAt: string | null
  points: { tenorYears: number; ratePercent: number }[]
}
export interface RunDto {
  runId: string; status: RunStatus; stage: RunStage; usedParameters: UsedParameters
  createdAt?: string
}
export interface RunStateDto extends RunDto {
  reportDate: string
  baseCurve?: { curveCode: 'base'; points: CurvePoint[] }
  error?: { code: string }
}
export interface RemoteSnapshot {
  input: InputRatesDto
  runs: RunDto[]
  run: RunStateDto | null
  result: CurveCalculation | null
}

const codes: Record<string, StressScenarioCode | 'base'> = {
  base: 'base', parallel_up: 'parallel-up', parallel_down: 'parallel-down',
  steepener: 'steepener', flattener: 'flattener', short_rate_up: 'short-up', short_rate_down: 'short-down',
}
export function invalidResponse(): never { throw new Error('Сервер вернул некорректные или неполные данные. Повторите получение данных.') }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : invalidResponse() }
function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : invalidResponse() }
function text(value: unknown): string { return typeof value === 'string' && value.trim() ? value : invalidResponse() }
export function runId(value: unknown): string {
  const id = text(value)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : invalidResponse()
}
function timestamp(value: unknown): string {
  const result = text(value)
  return /(?:Z|[+-]\d\d:\d\d)$/.test(result) && Number.isFinite(Date.parse(result)) ? result : invalidResponse()
}
function parameters(value: unknown): UsedParameters {
  const p = record(value)
  if (p.mode !== 'standard' && p.mode !== 'custom') return invalidResponse()
  const result = { mode: p.mode, p: finite(p.p), k: finite(p.k), d: finite(p.d) }
  if (![result.p, result.k, result.d].every(v => v > 0 && v <= 25) ||
      (result.mode === 'standard' && (result.p !== 4 || result.k !== 5 || result.d !== 3))) return invalidResponse()
  return result as UsedParameters
}
function checkDate(value: unknown, date: string): string {
  return isReportDate(value) && value === date ? value : invalidResponse()
}
export function parseInput(value: unknown, date: string): InputRatesDto {
  const dto = record(value)
  checkDate(dto.reportDate, date)
  if (dto.source !== 'moex' || typeof dto.available !== 'boolean') return invalidResponse()
  const points = array(dto.points).map(value => {
    const p = record(value)
    return { tenorYears: finite(p.tenorYears), ratePercent: finite(p.ratePercent) }
  })
  if (points.some((p, i) => p.tenorYears <= 0 || (i > 0 && p.tenorYears <= points[i - 1].tenorYears))) return invalidResponse()
  const sourceAsOf = dto.sourceAsOf === null ? null : timestamp(dto.sourceAsOf)
  const loadedAt = dto.loadedAt === null ? null : timestamp(dto.loadedAt)
  if (dto.available ? !points.length || !sourceAsOf || !loadedAt : points.length || sourceAsOf || loadedAt) return invalidResponse()
  return { reportDate: date, source: 'moex', available: dto.available, sourceAsOf, loadedAt, points }
}
export function parseRun(value: unknown): RunDto {
  const dto = record(value)
  if (!['queued', 'running', 'ready', 'failed'].includes(String(dto.status)) || !['base', 'stress'].includes(String(dto.stage))) return invalidResponse()
  return { runId: runId(dto.runId), status: dto.status as RunStatus, stage: dto.stage as RunStage,
    usedParameters: parameters(dto.usedParameters), ...(dto.createdAt === undefined ? {} : { createdAt: timestamp(dto.createdAt) }) }
}
export function parseList(value: unknown, date: string): RunDto[] {
  const dto = record(value)
  checkDate(dto.reportDate, date)
  const runs = array(dto.runs).map(parseRun)
  if (runs.some(r => !r.createdAt) || new Set(runs.map(r => r.runId)).size !== runs.length) return invalidResponse()
  return runs.sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))
}
function curve(value: unknown): { code: StressScenarioCode | 'base'; points: CurvePoint[] } {
  const dto = record(value)
  const code = typeof dto.curveCode === 'string' ? codes[dto.curveCode] : undefined
  if (!code) return invalidResponse()
  const points = array(dto.points).map(value => {
    const p = record(value)
    return { label: text(p.bucketLabel), tenorYears: finite(p.tenorYears), rate: finite(p.ratePercent) }
  })
  if (!points.length || new Set(points.map(p => p.label)).size !== points.length ||
      points.some((p, i) => p.tenorYears <= 0 || (i > 0 && p.tenorYears <= points[i - 1].tenorYears))) return invalidResponse()
  return { code, points }
}
export function parseState(value: unknown, date: string, expectedId: string): RunStateDto {
  const dto = record(value), run = parseRun(dto)
  checkDate(dto.reportDate, date)
  if (run.runId !== expectedId) return invalidResponse()
  const base = dto.baseCurve === undefined || dto.baseCurve === null ? null : curve(dto.baseCurve)
  if (base && base.code !== 'base') return invalidResponse()
  if ((run.stage === 'stress' && !base) || (run.status === 'ready' && run.stage !== 'stress')) return invalidResponse()
  const error = dto.error ? { code: text(record(dto.error).code) } : undefined
  if (run.status === 'failed' && !error) return invalidResponse()
  return { ...run, reportDate: date, ...(base ? { baseCurve: { curveCode: 'base', points: base.points } } : {}), ...(error ? { error } : {}) }
}
export function parseResult(value: unknown, run: RunStateDto): CurveCalculation {
  const dto = record(value)
  if (run.status !== 'ready' || runId(dto.runId) !== run.runId || dto.source !== 'moex') return invalidResponse()
  checkDate(dto.reportDate, run.reportDate)
  timestamp(dto.completedAt)
  const used = parameters(dto.usedParameters)
  if (used.mode !== run.usedParameters.mode || ['p', 'k', 'd'].some(key => used[key as keyof ScenarioParameters] !== run.usedParameters[key as keyof ScenarioParameters])) return invalidResponse()
  const curves = array(dto.curves).map(curve), base = curves.find(c => c.code === 'base')
  if (curves.length !== 7 || new Set(curves.map(c => c.code)).size !== 7 || !base) return invalidResponse()
  const result = { reportDate: run.reportDate, parameters: { p: used.p, k: used.k, d: used.d }, baseCurve: base.points,
    stressCurves: curves.filter((c): c is { code: StressScenarioCode; points: CurvePoint[] } => c.code !== 'base') }
  if (!isCompleteCalculation(result)) return invalidResponse()
  if (run.baseCurve && JSON.stringify(run.baseCurve.points) !== JSON.stringify(base.points)) return invalidResponse()
  return result
}
export function inputPreview(input: InputRatesDto, result?: CurveCalculation | null): CurvePreview | null {
  if (!input.available && !result) return null
  return { reportDate: input.reportDate, source: 'MOEX',
    sourceTime: input.sourceAsOf ? new Date(input.sourceAsOf).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'время публикации не указано',
    // Raw input points have no bucket labels and must never be displayed as a built base curve.
    points: result?.baseCurve ?? input.points.map(p => ({ label: `${p.tenorYears}y`, tenorYears: p.tenorYears, rate: p.ratePercent })) }
}
export function calculationError(code?: string): string {
  switch (code) {
    case 'CALCULATION_TIMEOUT': return 'Расчёт превысил время ожидания. Попробуйте ещё раз.'
    case 'CALCULATION_INTERRUPTED': return 'Выполнение расчёта прервано на сервере. Повторите расчёт.'
    case 'BASE_CURVE_FAILED': return 'Не удалось построить базовую кривую. Повторите расчёт.'
    default: return 'Не удалось рассчитать стрессовые кривые. Повторите расчёт.'
  }
}
