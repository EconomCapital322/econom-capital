import { useContext } from 'react'
import { CurvesApiContext } from '../store/CurvesApiContext'

export function useCurvesApi() {
  const service = useContext(CurvesApiContext)
  if (!service) throw new Error('CurvesApiContext is missing')
  return service
}
