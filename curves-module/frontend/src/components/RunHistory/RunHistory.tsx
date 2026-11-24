import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import type { ReactElement, RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useCurvesApi } from '../../hooks/useCurvesApi'
import { formatParameter } from '../../utils/parameters'
import { isReportDate } from '../../utils/validateCurves'
import type { RunStatus } from '../../api/httpContract'
import clockHistoryIcon from 'bootstrap-icons/icons/clock-history.svg'
import './RunHistory.css'

const statuses: Record<RunStatus, string> = {
  queued: 'В очереди', running: 'Выполняется', ready: 'Готов', failed: 'Ошибка',
}
const time = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU')

interface HistoryProps {
  reportDate: string
  selectedRunId?: string
  onSelect: (id: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

function HistoryPanel({ reportDate, selectedRunId, onSelect, panelId, panelRef }: Pick<HistoryProps, 'reportDate' | 'selectedRunId' | 'onSelect'> & {
  panelId: string
  panelRef: RefObject<HTMLDivElement | null>
}): ReactElement {
  const { remote } = useCurvesApi()
  const query = useQuery({
    queryKey: ['run-history', remote?.cacheKey, reportDate],
    queryFn: ({ signal }) => {
      if (!remote) throw new Error('Серверный адаптер не подключён.')
      return remote.list(reportDate, signal)
    },
    enabled: !!remote && isReportDate(reportDate),
    staleTime: 0, refetchOnMount: 'always', retry: false,
    refetchInterval: query => !query.state.error && query.state.data?.slice(0, 10).some(run => run.status === 'queued' || run.status === 'running') ? 1500 : false,
  })
  return (
    <div className="run-history__panel" id={panelId} role="dialog" aria-labelledby={`${panelId}-title`} ref={panelRef} tabIndex={-1}>
      <h2 id={`${panelId}-title`}>Запуски за {dateLabel(reportDate)}</h2>
      <p className="run-history__caption">Последние 10 запусков · время МСК</p>
      {query.isPending ? <p role="status" className="run-history__message">Получаем историю…</p>
        : query.isError ? <div className="run-history__message" role="alert"><p>Не удалось получить историю запусков.</p><button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>Повторить</button></div>
        : !query.data?.length ? <p className="run-history__message" role="status">За эту дату запусков пока нет</p>
        : <ol className="run-history__list">
          {query.data.slice(0, 10).map(run => (
            <li key={run.runId}>
              <button type="button" className="run-history__run" aria-current={run.runId === selectedRunId ? 'true' : undefined} onClick={() => onSelect(run.runId)}>
                <span className="run-history__row"><time dateTime={run.createdAt}>{run.createdAt ? time.format(new Date(run.createdAt)) : 'Время не указано'}</time><span className={`run-history__status run-history__status--${run.status}`}>{statuses[run.status]}</span></span>
                <span className="run-history__kind">{run.usedParameters.mode === 'standard' ? 'Стандартные' : 'Пользовательские'} · {run.runOrigin === 'automatic' ? 'Автоматический' : 'Ручной'} запуск</span>
                <span className="run-history__parameters">P = {formatParameter(run.usedParameters.p)} · K = {formatParameter(run.usedParameters.k)} · D = {formatParameter(run.usedParameters.d)} п. п.</span>
                {run.runId === selectedRunId && <span className="run-history__current">Выбранный запуск</span>}
              </button>
            </li>
          ))}
        </ol>}
    </div>
  )
}

export function RunHistory({ reportDate, selectedRunId, onSelect, open, onOpenChange }: HistoryProps): ReactElement {
  const id = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const root = rootRef.current
    if (!root) return
    if (window.innerHeight - root.getBoundingClientRect().bottom < 160) root.scrollIntoView({ block: 'center' })
    const measure = () => root.style.setProperty('--run-history-space', `${Math.max(80, window.innerHeight - root.getBoundingClientRect().bottom - 24)}px`)
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { passive: true })
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    function dismiss(event: PointerEvent) {
      if (rootRef.current && !event.composedPath().includes(rootRef.current)) {
        onOpenChange(false)
        triggerRef.current?.focus({ preventScroll: true })
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onOpenChange(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open, onOpenChange])

  return (
    <div className="run-history" ref={rootRef} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false)
    }}>
      <button className="run-history__trigger" type="button" ref={triggerRef} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" disabled={!isReportDate(reportDate)} onClick={() => onOpenChange(!open)}>
        <span className="run-history__icon" style={{ maskImage: `url("${clockHistoryIcon}")` }} aria-hidden="true" />
        <span className="run-history__label">История</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="m3 6 5 5 5-5" /></svg>
      </button>
      {open && <HistoryPanel reportDate={reportDate} selectedRunId={selectedRunId} panelId={id} panelRef={panelRef} onSelect={id => {
        onSelect(id)
        onOpenChange(false)
        triggerRef.current?.focus()
      }} />}
    </div>
  )
}
