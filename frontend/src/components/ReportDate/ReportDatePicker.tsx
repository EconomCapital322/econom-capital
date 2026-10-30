import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { isReportDate } from '../../utils/validateCurves'
import './ReportDatePicker.css'

interface ReportDatePickerProps {
  value: string
  onChange: (date: string) => void
}

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const calendarIcon = new URL('../../assets/images/calendar.svg', import.meta.url).href

function formatDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseDate(value: string): Date {
  return isReportDate(value) ? new Date(`${value}T12:00:00`) : new Date()
}

export function ReportDatePicker({ value, onChange }: ReportDatePickerProps) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(value)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const grid = useRef<HTMLDivElement | null>(null)
  const popupId = useId()
  const labelId = useId()
  const valueId = useId()
  const titleId = useId()
  const date = parseDate(cursor)
  const year = date.getFullYear()
  const month = date.getMonth()
  const first = new Date(year, month, 1, 12)
  const offset = (first.getDay() + 6) % 7
  const count = new Date(year, month + 1, 0).getDate()
  const today = formatDate(new Date())

  useEffect(() => {
    if (!open) return
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)?.focus()
  }, [open, cursor])

  useEffect(() => {
    if (!open) return
    function outside(event: Event) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  function select(next: string) {
    setCursor(next)
    onChange(next)
    setOpen(false)
    trigger.current?.focus()
  }

  function moveMonth(amount: number) {
    const next = new Date(year, month + amount, 1, 12)
    if (next.getFullYear() < 1000 || next.getFullYear() > 9999) return
    setCursor(formatDate(next))
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    const next = parseDate(cursor)
    let handled = true
    switch (event.key) {
      case 'ArrowLeft': next.setDate(next.getDate() - 1); break
      case 'ArrowRight': next.setDate(next.getDate() + 1); break
      case 'ArrowUp': next.setDate(next.getDate() - 7); break
      case 'ArrowDown': next.setDate(next.getDate() + 7); break
      case 'Home': next.setDate(next.getDate() - (next.getDay() + 6) % 7); break
      case 'End': next.setDate(next.getDate() + 6 - (next.getDay() + 6) % 7); break
      case 'PageUp': case 'PageDown': {
        const day = next.getDate()
        next.setDate(1)
        next.setMonth(next.getMonth() + (event.key === 'PageUp' ? -1 : 1))
        next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()))
        break
      }
      default: handled = false
    }
    if (handled) {
      event.preventDefault()
      if (next.getFullYear() >= 1000 && next.getFullYear() <= 9999) setCursor(formatDate(next))
    }
  }

  return (
    <div className="report-date" ref={root} onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }}>
      <span id={labelId} className="form-label">Отчётная дата</span>
      <button ref={trigger} type="button" className="report-date__trigger" aria-labelledby={`${labelId} ${valueId}`}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
        onClick={() => { if (!open) setCursor(value); setOpen(!open) }}>
        <span id={valueId}>{isReportDate(value) ? value.split('-').reverse().join('.') : 'Выберите дату'}</span>
        <img src={calendarIcon} width="20" height="20" alt="" />
      </button>
      {open && <div className="date-calendar" id={popupId} role="dialog" aria-labelledby={titleId}>
        <div className="date-calendar__header">
          <button type="button" className="date-calendar__nav" aria-label="Предыдущий месяц" disabled={year === 1000 && month === 0} onClick={() => moveMonth(-1)}>‹</button>
          <span id={titleId} aria-live="polite">{MONTHS[month]} <span>{year}</span></span>
          <button type="button" className="date-calendar__nav" aria-label="Следующий месяц" disabled={year === 9999 && month === 11} onClick={() => moveMonth(1)}>›</button>
        </div>
        <div className="date-calendar__weekdays" aria-hidden="true">{WEEKDAYS.map(day => <span key={day}>{day}</span>)}</div>
        <div className="date-calendar__days" ref={grid} role="group" aria-label="Дни месяца">
          {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}
          {Array.from({ length: count }, (_, index) => {
            const day = index + 1
            const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            return <button key={iso} type="button" data-date={iso} className="date-calendar__day"
              aria-label={new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
              aria-pressed={iso === value} aria-current={iso === today ? 'date' : undefined}
              tabIndex={iso === cursor ? 0 : -1} onKeyDown={navigate} onClick={() => select(iso)}>{day}</button>
          })}
        </div>
        <div className="date-calendar__footer"><button type="button" onClick={() => select(formatDate(new Date()))}>Сегодня</button><button type="button" onClick={() => { setOpen(false); trigger.current?.focus() }}>Закрыть</button></div>
      </div>}
    </div>
  )
}
