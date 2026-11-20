import { createContext } from 'react'
import type { CurvesService } from '../api/types'

export const CurvesApiContext = createContext<CurvesService | null>(null)
