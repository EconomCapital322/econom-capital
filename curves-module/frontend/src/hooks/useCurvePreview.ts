import { useQuery } from '@tanstack/react-query'
import { useCurvesApi } from './useCurvesApi'
import { isCurvePreview, isReportDate } from '../utils/validateCurves'

export function useCurvePreview(reportDate: string, scope: string, enabled = true) {
  const { adapter } = useCurvesApi()
  return useQuery({
    queryKey: ['base-curve', scope, reportDate],
    queryFn: async ({ signal }) => {
      const preview = await adapter.getBaseCurve({ reportDate }, { signal })
      if (preview !== null && (!isCurvePreview(preview) || preview.reportDate !== reportDate)) {
        throw new Error('Получены некорректные исходные данные или данные за другую дату.')
      }
      return preview
    },
    enabled: enabled && isReportDate(reportDate),
    // Never show another date's cached data while this date is loading.
    placeholderData: undefined,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}
