import type { ScenarioParameters } from './curveTypes'

export const STANDARD_PARAMETERS: Readonly<ScenarioParameters> = {
  p: 4,
  k: 5,
  d: 3,
}

export const PARAMETER_FIELDS = [
  { key: 'p', name: 'Параллельный шок', symbol: 'P' },
  { key: 'k', name: 'Краткосрочный шок', symbol: 'K' },
  { key: 'd', name: 'Долгосрочный шок', symbol: 'D' },
] as const

export function isPositiveParameter(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function formatRate(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}
