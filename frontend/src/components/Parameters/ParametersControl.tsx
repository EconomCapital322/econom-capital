import { useId, useRef, useState } from 'react'
import type { ScenarioParameters } from '../../utils/curveTypes'
import { formatParameter } from '../../utils/parameters'
import { ParametersDialog } from './ParametersDialog'

interface ParametersControlProps {
  value: ScenarioParameters
  onChange: (value: ScenarioParameters) => void
  disabled?: boolean
}

export function ParametersControl({ value, onChange, disabled = false }: ParametersControlProps) {
  const [isOpen, setIsOpen] = useState(false)
  const helpId = useId()
  const editRef = useRef<HTMLButtonElement>(null)

  function close() {
    setIsOpen(false)
    editRef.current?.focus()
  }

  return (
    <div className="parameters-control">
      <div className="parameters-control__label">
        <span>Параметры сценариев</span>
        <span className="parameter-help">
          <button className="parameter-help__trigger" type="button" aria-label="Что означают P, K и D" aria-describedby={helpId}>?</button>
          <span id={helpId} className="parameter-help__content" role="tooltip">
            <strong>P — параллельный шок</strong><span>Все ставки сдвигаются на одинаковую величину.</span>
            <strong>K — краткосрочный шок</strong><span>Задаёт величину шока для коротких сроков.</span>
            <strong>D — долгосрочный шок</strong><span>Задаёт величину шока для длинных сроков.</span>
            <small>Значения задаются в процентных пунктах.</small>
          </span>
        </span>
      </div>
      <div className="parameters-control__value">
        <span>P = {formatParameter(value.p)} · K = {formatParameter(value.k)} · D = {formatParameter(value.d)} п.п.</span>
        <button ref={editRef} className="pencil-button" type="button" onClick={() => setIsOpen(true)} disabled={disabled} aria-label="Редактировать параметры" title="Редактировать параметры">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {isOpen && <ParametersDialog initialValue={value} onClose={close} onApply={(next) => { onChange(next); close() }} />}
    </div>
  )
}
