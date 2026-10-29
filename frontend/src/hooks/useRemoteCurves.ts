import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCurvesApi } from './useCurvesApi'
import { isReportDate } from '../utils/validateCurves'
import { calculationError, inputPreview } from '../api/httpContract'
import type { ScenarioParameters, CurveCalculation } from '../utils/curveTypes'

type RemoteState = { status: 'idle' | 'running' } | { status: 'error'; message: string } | { status: 'ready'; result: CurveCalculation }

export function useRemoteCurves(reportDate: string) {
  const { remote } = useCurvesApi()
  const client = useQueryClient()
  const [selection, setSelection] = useState<{ date: string; id: string } | null>(null)
  const submitting = useRef(false)
  const preferredId = selection?.date === reportDate ? selection.id : undefined
  const queryKey = ['server-curves', remote?.cacheKey, reportDate, preferredId] as const
  const query = useQuery({
    queryKey,
    enabled: !!remote && isReportDate(reportDate),
    queryFn: ({ signal }) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.snapshot(reportDate, signal, preferredId)
    },
    placeholderData: undefined, retry: false, staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: q => {
      if (q.state.error) return false
      const status = q.state.data?.run?.status
      return status === 'queued' || status === 'running' ? 1500 : false
    },
  })
  const mutation = useMutation({
    retry: false,
    mutationFn: async (variables: { date: string; parameters: ScenarioParameters; parent?: string; previousRunId?: string }) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.start(variables.date, variables.parameters, variables.parent)
    },
    onSuccess: (id, variables) => { setSelection({ date: variables.date, id }) },
    onError: (_error, variables) => {
      // A lost POST response does not prove the job was not committed. Refresh
      // the list, without retrying POST or replacing another date's state.
      setSelection(current => current?.date === variables.date ? null : current)
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
  return { enabled: !!remote, query, state, start, isSubmitting: mutation.isPending,
    canStart: !!snapshot && !query.isFetching && (snapshot.input.available || run?.stage === 'stress'),
    preview: snapshot ? inputPreview(snapshot.input, snapshot.result) : null }
}
