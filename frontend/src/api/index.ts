import { createDemoCurvesService } from './demoAdapter'

// Reserved for a future HTTP adapter. Setting this does not enable requests:
// routes, payloads and authentication are not present in this repository yet.
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? ''

// Composition point: replace this service after the backend contract is agreed.
// App/components/hooks consume the interface, not the fixture implementation.
export const curvesService = createDemoCurvesService()
