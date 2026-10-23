import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../src/App'
import { CurvesApiContext } from '../../src/store/CurvesApiContext'
import { calculateStressCurves } from '../../src/utils/calculateStressCurves'
import type { CurveCalculation, CurvePreview } from '../../src/utils/curveTypes'
import type { CalculateCurvesRequest, CurvesService } from '../../src/api/types'
import 'bootstrap/dist/css/bootstrap.min.css'
import '../../src/index.css'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
// Flush Query notifications through act/microtasks, not arbitrary test sleeps.
notifyManager.setScheduler(callback => queueMicrotask(callback))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const sources: (ReturnType<typeof deferred<CurvePreview | null>> & { date: string; signal: AbortSignal })[] = []
const calculations: (ReturnType<typeof deferred<CurveCalculation>> & { request: CalculateCurvesRequest; source: CurvePreview; signal: AbortSignal })[] = []
let latestSource: CurvePreview | null = null
const service: CurvesService = { adapter: {
  getBaseCurve({ reportDate }, { signal }) {
    const pending = { ...deferred<CurvePreview | null>(), date: reportDate, signal }
    sources.push(pending)
    signal.addEventListener('abort', () => pending.reject(new DOMException('Cancelled', 'AbortError')), { once: true })
    return pending.promise
  },
  calculateCurves(request, { signal }) {
    if (!latestSource) throw new Error('No test source')
    const pending = { ...deferred<CurveCalculation>(), request, source: structuredClone(latestSource), signal }
    calculations.push(pending)
    // Ignore cancellation to exercise late responses in the actual App.
    return pending.promise
  },
} }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
const fixture = document.getElementById('fixture')!
const root = createRoot(fixture)
const output = document.getElementById('results')!
const messages: string[] = []
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  messages.push(`✓ ${message}`)
  output.textContent = messages.join('\n')
}
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
  if (!found) throw new Error(`Button missing: ${name}`)
  return found
}
const hasText = (text: string) => fixture.textContent?.includes(text) ?? false
const exportAvailable = () => [...fixture.querySelectorAll<HTMLButtonElement>('button')].some(node => node.textContent === 'Скачать CSV' && !node.disabled)
const source = (date = '2026-07-31', rate = 12): CurvePreview => ({ reportDate: date, source: 'MOEX', sourceTime: '18:49:59', points: [
  { label: '1y', tenorYears: 1, rate }, { label: '5y', tenorYears: 5, rate: rate + 1 },
] })
async function click(name: string) { await act(async () => { button(name).click() }) }
async function input(selector: string, value: string) {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function sourceResponse(value: CurvePreview | null) {
  const pending = sources.filter(item => !item.signal.aborted).at(-1)!
  latestSource = value
  await act(async () => { pending.resolve(value); await pending.promise })
}
async function complete(index = calculations.length - 1, value?: CurveCalculation) {
  const pending = calculations[index]
  await act(async () => { pending.resolve(value ?? calculateStressCurves(pending.source, pending.request.parameters)); await pending.promise })
}
async function runTests() {
  await act(async () => {
    root.render(<StrictMode><QueryClientProvider client={client}><CurvesApiContext.Provider value={service}><App /></CurvesApiContext.Provider></QueryClientProvider></StrictMode>)
  })
  await sourceResponse(null)
  check(hasText('Нет исходных данных') && calculations.length === 0, 'Без данных нет автоматического расчёта')
  await click('Проверить наличие данных')
  check(button('Проверяем данные…').disabled, 'Повторная проверка данных заблокирована до ответа')
  await sourceResponse(null)
  check(hasText('Нет исходных данных'), 'Повторное отсутствие данных оставляет пустое состояние')
  await click('Проверить наличие данных')
  await sourceResponse(source())
  check(calculations.length === 1 && !exportAvailable(), 'Появление данных автоматически запускает расчёт без доступного CSV')
  await complete()
  check(exportAvailable(), 'Полный результат доступен для выгрузки')
  await click('Проверить наличие данных')
  await sourceResponse(structuredClone(source()))
  check(calculations.length === 1 && exportAvailable(), 'Идентичные данные в новом объекте не запускают перерасчёт')
  await click('Проверить наличие данных')
  await sourceResponse(source('2026-07-31', 14))
  check(calculations.length === 2 && !exportAvailable(), 'Обновлённая кривая скрывает старый результат и запускает новый расчёт')
  await click('Проверить наличие данных')
  await sourceResponse(source('2026-07-31', 15))
  check(calculations[1].signal.aborted && calculations.length === 3, 'Следующее обновление отменяет ожидание предыдущей версии')
  await complete(1)
  check(!exportAvailable(), 'Поздний результат старой версии не показывается как готовый')
  await complete(2)
  check(exportAvailable(), 'Готов результат по последней версии кривой')
  await click('Редактировать параметры')
  const dialogGeometry = () => [...document.querySelectorAll('.modal-content, .parameter-input, .modal-footer')].map(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
  const geometryBeforeError = JSON.stringify(dialogGeometry())
  await input('[name="p"]', '50.001')
  await click('Применить')
  check(!!document.querySelector('[name="p"][aria-invalid="true"]') && !!document.querySelector('.parameter-error') && calculations.length === 3, 'Параметр больше 50 не применяется и показывает ошибку у поля')
  check(JSON.stringify(dialogGeometry()) === geometryBeforeError, 'Ошибка параметра не сдвигает окно, поля и кнопки')
  await input('[name="k"]', '50')
  await input('[name="d"]', '50')
  await input('[name="p"]', '.001')
  await click('Применить')
  check(calculations.length === 3 && hasText('P = 0,001') && hasText('Параметры изменены'), 'Малый параметр виден точно; сохранение не запускает расчёт')
  await click('Пересчитать кривые')
  check(calculations[3].request.parameters.p === .001, 'Ручной расчёт получает точное дробное значение')
  await complete()
  check(hasText('P = 0,001 п. п.'), 'Подпись результата сохраняет дробный параметр')
  const exportPosition = () => {
    const box = button('Скачать CSV').getBoundingClientRect()
    return JSON.stringify({ x: box.x, y: box.y, width: box.width, height: box.height })
  }
  const tableExportPosition = exportPosition()
  await click('График')
  check(exportPosition() === tableExportPosition, 'Кнопка CSV остаётся на месте при переключении вида')
  const selected = () => fixture.querySelectorAll('.scenario-option[aria-pressed="true"]').length
  const lines = () => fixture.querySelectorAll('polyline[data-scenario]').length
  const ticks = () => [...fixture.querySelectorAll('.curve-chart svg > g text')].map(node => node.textContent).join(',')
  const originalTicks = ticks()
  check(button('Свернуть выбор кривых').getAttribute('aria-expanded') === 'true', 'Выбор кривых изначально развёрнут')
  await click('Свернуть выбор кривых')
  check(!!fixture.querySelector('.curve-legend[hidden]') && lines() === 1, 'Шеврон скрывает выбор без отключения линий')
  await click('Таблица')
  check(!fixture.querySelector('.curve-legend') && !fixture.querySelector('.curve-legend-toggle') && fixture.querySelector('.results-panel')!.getBoundingClientRect().height === 509, 'В таблице нет выбора кривых и шеврона, высота блока сохраняется')
  await click('График')
  check(button('Развернуть выбор кривых').getAttribute('aria-expanded') === 'false', 'При возврате к графику состояние сворачивания сохранено')
  await click('Развернуть выбор кривых')
  check(selected() === 1 && lines() === 1 && fixture.querySelector('.scenario-option--base')?.getAttribute('aria-pressed') === 'true', 'Изначально выбрана только базовая кривая из нового макета')
  check(!fixture.querySelector('.curve-legend input'), 'В выборе кривых нет чекбоксов')
  await click('Параллельный вверх')
  check(selected() === 2 && lines() === 2 && ticks() === originalTicks, 'Несколько кривых включаются без изменения масштаба')
  await click('Таблица')
  check(fixture.querySelectorAll('thead th').length === 9, 'Полная таблица содержит все семь кривых, как в макете')
  await click('График')
  check(selected() === 2 && calculations.length === 4, 'Переключение вкладок сохраняет выбор без нового расчёта')
  await click('Базовая кривая')
  check(!fixture.querySelector('[data-scenario="base"]') && lines() === 1, 'Базовую кривую можно выключить')
  await click('Параллельный вверх')
  check(selected() === 0 && lines() === 0 && hasText('Выберите кривую для отображения'), 'Все кривые выключаются с понятным пустым состоянием')
  await click('Краткосрочные вверх')
  check(lines() === 1 && ticks() === originalTicks, 'После пустого состояния выбор восстанавливает тот же масштаб')
  check(!fixture.querySelector('[data-scenario="short-up"]')!.hasAttribute('stroke-dasharray'), 'Краткосрочные вверх отображаются сплошной линией')
  const createUrl = URL.createObjectURL
  const anchorClick = HTMLAnchorElement.prototype.click
  let downloaded: Blob | null = null
  try {
    URL.createObjectURL = blob => { downloaded = blob as Blob; return createUrl(blob) }
    HTMLAnchorElement.prototype.click = function () { /* Test: capture CSV without starting a download. */ }
    await click('Скачать CSV')
    const blob = downloaded as Blob | null
    const csv = await blob?.text()
    const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : []
    check(!!csv && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF && csv.trimEnd().split('\r\n').length === 15 && csv.includes('"0,001"'),
      'CSV содержит семь кривых, точный P и BOM независимо от фильтра линий')
  } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = anchorClick }
  await click('Таблица')
  check(fixture.querySelectorAll('tbody tr').length === 2, 'Таблица показывает сроки текущего результата')
  check(fixture.querySelector('.results-panel')?.getBoundingClientRect().height === 509, 'Высота результатов фиксирована: 509 px')
  await click('Редактировать параметры')
  await input('[name="p"]', '9')
  await click('Отмена')
  check(hasText('P = 0,001') && document.activeElement?.getAttribute('aria-label') === 'Редактировать параметры', 'Отмена не меняет параметры и возвращает фокус')
  await click('Редактировать параметры')
  await input('[name="p"]', '8')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  check(!document.querySelector('[role="dialog"]') && hasText('P = 0,001'), 'Escape не сохраняет черновик параметров')
  await click('Пересчитать кривые')
  const pending = calculations.at(-1)!
  await complete(calculations.length - 1, calculateStressCurves(source('2026-07-31', 99), pending.request.parameters))
  check(hasText('Базовая кривая результата не соответствует') && !!fixture.querySelector('.results-panel--error[role="alert"]') && !exportAvailable(), 'Полный результат с чужой базовой кривой отклоняется')
  await click('Повторить расчёт')
  await complete()
  check(exportAvailable(), 'После несовпадения базы доступен успешный повтор')
  await input('#report-date', '2026-08-01')
  await sourceResponse(source('2026-08-01'))
  const oldIndex = calculations.length - 1
  await input('#report-date', '2026-08-02')
  await complete(oldIndex)
  check(!exportAvailable(), 'Поздний ответ другой даты не возвращает прежний результат')
  await sourceResponse(source('2026-08-02'))
  check(calculations.at(-1)!.request.parameters.p === 4, 'Новая дата возвращает стандартные параметры')
  await complete()
  await input('#report-date', '')
  check(hasText('Выберите отчётную дату') && !exportAvailable(), 'Очистка даты убирает результаты и доступ к CSV')
  await input('#report-date', '2026-08-03')
  const failedSource = sources.filter(item => !item.signal.aborted).at(-1)!
  await act(async () => { failedSource.reject(new Error('Test source failure')); await failedSource.promise.catch(() => {}) })
  check(hasText('Не удалось получить данные'), 'Ошибка получения отличается от отсутствия данных')
  await click('Повторить получение данных')
  await sourceResponse(source('2026-08-03'))
  await complete()
  check(exportAvailable(), 'Повтор получения после ошибки восстанавливает полный сценарий')
  await act(async () => { root.unmount() })
  client.clear()
  output.textContent = messages.join('\n') + '\n\nВсе проверки приложения пройдены.'
}
void runTests().catch(error => {
  output.textContent = [...messages, `\nОШИБКА: ${error instanceof Error ? error.message : String(error)}`].join('\n')
  throw error
})
