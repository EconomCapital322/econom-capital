import closeIcon from '../../assets/images/dialog-close.svg'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent } from 'react'
import type { ScenarioParameters } from '../../utils/curveTypes'
import { isPositiveParameter, PARAMETER_FIELDS } from '../../utils/parameters'
import { Button } from '../ui/Button'

interface ParametersDialogProps {
  initialValue: ScenarioParameters
  onApply: (value: ScenarioParameters) => void
  onClose: () => void
}

type Draft = Record<keyof ScenarioParameters, string>

function toDraft(value: Readonly<ScenarioParameters>): Draft {
  return { p: String(value.p), k: String(value.k), d: String(value.d) }
}

export function ParametersDialog({ initialValue, onApply, onClose }: ParametersDialogProps) {
  const [draft, setDraft] = useState(() => toDraft(initialValue))
  const [errors, setErrors] = useState<Partial<Record<keyof ScenarioParameters, string>>>({})
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    firstInputRef.current?.focus()
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKeyDown) }
  }, [onClose])

  function adjust(key: keyof ScenarioParameters, delta: number) {
    const current = Number(draft[key])
    if (!Number.isFinite(current)) return
    const next = current + delta
    if (!Number.isFinite(next)) return
    // These controls add/subtract one point; manual entry still accepts any
    // positive fraction (step="any"). They do not impose a minimum or round.
    setDraft(previous => ({ ...previous, [key]: String(next) }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = { p: Number(draft.p), k: Number(draft.k), d: Number(draft.d) }
    const nextErrors: typeof errors = {}
    for (const { key } of PARAMETER_FIELDS) {
      if (draft[key].trim() === '' || !isPositiveParameter(next[key])) nextErrors[key] = 'Введите конечное число строго больше нуля'
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      const key = PARAMETER_FIELDS.find(({ key }) => nextErrors[key])?.key
      if (key) dialogRef.current?.querySelector<HTMLInputElement>(`[name="${key}"]`)?.focus()
      return
    }
    onApply(next)
  }

  return createPortal(
    <>
      <div className="modal-backdrop show parameters-backdrop" />
      <div className="modal d-block parameters-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content" ref={dialogRef}>
            <div className="modal-header">
              <h2 id={titleId} className="modal-title">Смена параметров сценариев</h2>
              <button className="dialog-close" type="button" aria-label="Закрыть" onClick={onClose}><img src={closeIcon} alt="" width="16" height="16" /></button>
            </div>
            <form onSubmit={submit} noValidate>
              <div className="modal-body">
                <p id={descriptionId} className="dialog-description">Задайте величину шоков в процентных пунктах</p>
                {PARAMETER_FIELDS.map(({ key, name, symbol }, i) => (
                  <div className="parameter-field" key={key}>
                    <label className="form-label" htmlFor={`${titleId}-${key}`}><span>{name} ({symbol})</span></label>
                    <div className={`input-group parameter-input ${errors[key] ? 'parameter-input--invalid' : ''}`}>
                      <input ref={i === 0 ? firstInputRef : undefined} className={`form-control ${errors[key] ? 'is-invalid' : ''}`} id={`${titleId}-${key}`} name={key} type="number" step="any" inputMode="decimal" style={{ width: `${Math.max(draft[key].length, 1)}ch` }} value={draft[key]} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `${titleId}-${key}-error` : undefined} onChange={(event) => { setDraft((prev) => ({ ...prev, [key]: event.target.value })); setErrors((prev) => ({ ...prev, [key]: undefined })) }} />
                      <span className="input-group-text">п. п.</span>
                      <span className="parameter-stepper">
                        <button type="button" aria-label={`Увеличить ${symbol}`} onClick={() => adjust(key, 1)}><svg viewBox="0 0 16 9" aria-hidden="true"><path d="m1 8 7-7 7 7" /></svg></button>
                        <button type="button" aria-label={`Уменьшить ${symbol}`} onClick={() => adjust(key, -1)}><svg viewBox="0 0 16 9" aria-hidden="true"><path d="m1 1 7 7 7-7" /></svg></button>
                      </span>
                    </div>
                    {errors[key] && <p className="parameter-error" id={`${titleId}-${key}-error`} role="alert">{errors[key]}</p>}
                  </div>
                ))}

              </div>
              <div className="modal-footer"><Button variant="outline" onClick={onClose}>ОТМЕНА</Button><Button type="submit">ПРИМЕНИТЬ</Button></div>
            </form>
          </div>
        </div>
      </div>
    </>, document.body,
  )
}
