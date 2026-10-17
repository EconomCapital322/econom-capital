import { useQuery } from '@tanstack/react-query'
import { useCurvesApi } from './useCurvesApi'

export function useCurvePreview(reportDate: string, scope: string) {
  const { adapter } = useCurvesApi()
  return useQuery({
    queryKey: ['base-curve', scope, reportDate],
    queryFn: ({ signal }) => adapter.getBaseCurve({ reportDate }, { signal }),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(reportDate),
    // Never show another date's cached data while this date is loading.
    placeholderData: undefined,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}
