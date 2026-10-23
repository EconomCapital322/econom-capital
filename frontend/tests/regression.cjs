const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

// Transpile the production utilities in this test process without generating
// files in src or introducing a browser/test framework dependency.
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  })
  module._compile(outputText, filename)
}
const { calculateStressCurves } = require('../src/utils/calculateStressCurves.ts')
const { isCompleteCalculation, isCurvePreview, isReportDate } = require('../src/utils/validateCurves.ts')
const { buildCurveCsv, canExportCurveCalculation } = require('../src/utils/curveCsv.ts')
const { runDemoCalculation } = require('../src/api/demoCalculation.ts')
const source = () => ({ reportDate: '2026-07-31', source: 'MOEX', sourceTime: '18:49:59',
  points: [{ label: '1y', tenorYears: 1, rate: 12 }, { label: '5y', tenorYears: 5, rate: 10 }] })
const parameters = () => ({ p: 4, k: 5, d: 3 })
const result = () => calculateStressCurves(source(), parameters())

test('report date rejects empty/impossible dates and accepts leap day', () => {
  for (const date of ['', '2026-02-30', '2026-02-29', '2026-13-01', null]) assert.equal(isReportDate(date), false)
  assert.equal(isReportDate('2024-02-29'), true)
})
test('all six shocks use percent/percentage-point units and independent reference values', () => {
  const calculated = result()
  const s = Math.exp(-1 / 4)
  const expected = [16, 8, 12 - .65 * 5 * s + .9 * 3 * (1 - s),
    12 + .8 * 5 * s - .6 * 3 * (1 - s), 12 + 5 * s, 12 - 5 * s]
  assert.equal(calculated.stressCurves.length, 6)
  calculated.stressCurves.forEach((curve, i) => assert.ok(Math.abs(curve.points[0].rate - expected[i]) < 1e-12))
})
test('fractional positive parameters are accepted; invalid parameters are rejected', () => {
  assert.equal(isCompleteCalculation(calculateStressCurves(source(), { p: .5, k: 1.25, d: .125 })), true)
  for (const value of [0, -1, NaN, Infinity, 50.001, 51]) assert.throws(() => calculateStressCurves(source(), { ...parameters(), p: value }))
})
test('parameter limit includes 50 and applies to every shock and API response', () => {
  assert.equal(isCompleteCalculation(calculateStressCurves(source(), { p: 50, k: 50, d: 50 })), true)
  for (const key of ['p', 'k', 'd']) {
    assert.throws(() => calculateStressCurves(source(), { ...parameters(), [key]: 50.001 }))
    const invalid = result()
    invalid.parameters[key] = 50.001
    assert.equal(isCompleteCalculation(invalid), false)
  }
})
test('a calculated result owns copies of rates and parameters', () => {
  const input = source(), params = parameters(), calculated = calculateStressCurves(input, params)
  params.p = 25
  input.points[0].rate = 99
  assert.equal(calculated.parameters.p, 4)
  assert.equal(calculated.baseCurve[0].rate, 12)
  assert.equal(calculated.stressCurves[0].points[0].rate, 16)
})
test('source validation rejects duplicate, unsorted and nonfinite points', () => {
  for (const points of [[], [source().points[0], source().points[0]], [...source().points].reverse(),
    [{ label: '1y', tenorYears: 1, rate: NaN }], [{ label: '', tenorYears: 1, rate: 10 }]]) {
    assert.equal(isCurvePreview({ ...source(), points }), false)
  }
  assert.equal(isCurvePreview(source()), true)
})
test('incomplete or malformed responses cannot be rendered/exported as complete results', () => {
  const complete = result()
  const bad = [undefined, null, {}, { ...complete, parameters: null }, { ...complete, baseCurve: null },
    { ...complete, stressCurves: complete.stressCurves.slice(1) },
    { ...complete, stressCurves: [...complete.stressCurves.slice(1), complete.stressCurves[1]] },
    { ...complete, stressCurves: [null, ...complete.stressCurves.slice(1)] },
    { ...complete, stressCurves: [{ ...complete.stressCurves[0], points: [] }, ...complete.stressCurves.slice(1)] },
    { ...complete, stressCurves: [{ ...complete.stressCurves[0], points: [...complete.baseCurve].reverse() }, ...complete.stressCurves.slice(1)] }]
  assert.equal(isCompleteCalculation(complete), true)
  for (const value of bad) {
    assert.equal(canExportCurveCalculation(value), false)
    assert.throws(() => buildCurveCsv(value))
  }
})
test('CSV exports seven curves with captured parameters, BOM and quote escaping', () => {
  const calculated = result()
  const csv = buildCurveCsv(calculated)
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  assert.equal(csv.trimEnd().split('\r\n').length, 15)
  assert.ok(csv.includes('"4";"5";"3"'))
  const quoted = source()
  quoted.points[0].label = '1"y'
  assert.ok(buildCurveCsv(calculateStressCurves(quoted, parameters())).includes('"1""y"'))
})
test('cancellation rejects delayed calculations instead of returning stale data', async () => {
  const controller = new AbortController()
  const pending = runDemoCalculation(source(), parameters(), { signal: controller.signal, delayMs: 20 })
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
})
test('a calculation can succeed after a failed attempt', async () => {
  await assert.rejects(runDemoCalculation(source(), parameters(), { signal: new AbortController().signal, fail: true, delayMs: 0 }))
  const calculated = await runDemoCalculation(source(), parameters(), { signal: new AbortController().signal, delayMs: 0 })
  assert.equal(isCompleteCalculation(calculated), true)
})

const { formatParameter } = require('../src/utils/parameters.ts')
const { curveSourceKey, matchesCurveSource } = require('../src/utils/curveSource.ts')
test('small fractional parameters are displayed without rounding them to zero', () => {
  assert.equal(formatParameter(.001), '0,001')
  assert.equal(formatParameter(1.23456), '1,23456')
  assert.notEqual(formatParameter(.001), formatParameter(.002))
  assert.equal(formatParameter(Number.MIN_VALUE), '5e-324')
})
test('numerical source identity ignores object identity and publication metadata', () => {
  const a = source(), b = structuredClone(a)
  b.sourceTime = '19:00:00'
  assert.equal(curveSourceKey(a), curveSourceKey(b))
  b.points[0].rate += .01
  assert.notEqual(curveSourceKey(a), curveSourceKey(b))
})
test('a structurally complete result from a different base is rejected', () => {
  const original = source(), other = source()
  other.points[0].rate += 1
  const wrong = calculateStressCurves(other, parameters())
  assert.equal(isCompleteCalculation(wrong), true)
  assert.equal(matchesCurveSource(wrong, original), false)
  assert.equal(matchesCurveSource(result(), original), true)
})
