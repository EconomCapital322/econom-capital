import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCurvesApi } from './useCurvesApi'
import { isReportDate } from '../utils/validateCurves'
import { ApiRequestError } from '../api/httpAdapter'
import { calculationError, inputPreview } from '../api/httpContract'
import type { ScenarioParameters, CurveCalculation } from '../utils/curveTypes'

type RemoteState = { status: 'idle' | 'running' } | { status: 'error'; message: string } | { status: 'ready'; result: CurveCalculation }

export function useRemoteCurves(reportDate: string) {
  const { remote } = useCurvesApi()
  const client = useQueryClient()
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [refreshVersion, setRefreshVersion] = useState(0)
  const submitting = useRef(false)
  const preferredId = selections[reportDate]
  const queryKey = ['server-curves', remote?.cacheKey, reportDate, preferredId, refreshVersion] as const
  const query = useQuery({
    queryKey,
    enabled: !!remote && isReportDate(reportDate),
    queryFn: ({ signal }) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.snapshot(reportDate, signal, preferredId)
    },
    placeholderData: undefined,
    retry: (count, error) => count < 2 && !(error instanceof ApiRequestError && error.status < 500),
    retryDelay: attempt => Math.min(1500 * (attempt + 1), 5000), staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: q => {
      if (q.state.error) return false
      const status = q.state.data?.run?.status
      if (status === 'queued' || status === 'running') return 1500
      // Wait for server-owned source loading/automatic queueing for at most
      // 24 successful refreshes. A manual refresh restarts this bounded watch.
      return !status && q.state.dataUpdateCount < 24 ? 5000 : false
    },
  })
  const mutation = useMutation({
    retry: false,
    mutationFn: async (variables: { date: string; parameters: ScenarioParameters; parent?: string; previousRunId?: string }) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.start(variables.date, variables.parameters, variables.parent)
    },
    onSuccess: (id, variables) => {
      setSelections(current => ({ ...current, [variables.date]: id }))
    },
    onError: (_error, variables) => {
      // A lost POST response does not prove the job was not committed. Refresh
      // the list, without retrying POST or replacing another date's state.
      setSelections(current => {
        const next = { ...current }
        delete next[variables.date]
        return next
      })
      void client.invalidateQueries({ queryKey: ['server-curves', remote?.cacheKey, variables.date] })
    },
  })
  const snapshot = query.isError ? undefined : query.data
  const run = snapshot?.run
  let state: RemoteState = { status: 'idle' }
  const mutationForDate = mutation.variables?.date === reportDate
  if (mutation.isPending && mutationForDate) state = { status: 'running' }
  else if (run?.status === 'queued' || run?.status === 'running') state = { status: 'running' }
  else if (run?.status === 'failed') state = { status: 'error', message: calculationError(run.error?.code) }
  else if (snapshot?.result) state = { status: 'ready', result: snapshot.result }
  if (mutation.isError && mutationForDate && state.status !== 'running' && (!run || run.runId === mutation.variables?.previousRunId)) state = { status: 'error', message: mutation.error.message }

  async function start(parameters: ScenarioParameters) {
    if (!remote || submitting.current || query.isFetching || state.status === 'running' || !snapshot) return
    // Stress recalculation is tied to the parent's saved base and source, not
    // today's input points. A failed base stage requires a fresh full run.
    const parent = run?.stage === 'stress' ? run.runId : undefined
    if (!parent && !snapshot.input.available) return
    submitting.current = true
    try { await mutation.mutateAsync({ date: reportDate, parameters: { ...parameters }, parent, previousRunId: run?.runId }) }
    catch { /* The mutation state renders the public error. Never retry POST here. */ }
    finally { submitting.current = false }
  }
  const validation = mutation.isError && mutationForDate && mutation.error instanceof ApiRequestError
    ? { parameters: mutation.variables.parameters, fields: mutation.error.fieldErrors } : undefined
  return { enabled: !!remote, query, state, start, validation, isSubmitting: mutation.isPending && mutationForDate,
    refresh: () => setRefreshVersion(version => version + 1),
    canStart: !!snapshot && !mutation.isPending && !query.isFetching && (snapshot.input.available || run?.stage === 'stress'),
    preview: snapshot ? inputPreview(snapshot.input, snapshot.result) : null }
}
