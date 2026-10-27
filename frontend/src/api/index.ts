import { createDemoCurvesService } from './demoAdapter'
import { createHttpCurvesService } from './httpAdapter'

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? ''
const mode = import.meta.env.VITE_API_MODE ?? 'api'
if (mode !== 'api' && mode !== 'demo') throw new Error('VITE_API_MODE must be api or demo')
// API is the normal mode. Only an explicit setting activates local fixtures.
export const curvesService = mode === 'demo' ? createDemoCurvesService() : createHttpCurvesService(apiBaseUrl)
