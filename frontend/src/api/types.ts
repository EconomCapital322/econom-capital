import type { CurveCalculation, CurvePreview, ScenarioParameters } from '../utils/curveTypes'

// Internal application models, NOT backend DTOs or an assumed HTTP contract.
export interface GetBaseCurveRequest { reportDate: string }
export type GetBaseCurveResponse = CurvePreview | null
export interface CalculateCurvesRequest {
  reportDate: string
  parameters: Readonly<ScenarioParameters>
}
export type CalculateCurvesResponse = CurveCalculation
export interface AdapterOptions { signal: AbortSignal }

/** A real adapter maps agreed backend DTOs and statuses to these UI models.
 * It may wait/poll internally if the confirmed API requires that protocol.
 */
export interface CurvesAdapter {
  getBaseCurve(request: GetBaseCurveRequest, options: AdapterOptions): Promise<GetBaseCurveResponse>
  calculateCurves(request: CalculateCurvesRequest, options: AdapterOptions): Promise<CalculateCurvesResponse>
}

export type DemoMode = 'normal' | 'error-once' | 'no-data'
export interface DemoControls { setMode(mode: DemoMode): void }
export interface CurvesService {
  remote?: import('./httpAdapter').RemoteCurvesApi
  adapter: CurvesAdapter
  demonstration?: DemoControls
}
