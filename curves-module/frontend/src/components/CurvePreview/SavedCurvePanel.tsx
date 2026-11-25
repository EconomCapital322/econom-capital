import { useQuery } from '@tanstack/react-query'
import { parseSavedResult } from '../../api/httpContract'
import { CurvePreviewPanel } from './CurvePreviewPanel'
import { Button } from '../ui/Button'
import type { CurveExplainSelection } from '../../App'

interface SavedCurveProps {
  active: boolean
  workspaceId: string
  reportDate: string
  runId?: string
  onExplain?: (selection: CurveExplainSelection) => void
  onContext?: (selection: CurveExplainSelection | null) => void
  onBack: () => void
}

export function SavedCurvePanel({ active, workspaceId, reportDate, runId, onBack, onExplain, onContext }: SavedCurveProps) {
  const address = `/api/export/${encodeURIComponent(workspaceId)}/${encodeURIComponent(reportDate)}/standard-result.json`
  const query = useQuery({
    queryKey: ['valuation-curve', workspaceId, reportDate, runId],
    enabled: active, staleTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(address, { signal })
      if (!response.ok) throw new Error('Сохранённый снимок для этой оценки недоступен.')
      const payload = await response.json()
      return { ...parseSavedResult(payload, reportDate, runId), runId: payload.runId as string }
    },
  })
  const result = query.data
  const source = result?.dataProvenance === 'synthetic' ? 'Учебные кривые' : 'Сохранённые ставки MOEX'
  return <div className="curve-app">
    <section className="curve-page">
      <div className="curve-page__heading">
        <h1>Кривые из оценки портфеля</h1>
        <p>{reportDate.split('-').reverse().join('.')}{result && <> · {source} · снимок расчёта</>}</p>
      </div>
      <Button className="curve-archive-back" variant="outline" onClick={onBack}>К кривым за эту дату</Button>
      <CurvePreviewPanel compact calculation={result ?? null} runId={result?.runId}
        preview={result ? { reportDate, source, sourceTime: '', points: result.baseCurve } : null}
        onExplain={result && onExplain ? scenario => onExplain({ reportDate, runId: result.runId, workspaceId, scenario }) : undefined}
        onContext={onContext ? scenario => {
          if (active) onContext(scenario && result ? { reportDate, runId: result.runId, workspaceId, scenario } : null)
        } : undefined}
        message={query.isPending ? 'Открываем снимок из сохранённого отчёта…' : undefined}
        error={query.error?.message} />
      {result && <div className="curve-integration"><details><summary>Источник и методика</summary>
        {runId && <p>Run ID <code>{runId}</code></p>}
        <p>Архивная кривая, применённая в этой оценке. Дисконтирование по 23 календарным бакетам.</p>
        <p><a href={address}>Скачать исходный снимок JSON</a></p>
      </details></div>}
    </section>
  </div>
}
