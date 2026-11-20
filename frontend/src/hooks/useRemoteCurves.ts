import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCurvesApi } from './useCurvesApi'
import { isReportDate } from '../utils/validateCurves'
import { ApiRequestError } from '../api/httpAdapter'
import { calculationError, inputPreview, preparationError } from '../api/httpContract'
import type { RemoteSnapshot } from '../api/httpContract'
import type { ScenarioParameters, CurveCalculation } from '../utils/curveTypes'

type RemoteState = { status: 'idle' | 'running' } | { status: 'error'; message: string } | { status: 'ready'; result: CurveCalculation }

interface StartVariables {
  date: string
  parameters: ScenarioParameters
  parent?: string
  previousRunId?: string
}

export function useRemoteCurves(reportDate: string) {
  const { remote } = useCurvesApi()
  const client = useQueryClient()
  const [selection, setSelection] = useState<{ date: string; id?: string; readOnly?: boolean }>(() => ({
    date: reportDate, id: new URL(window.location.href).searchParams.get('runId') || undefined,
  }))
  const [refreshVersion, setRefreshVersion] = useState(0)
  const submitting = useRef(false)
  const preferredId = selection.date === reportDate ? selection.id : undefined
  const readOnly = selection.date === reportDate && (selection.readOnly || !!preferredId)
  const queryKey = ['server-curves', remote?.cacheKey, reportDate, preferredId, readOnly, refreshVersion] as const
  const query = useQuery<RemoteSnapshot, Error>({
    queryKey,
    enabled: !!remote && isReportDate(reportDate),
    queryFn: ({ signal }) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.snapshot(reportDate, signal, preferredId, readOnly)
    },
    placeholderData: undefined,
    retry: (count, error) => count < 2 && !(error instanceof ApiRequestError && error.status < 500),
    retryDelay: attempt => Math.min(1500 * (attempt + 1), 5000), staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: q => {
      if (q.state.error) return false
      const selectedStatus = q.state.data?.run?.status
      if (preferredId) return selectedStatus === 'queued' || selectedStatus === 'running' ? 1500 : false
      const sourceStatus = q.state.data?.preparation.status
      if (sourceStatus === 'queued' || sourceStatus === 'running') return 1500
      if (sourceStatus === 'no_data' && reportDate === new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })) return 60_000
      if (sourceStatus === 'no_data' || sourceStatus === 'failed') return false
      const status = q.state.data?.run?.status
      if (status === 'queued' || status === 'running') return 1500
      // Wait for server-owned source loading/automatic queueing for at most
      // 24 successful refreshes. A manual refresh restarts this bounded watch.
      return !status && q.state.dataUpdateCount < 24 ? 5000 : false
    },
  })
  const mutation = useMutation<string, Error, StartVariables>({
    retry: false,
    mutationFn: async (variables: StartVariables) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.start(variables.date, variables.parameters, variables.parent)
    },
    onSuccess: (id, variables) => {
      setSelection(current => current.date === variables.date ? { date: variables.date, id } : current)
      void client.invalidateQueries({ queryKey: ['run-history', remote?.cacheKey, variables.date] })
    },
    onError: (_error, variables) => {
      // A lost POST response does not prove the job was not committed. Refresh
      // the list, without retrying POST or replacing another date's state.
      setSelection(current => current.date === variables.date ? { date: variables.date, readOnly: true } : current)
      void client.invalidateQueries({ queryKey: ['run-history', remote?.cacheKey, variables.date] })
      void client.invalidateQueries({ queryKey: ['server-curves', remote?.cacheKey, variables.date] })
    },
  })
  const sourceRetry = useMutation<void, Error, string>({
    retry: false,
    mutationFn: async date => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      await remote.prepare(date, true)
    },
    onSettled: (_data, _error, date) => { void client.invalidateQueries({ queryKey: ['server-curves', remote?.cacheKey, date] }) },
  })
  const snapshot = query.isError ? undefined : query.data
  const run = snapshot?.run
  const isPreparing = (!preferredId && (snapshot?.preparation.status === 'queued' || snapshot?.preparation.status === 'running')) || (sourceRetry.isPending && sourceRetry.variables === reportDate)
  const preparationFailed = !preferredId && ((snapshot?.preparation.status === 'failed' && !snapshot.result) || query.isError)
  let state: RemoteState = { status: 'idle' }
  const mutationForDate = mutation.variables?.date === reportDate
  if (isPreparing) state = { status: 'running' }
  else if (query.isError) state = { status: 'error', message: query.error.message }
  else if (preparationFailed) state = { status: 'error', message: preparationError(snapshot?.preparation.errorCode ?? null) }
  else if (mutation.isPending && mutationForDate) state = { status: 'running' }
  else if (run?.status === 'queued' || run?.status === 'running') state = { status: 'running' }
  else if (run?.status === 'failed') state = { status: 'error', message: calculationError(run.error?.code) }
  else if (snapshot?.result) state = { status: 'ready', result: snapshot.result }
  if (mutation.isError && mutationForDate && state.status !== 'running' && (!run || run.runId === mutation.variables?.previousRunId)) state = { status: 'error', message: mutation.error.message }

  const resolvedRunId = snapshot?.run?.runId
  useEffect(() => {
    const url = new URL(window.location.href)
    const selectedId = preferredId ? resolvedRunId ?? preferredId : undefined
    if (selectedId) url.searchParams.set('runId', selectedId)
    else url.searchParams.delete('runId')
    window.history.replaceState(window.history.state, '', url)
  }, [preferredId, resolvedRunId])

  function selectRun(id: string) {
    if (!mutation.isPending) mutation.reset()
    setSelection({ date: reportDate, id })
  }

  function clearSelection(date: string) {
    setSelection({ date })
    if (!mutation.isPending) mutation.reset()
  }

  function refresh() {
    const cachedStatus = query.data?.run?.status
    const active = cachedStatus === 'queued' || cachedStatus === 'running' ||
      (mutation.isPending && mutationForDate)
    if (!active && !preferredId) setSelection({ date: reportDate })
    if (!mutation.isPending) mutation.reset()
    setRefreshVersion(version => version + 1)
  }

  async function start(parameters: ScenarioParameters) {
    if (submitting.current) return
    if (preparationFailed && !sourceRetry.isPending) {
      submitting.current = true
      try { await sourceRetry.mutateAsync(reportDate) } catch { /* Query refresh displays the error. */ }
      finally { submitting.current = false }
      return
    }
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
  return { enabled: !!remote, isPreparing, preparationFailed, query, state, start, validation, isSubmitting: mutation.isPending && mutationForDate,
    refresh, selectRun, clearSelection, selectedRunId: snapshot?.run?.runId ?? preferredId,
    canStart: !mutation.isPending && !sourceRetry.isPending && !query.isFetching && isReportDate(reportDate) && (preparationFailed || (!!snapshot && (snapshot.input.available || run?.stage === 'stress'))),
    preview: snapshot ? inputPreview(snapshot.input, snapshot.result) : null }
}
