import type { ReactElement } from 'react'
import { useId, useRef, useState } from 'react'
import type { ScenarioParameters } from '../../utils/curveTypes'
import { formatParameter } from '../../utils/parameters'
import { ParametersDialog } from './ParametersDialog'

const pencilIcon = new URL('../../assets/images/parameter-pencil.svg', import.meta.url).href

export interface ParametersControlProps {
  value: ScenarioParameters
  onChange: (value: ScenarioParameters) => void
  disabled?: boolean
  errors?: Partial<Record<keyof ScenarioParameters, string>>
}

export function ParametersControl({ value, onChange, disabled = false, errors }: ParametersControlProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const helpId = useId()
  const editRef = useRef<HTMLButtonElement | null>(null)

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
        <span className="parameter-values">
          <span>P = {formatParameter(value.p)} п. п.</span><i aria-hidden="true">·</i>
          <span>K = {formatParameter(value.k)} п. п.</span><i aria-hidden="true">·</i>
          <span>D = {formatParameter(value.d)} п. п.</span>
        </span>
        <button ref={editRef} className="pencil-button" type="button" onClick={() => setIsOpen(true)} disabled={disabled} aria-label="Редактировать параметры" title="Редактировать параметры">
          <img src={pencilIcon} alt="" width="25" height="25" />
        </button>
      </div>
      {isOpen && <ParametersDialog initialValue={value} initialErrors={errors} onClose={close} onApply={(next) => { onChange(next); close() }} />}
    </div>
  )
}
