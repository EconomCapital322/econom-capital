import { useState } from 'react'
import { useCurvesApi } from './useCurvesApi'
import type { DemoMode } from '../api/types'

export function useDemonstration() {
  const { demonstration } = useCurvesApi()
  const [mode, setMode] = useState<DemoMode>('normal')
  function changeMode(nextMode: DemoMode) {
    demonstration?.setMode(nextMode)
    setMode(nextMode)
  }
  return { available: !!demonstration, mode, changeMode }
}
