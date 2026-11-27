import { strToU8, zipSync } from 'fflate'
import type { CurveCalculation } from './curveTypes'
import { STRESS_SCENARIOS } from './calculateStressCurves'
import { isCompleteCalculation } from './validateCurves'

type Cell = string | number
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const xml = (value: string) => Array.from(value).filter(char => char >= ' ' || '\t\n\r'.includes(char)).join('')
  .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)

function worksheet(rows: Cell[][], formats: number[], widths: number[], filter = true): string {
  const sheetData = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const position = `${String.fromCharCode(65 + c)}${r + 1}`
    const style = r === 0 ? 1 : typeof value === 'number' ? formats[c] ?? 0 : 0
    return typeof value === 'number'
      ? `<c r="${position}" s="${style}"><v>${value}</v></c>`
      : `<c r="${position}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
  }).join('')}</row>`).join('')
  const range = `A1:${String.fromCharCode(64 + rows[0].length)}${rows.length}`
  return `${declaration}<worksheet xmlns="${ns}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetData}</sheetData>${filter ? `<autoFilter ref="${range}"/>` : ''}</worksheet>`
}

/** Native OOXML workbook. Numbers retain their precision and are never stored as formulas. */
export function buildCurveXlsx(result: CurveCalculation): Uint8Array<ArrayBuffer> {
  if (!isCompleteCalculation(result)) throw new Error('Для выгрузки нужен полный завершённый расчёт.')
  const curves = [
    { name: 'Базовая кривая', points: result.baseCurve },
    ...STRESS_SCENARIOS.map(({ code, name }) => ({ name, points: result.stressCurves.find(curve => curve.code === code)!.points })),
  ]
  const header = ['Бакет', 'Расчётный тенор, лет', ...curves.map(curve => curve.name)]
  const grid = (field: 'rate' | 'discountFactor'): Cell[][] => [header, ...result.baseCurve.map((point, i) =>
    [point.label, point.tenorYears, ...curves.map(curve => curve.points[i][field])])]
  const sheets = [
    { name: 'Ставки, % годовых', data: worksheet(grid('rate'), [0, 3, ...curves.map(() => 2)], [12, 23, ...curves.map(() => 27)]) },
    { name: 'Дисконт-факторы', data: worksheet(grid('discountFactor'), [0, 3, ...curves.map(() => 4)], [12, 23, ...curves.map(() => 27)]) },
    { name: 'Параметры', data: worksheet([
      ['Параметр', 'Значение'], ['Отчётная дата', result.reportDate],
      ['P, п. п.', result.parameters.p], ['K, п. п.', result.parameters.k], ['D, п. п.', result.parameters.d],
      ['Происхождение данных', result.dataProvenance === 'market' ? 'Рыночные' : result.dataProvenance === 'synthetic' ? 'Синтетические' : 'Не указано'],
      ['Способ запуска', result.runOrigin === 'automatic' ? 'Автоматический' : result.runOrigin === 'manual' ? 'Ручной' : 'Не указан'],
      ['Единицы ставок', 'Проценты годовых'], ['Единицы дисконт-факторов', 'Безразмерные'],
    ], [0, 3], [30, 38], false) },
  ]
  const files: Record<string, Uint8Array> = {}
  const add = (name: string, value: string) => { files[name] = strToU8(declaration + value) }
  add('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  add('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  add('xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="${relationships}"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${relationships}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId4" Type="${relationships}/styles" Target="styles.xml"/></Relationships>`)
  add('xl/styles.xml', `<styleSheet xmlns="${ns}"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.0000"/><numFmt numFmtId="165" formatCode="0.0000000000"/></numFmts><fonts count="2"><font><sz val="11"/><color rgb="FF2B2D30"/><name val="Geologica"/></font><font><b/><sz val="11"/><color rgb="FF2B2D30"/><name val="Geologica"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDFF4FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheet.data) })
  return new Uint8Array(zipSync(files, { level: 6 }))
}

export function downloadCurveXlsx(result: CurveCalculation): void {
  const url = URL.createObjectURL(new Blob([buildCurveXlsx(result)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `curves_${result.reportDate}.xlsx`
  document.body.append(link)
  try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
