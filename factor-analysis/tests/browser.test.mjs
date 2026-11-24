import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { chromium } = createRequire(import.meta.url)(process.env.SPECTRUM_PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.SPECTRUM_TEST_PYTHON || '../.venv/bin/python';
const screenshotDirectory = process.env.SPECTRUM_SCREENSHOTS;

async function waitForServer(server) {
  return await new Promise((resolve, reject) => {
    let stderr = '', stdout = '';
    const timeout = setTimeout(() => reject(new Error('Spectrum failed to start: ' + stderr)), 20_000);
    server.stdout.on('data', (data) => {
      stdout += data;
      const address = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) {
        clearTimeout(timeout);
        resolve(address);
      }
    });
    server.stderr.on('data', (data) => { stderr += data; });
    server.once('error', (error) => { clearTimeout(timeout); reject(error); });
    server.once('exit', (status) => { clearTimeout(timeout); reject(new Error(`Spectrum exited ${status}: ${stderr}`)); });
  });
}

async function record(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(screenshotDirectory, name + '.png'), fullPage: true, animations: 'disabled' });
}

async function noOverflow(page, viewports) {
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    const span = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(span[0] <= span[1] + 1, `layout overflow at ${width}: ${span}`);
  }
}

const cases = [[1920, 1080], [1440, 900], [1280, 720], [768, 900], [390, 844]];

test('calculation, CSV analysis, exports, assistive fallback and responsive navigation', { timeout: 120_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'spectrum-browser-'));
  const server = spawn(python, ['-m', 'service.server', '--port', '0'], {
    env: { ...process.env, SPECTRUM_DATA_DIR: data, SPECTRUM_LLM_ENABLED: '0', SPECTRUM_CURVES_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    const origin = await waitForServer(server);
    browser = await chromium.launch({ headless: true, executablePath: process.env.SPECTRUM_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.setDefaultTimeout(9_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Подготовьте историю портфеля' }).waitFor();
    await page.getByRole('link', { name: 'Открыть генератор' }).click();
    await page.getByLabel('Источник кривых').selectOption('fixture');
    await page.getByLabel('Сделок на старте', { exact: true }).fill('80');
    await page.getByLabel('Число отчётных дат').fill('8');
    await page.getByLabel('Новых сделок в месяц').fill('8');
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '03-portfolio');
    await page.getByRole('button', { name: 'Рассчитать портфель' }).click();
    await page.getByText('Сверено с калькулятором', { exact: true }).waitFor({ timeout: 40_000 });
    await noOverflow(page, cases);
    await record(page, '05-mobile');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: /^Денежные потоки/ }).click();
    await page.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await record(page, '01-valuation');
    await page.getByRole('button', { name: 'Детали расчёта' }).click();
    await page.getByRole('heading', { name: 'Сверка и четыре пересчёта' }).waitFor();
    await page.getByText('Экспорт', { exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Вклады CSV' }).click();
    assert.equal((await downloaded).suggestedFilename(), 'factors.csv');
    await page.getByRole('link', { name: 'Сценарии ставок' }).click();
    await page.getByLabel('Стресс для сравнения').selectOption('steepener');
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '02-scenarios');
    await page.getByRole('button', { name: 'Объяснить изменение сценария' }).click();
    assert.equal(await page.locator('#metric').inputValue(), 'stress_delta');
    assert.equal(await page.locator('#analysis-scenario').inputValue(), 'steepener');
    await page.getByRole('button', { name: 'Разложить изменение' }).click();
    await page.getByText('ΔPV · Увеличение наклона', { exact: false }).first().waitFor();
    await page.getByLabel('Режим', { exact: true }).selectOption('ml');
    await page.getByLabel('Показатель').selectOption('npv');
    await page.getByRole('button', { name: 'Разложить изменение' }).click();
    await page.getByRole('button', { name: 'Проверка модели' }).waitFor();
    await page.getByRole('button', { name: 'Проверка модели' }).click();
    await page.getByRole('heading', { name: 'Проверка модели разложения' }).waitFor();
    await page.getByRole('link', { name: 'Портфель', exact: true }).click();
    await page.getByRole('table', { name: 'Найденные сделки' }).getByRole('button').first().click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: 'Данные', exact: true }).click();
    await record(page, '04-data');
    const example = await (await page.request.get(origin + '/api/example.csv')).text();
    const untrusted = '<b data-column-name="test">Длинное пользовательское название укладывается на мобильном экране</b>';
    const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
    const renamed = example.replace('размер', quote(untrusted));
    await page.locator('#import-form input').setInputFiles({ name: 'данные.csv', mimeType: 'text/csv', buffer: Buffer.from(renamed) });
    await page.getByRole('button', { name: 'Загрузить CSV' }).click();
    await page.getByText('CSV загружен.', { exact: false }).waitFor();
    await page.getByLabel('ID', { exact: true }).selectOption('наблюдение');
    await page.getByLabel('Целевая метрика').selectOption('стоимость');
    await page.getByLabel('Единица измерения').fill('ед.');
    await page.getByRole('button', { name: 'Проверить колонки' }).click();
    await page.getByText('Колонки проверены.', { exact: false }).waitFor();
    await page.locator('.feature-list').getByText(untrusted, { exact: false }).first().waitFor();
    assert.equal(await page.locator('b[data-column-name="test"]').count(), 0);
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Рассчитать ML-вклады' }).click();
    await page.getByRole('button', { name: 'Нелинейные эффекты' }).waitFor();
    await page.getByRole('button', { name: 'Нелинейные эффекты' }).click();
    await page.getByRole('button', { name: 'Рассчитать детализацию' }).click();
    await page.getByRole('heading', { name: 'Как меняется эффект' }).waitFor();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '06-nonlinearity');
    await page.getByRole('button', { name: 'Взаимодействия' }).click();
    await page.getByRole('heading', { name: 'Взаимодействия факторов' }).waitFor();
    await page.getByLabel('Пара факторов').selectOption({ index: 1 });
    await record(page, '07-interactions');
    await page.getByRole('button', { name: 'Объяснение', exact: true }).click();
    await page.getByRole('button', { name: 'Какие факторы главные?' }).click();
    await page.getByText('Показаны проверенные факты расчёта.', { exact: true }).waitFor();
    const current = await (await page.request.get(origin + '/api/workspace')).json();
    const report = await (await page.request.get(origin + `/api/export/${current.id}/reports/${current.report.analysisId}/analysis.json`)).json();
    assert.equal(report.unit, 'ед.');
    assert.equal(report.aiSummary.analysisId, report.analysisId);
    await page.route('**/api/explain', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await route.fulfill({ json: { analysisId: report.analysisId, facts: [{ text: 'Устаревший ответ' }], mode: 'facts' } }).catch(() => {});
    });
    await page.getByRole('button', { name: 'Какие факторы главные?' }).click();
    await page.getByText('Подбираем факты по текущему расчёту…', { exact: true }).waitFor();
    await page.locator('#from').selectOption('2026-05-25');
    await page.getByRole('button', { name: 'Разложить изменение' }).click();
    await page.getByText('25.05.2026 — 25.08.2026', { exact: true }).waitFor();
    assert.equal(await page.getByText('Показаны проверенные факты расчёта.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Устаревший ответ', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'close');
    }
    await rm(data, { recursive: true, force: true });
  }
});
