import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const engines = createRequire(import.meta.url)(process.env.SPECTRUM_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.SPECTRUM_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'Use chromium or webkit for browser checks.');
const browserType = engines[engine];
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

async function record(page, name, selector, fullPage = true) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const screenshot = { path: join(screenshotDirectory, name + '.png'), animations: 'disabled' };
  if (selector) await page.locator(selector).screenshot(screenshot);
  else {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ ...screenshot, fullPage });
  }
}

async function noOverflow(page, viewports) {
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    const span = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(span[0] <= span[1] + 1, `layout overflow at ${width}: ${span}`);
    if (width <= 810) {
      const [brand, navigation] = await Promise.all([
        page.locator('.brand').boundingBox(),
        page.getByRole('navigation', { name: 'Разделы' }).boundingBox(),
      ]);
      assert.ok(brand && navigation, `missing mobile navigation at ${width}`);
      assert.ok(brand.x + brand.width <= navigation.x || brand.y + brand.height <= navigation.y,
        `overlapping navigation at ${width}`);
    }
  }
}

const cases = [[1920, 1080], [1440, 900], [1280, 720], [768, 900], [390, 844]];

async function waitForJob(page, origin, id) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(origin + '/api/job/' + id);
    assert.equal(response.status(), 200, await response.text());
    const job = await response.json();
    if (job.state !== 'running') return job;
    await delay(150);
  }
  throw new Error('Расчёт ' + id + ' остался в состоянии running');
}

test('portfolio, valuation, stress, CSV and ZIP analysis, exports, and responsive navigation', { timeout: 150_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'spectrum-browser-'));
  const server = spawn(python, ['-m', 'service.server', '--port', '0'], {
    env: { ...process.env, SPECTRUM_DATA_DIR: data, SPECTRUM_LLM_ENABLED: '0', DEEPSEEK_API_KEY: '', SPECTRUM_CURVES_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    const origin = await waitForServer(server);
    browser = await browserType.launch({ headless: true, executablePath: process.env.SPECTRUM_CHROME || undefined });
    const brandPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await brandPage.route('**/spectrum.svg', (route) => route.fulfill({ status: 404 }));
    await brandPage.goto(origin);
    const renderedMark = await brandPage.locator('.brand').evaluate((brand) => {
      const svg = brand.querySelector('svg');
      return svg ? svg.getBBox().width > 0 : brand.querySelector('img')?.naturalWidth > 0;
    });
    assert.ok(renderedMark, 'The sidebar logo is visible when the standalone SVG is unavailable.');
    await brandPage.evaluate(() => document.fonts.ready);
    const mobileAction = brandPage.getByRole('link', { name: 'Портфель', exact: true });
    await mobileAction.evaluate((control) => { control.style.fontSize = '16px'; });
    await noOverflow(brandPage, [[390, 844], [320, 720]]);
    await mobileAction.click();
    await brandPage.getByRole('heading', { name: 'Размер и период', exact: true }).waitFor();
    await brandPage.close();

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.setDefaultTimeout(9_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Подготовьте историю портфеля' }).waitFor();
    await page.getByRole('link', { name: 'Создать тестовый портфель' }).click();
    await page.getByRole('link', { name: 'Загрузить снимки ZIP' }).click();
    await page.getByLabel('Архив снимков').waitFor({ state: 'attached' });
    assert.equal(await page.getByRole('button', { name: 'Загрузить ZIP' }).isDisabled(), true);
    await page.getByRole('link', { name: 'Портфель', exact: true }).click();
    await page.getByLabel('Источник кривых').selectOption('fixture');
    await page.getByLabel('Сделок на старте', { exact: true }).fill('80');
    await page.getByLabel('Число отчётных дат').fill('8');
    await page.getByLabel('Новых сделок в месяц').fill('8');
    assert.equal(await page.locator('.portfolio-plan strong').textContent(), '136');
    await page.getByText('Распределения', { exact: true }).click();
    await page.getByText('Дополнительные параметры сделок', { exact: true }).click();
    await page.getByLabel('Доля обязательств, %').fill('25');
    await page.locator('#portfolio-preview').getByText('25%', { exact: true }).waitFor();
    await page.getByLabel('Доля обязательств, %').fill('0');
    await page.getByText('Дополнительные параметры сделок', { exact: true }).click();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '03-portfolio');
    await page.getByRole('button', { name: 'Создать тестовый портфель' }).click();
    await page.getByRole('heading', { name: 'Расчёт завершён', exact: true }).waitFor({ timeout: 40_000 });
    await page.getByRole('heading', { name: 'Состав портфеля', exact: true }).waitFor();
    await record(page, '03-portfolio-holdings');
    await page.getByRole('link', { name: 'Открыть факторный анализ' }).click();
    await page.getByRole('heading', { name: 'NPV базы', exact: true }).waitFor();
    await page.getByText('Сверено с калькулятором', { exact: true }).waitFor({ timeout: 40_000 });
    await page.getByRole('group', { name: 'Вклады факторов относительно нуля' }).waitFor();
    await noOverflow(page, cases);
    const edit = page.getByRole('button', { name: 'Изменить параметры', exact: true });
    const settings = page.locator('#settings-dialog');
    const openResearch = page.getByRole('button', { name: 'Подробный анализ', exact: true });
    const openAI = page.getByRole('button', { name: 'Спросить AI', exact: true });
    const assistant = page.locator('#assistant-drawer');
    const applied = page.locator('.report-scope');
    assert.equal(await settings.isVisible(), false);
    assert.equal(await assistant.isVisible(), false);
    assert.equal(await page.locator('#analysis-tabs').count(), 0);
    assert.ok(await page.locator('#bridge-chart').evaluate((chart) => chart.getBoundingClientRect().top < innerHeight));
    const actualPeriod = await applied.textContent();
    await edit.click();
    await settings.getByRole('button', { name: 'Расчётный анализ', exact: true }).waitFor();
    await settings.locator('#from').selectOption({ index: 0 });
    await page.keyboard.press('Escape');
    assert.equal(await settings.isVisible(), false);
    assert.equal(await applied.textContent(), actualPeriod);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '01-valuation');
    const cash = page.locator('#bridge-chart [data-key="factor:cash_effect"]');
    await cash.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('#factor-drawer');
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await drawer.getByText('Метод и источник', { exact: true }).click();
    await drawer.getByRole('button', { name: 'Детализация потоков и источник' }).waitFor();
    await record(page, '01-factor-drawer', undefined, false);
    await page.keyboard.press('Escape');
    assert.equal(await cash.evaluate((element) => element === document.activeElement), true);
    await cash.click();
    const factorAnswer = page.waitForRequest((request) => request.url().endsWith('/api/explain'));
    await drawer.getByRole('button', { name: 'Объяснить с помощью AI' }).click();
    assert.equal((await factorAnswer).postDataJSON().focusFactor, 'factor:cash_effect');
    await page.locator('#answer').getByText('Показаны проверенные факты расчёта.', { exact: true }).waitFor();
    await page.locator('#answer').getByRole('button', { name: 'Открыть источник' }).first().click();
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Водопад', exact: true }).click();
    await page.getByRole('group', { name: /^Водопад изменения показателя/ }).waitFor();
    await record(page, '01-waterfall', '#waterfall');
    await page.getByRole('button', { name: 'К вкладам', exact: true }).click();
    await openResearch.click();
    await page.getByRole('img', { name: 'История выбранного показателя' }).waitFor();
    await page.getByRole('button', { name: 'Вклады', exact: true }).click();
    const ledger = page.getByRole('table', { name: 'Полное разложение' });
    await ledger.waitFor();
    await ledger.getByRole('button', { name: 'Денежные потоки', exact: true }).click();
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('group', { name: 'Разделы аналитики' }).getByRole('button', { name: 'Денежные потоки', exact: true }).click();
    await page.getByRole('button', { name: 'Разложить денежные потоки' }).click();
    await page.getByRole('group', { name: 'Вклады в изменение денежных потоков' }).waitFor();
    await page.getByText('Все вклады и их суммы', { exact: true }).click();
    await page.getByRole('table', { name: 'Вклады в изменение денежных потоков' }).waitFor();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '08-cash-details', '#cash-details');
    const downloadedCash = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Детализация CSV' }).click();
    assert.equal((await downloadedCash).suggestedFilename(), 'cash-details.csv');
    const method = page.locator('#analysis-methodology');
    assert.equal(await method.getByRole('heading', { name: 'Сверка и четыре пересчёта' }).isVisible(), false);
    await method.getByText('Методология и выгрузки', { exact: true }).click();
    await method.getByRole('heading', { name: 'Сверка и четыре пересчёта' }).waitFor();
    assert.match(await method.locator('.formula').textContent(), /C_CF/);
    await method.getByText('Вклады по срокам и видам платежей', { exact: true }).click();
    await method.getByRole('table', { name: 'Эффекты по срокам' }).waitFor();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Вклады CSV' }).click();
    assert.equal((await downloaded).suggestedFilename(), 'factors.csv');
    const downloadedHtml = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Отчёт HTML' }).click();
    assert.equal((await downloadedHtml).suggestedFilename(), 'analysis.html');
    await method.getByRole('link', { name: 'Источники расчёта', exact: true }).click();
    await page.locator('#data-sources').getByRole('table', { name: 'Источники расчёта' }).waitFor();
    await page.getByRole('link', { name: 'Сценарии', exact: true }).click();
    const curve = page.getByRole('img', { name: 'Базовая и выбранная стрессовая кривые' });
    await curve.waitFor();
    assert.equal(await page.getByRole('group', { name: 'Выбор сценария' }).getByRole('button').count(), 6);
    const initialCurve = await curve.locator('polyline').last().getAttribute('points');
    const bucketDetail = page.locator('details[data-scenario-detail="buckets"]');
    const buckets = bucketDetail.getByRole('group', { name: 'Вклад сроков платежей', exact: true });
    assert.equal(await buckets.isVisible(), false);
    await bucketDetail.locator('summary').click();
    const initialBuckets = await buckets.textContent();
    const steepener = page.getByRole('button', { name: /^Увеличение наклона кривой/ });
    await steepener.click();
    assert.equal(await steepener.getAttribute('aria-pressed'), 'true');
    assert.notEqual(await curve.locator('polyline').last().getAttribute('points'), initialCurve);
    assert.notEqual(await buckets.textContent(), initialBuckets);
    await bucketDetail.locator('summary').click();
    const scenarioFiles = page.locator('details[data-scenario-detail="results"]');
    await scenarioFiles.locator('summary').click();
    await scenarioFiles.getByRole('table', { name: 'PV всех сделок по сценариям' }).waitFor();
    await scenarioFiles.getByRole('link', { name: 'Снимок кривых' }).waitFor();
    await scenarioFiles.locator('summary').click();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '02-scenarios');
    await page.getByRole('button', { name: 'Разобрать изменение сценария' }).click();
    await settings.waitFor();
    assert.equal(await page.locator('#metric').inputValue(), 'stress_delta');
    assert.equal(await page.locator('#analysis-scenario').inputValue(), 'steepener');
    await page.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await page.getByRole('heading', { name: 'ΔPV · Увеличение наклона кривой' }).waitFor();
    await edit.click();
    await settings.getByRole('button', { name: 'Анализ зависимостей (ML)', exact: true }).click();
    await settings.getByLabel('Показатель').selectOption('npv');
    assert.match(await applied.textContent(), /Расчётный анализ/);
    await settings.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await applied.getByText('Анализ зависимостей (ML)', { exact: true }).waitFor();
    await openResearch.click();
    await page.getByRole('button', { name: 'Качество', exact: true }).click();
    await page.getByRole('heading', { name: 'Проверка качества модели' }).waitFor();
    await page.getByRole('table', { name: 'Ошибки модели разложения' }).getByRole('columnheader', { name: 'RMSE' }).waitFor();
    await page.getByText('Устойчивость и ограничения', { exact: true }).click();
    await page.getByText(/Численная невязка проверяет/).waitFor();
    await page.getByRole('link', { name: 'Портфель', exact: true }).click();
    await page.getByRole('searchbox', { name: 'ID сделки' }).fill('1');
    const results = page.waitForResponse((response) => response.url().includes('/api/deals/') && new URL(response.url()).searchParams.get('q') === '1');
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    assert.equal((await (await results).json()).rows[0].deal_id, '1');
    await page.getByRole('table', { name: 'Найденные сделки' }).getByRole('button', { name: '1', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: 'Данные', exact: true }).click();
    await record(page, '04-data');
    await page.locator('#data-sources > summary').click();
    await page.getByText('Идентификаторы расчётов и контрольные суммы', { exact: true }).click();
    await page.getByRole('table', { name: 'Идентификаторы исходных снимков' }).waitFor();
    await page.getByText('Подключения', { exact: true }).click();
    await page.locator('#services').getByText('Калькулятор', { exact: true }).waitFor();
    await page.getByText('Технический профиль колонок', { exact: true }).click();
    await page.getByRole('table', { name: 'Профиль колонок' }).waitFor();
    const downloadingHistory = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Скачать историю ZIP' }).click();
    const history = await (await downloadingHistory).path();
    await page.getByRole('button', { name: 'Таблица CSV', exact: true }).click();
    const example = await (await page.request.get(origin + '/api/example.csv')).text();
    const untrusted = '<b data-column-name="test">Длинное пользовательское название укладывается на мобильном экране</b>';
    const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
    const renamed = example.replace('размер', quote(untrusted));
    await page.locator('#import-form input').setInputFiles({ name: 'данные.csv', mimeType: 'text/csv', buffer: Buffer.from(renamed) });
    await page.getByText('данные.csv', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Загрузить CSV' }).click();
    await page.getByText('CSV загружен.', { exact: false }).waitFor();
    await page.getByLabel('ID', { exact: true }).selectOption('наблюдение');
    await page.getByLabel('Целевой показатель').selectOption('стоимость');
    await page.getByLabel('Единица измерения').fill('ед.');
    await page.getByRole('button', { name: 'Проверить структуру' }).click();
    await page.getByText('Колонки проверены.', { exact: false }).waitFor();
    await page.locator('.feature-list').getByText(untrusted, { exact: false }).first().waitFor();
    assert.equal(await page.locator('b[data-column-name="test"]').count(), 0);
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '04-data-csv');
    await page.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await openResearch.click();
    await page.getByRole('button', { name: 'Зависимости', exact: true }).click();
    await page.getByRole('button', { name: 'Рассчитать детализацию' }).click();
    await page.getByRole('heading', { name: 'Как меняется связь с показателем' }).waitFor();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '06-nonlinearity');
    await page.locator('#effect-select').selectOption(untrusted);
    const effectChart = page.getByRole('combobox', { name: 'Вид графика', exact: true });
    await effectChart.selectOption('shap');
    await page.getByRole('img', { name: 'Значение признака и вклад SHAP' }).waitFor();
    await effectChart.selectOption('ice');
    await page.getByRole('img', { name: 'Изменение предсказания для отдельных наблюдений' }).waitFor();
    await effectChart.selectOption('pdp');
    await page.getByRole('img', { name: 'Среднее предсказание по выбранному признаку' }).waitFor();
    await page.getByRole('columnheader', { name: 'Средний прогноз' }).waitFor();
    if (screenshotDirectory) {
      await page.locator('#effect-select').selectOption('темп');
      await record(page, '09-pdp', '#tab-body');
    }
    await page.getByRole('button', { name: 'Важность', exact: true }).click();
    await page.getByRole('group', { name: 'Глобальная важность по среднему модулю SHAP' }).waitFor();
    await page.getByRole('group', { name: 'Глобальная важность по росту MAE' }).waitFor();
    await page.getByRole('button', { name: 'Взаимодействия', exact: true }).click();
    await page.getByRole('heading', { name: 'Совместное влияние факторов' }).waitFor();
    const matrix = page.getByRole('table', { name: 'Тепловая карта попарных взаимодействий' });
    const newPair = matrix.locator('.heat-cell[aria-pressed="false"]').first();
    const pairKey = await newPair.getAttribute('data-key');
    await newPair.click();
    assert.equal(await page.getByLabel('Пара факторов').inputValue(), pairKey);
    await record(page, '07-interactions');
    await method.getByText('Методология и выгрузки', { exact: true }).click();
    assert.match(await method.locator('.formula').textContent(), /SHAP/);
    await method.getByRole('link', { name: 'Взаимодействия CSV', exact: true }).waitFor();
    await method.getByRole('link', { name: 'Качество CSV', exact: true }).waitFor();
    await openAI.click();
    assert.equal(await assistant.locator('#answer').textContent(), '');
    await assistant.getByRole('button', { name: 'Какие факторы главные?' }).click();
    await assistant.getByText('Показаны проверенные факты расчёта.', { exact: true }).waitFor();
    const current = await (await page.request.get(origin + '/api/workspace')).json();
    const report = await (await page.request.get(origin + `/api/export/${current.id}/reports/${current.report.analysisId}/analysis.json`)).json();
    assert.equal(report.unit, 'ед.');
    assert.equal(report.aiSummary.analysisId, report.analysisId);
    await page.route('**/api/explain', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await route.fulfill({ json: { analysisId: report.analysisId, facts: [{ text: 'Устаревший ответ' }], mode: 'facts' } }).catch(() => {});
    });
    await assistant.getByRole('button', { name: 'Какие факторы главные?' }).click();
    await assistant.getByText('Подбираем факты по текущему расчёту…', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'К обзору', exact: true }).click();
    await edit.click();
    await settings.locator('#from').selectOption('2026-05-25');
    await settings.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await applied.getByText('25.05.2026 — 25.08.2026', { exact: true }).waitFor();
    await openAI.click();
    assert.equal(await assistant.getByText('Показаны проверенные факты расчёта.', { exact: true }).count(), 0);
    assert.equal(await assistant.getByText('Устаревший ответ', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Данные', exact: true }).click();
    await page.getByRole('button', { name: 'Снимки ZIP', exact: true }).click();
    await page.getByLabel('Архив снимков').setInputFiles({ name: 'history.zip', mimeType: 'application/zip', buffer: await readFile(history) });
    const importStarted = page.waitForResponse(response => response.url().endsWith('/api/import-history') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Загрузить ZIP', exact: true }).click();
    const importResponse = await importStarted;
    assert.equal(importResponse.status(), 202, await importResponse.text());
    const { job: importId } = await importResponse.json();
    const imported = await waitForJob(page, origin, importId);
    assert.equal(imported.state, 'ready', imported.message);
    await page.getByText('Сверено с калькулятором', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'NPV базы', exact: true }).waitFor();
    const restored = await (await page.request.get(origin + '/api/workspace')).json();
    assert.equal(restored.id, imported.workspaceId);
    assert.equal(restored.source, 'historical');
    assert.equal(restored.report.mode, 'valuation');
    assert.equal(restored.report.target, 'npv');
    assert.equal(restored.periods.length, 8);
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

// An offline HTTP contract double. The browser, proxy, calculator and
// attribution underneath are real; the double supplies deterministic API states.
async function contractServer(reportDate) {
  const raw = execFileSync(python, ['-c', [
    'import json',
    'from datetime import date',
    'from service.integration import CODES, BUCKET_LABELS',
    'from service.fixtures import curve_fixture',
    `days = ['2026-05-29', '2026-06-30', '2026-07-31', '${reportDate}']`,
    'print(json.dumps([json.loads(curve_fixture(date.fromisoformat(day), CODES, BUCKET_LABELS)[1]) for day in days]))',
  ].join('\n')], { encoding: 'utf8' });
  const ready = new Map(JSON.parse(raw).map(value => [value.reportDate, {
    ...value, source: 'moex', runOrigin: 'automatic', dataProvenance: 'market',
  }]));
  const runs = new Map([...ready.values()].map(value => [value.runId, value]));
  const checks = new Map();
  let unavailable = false;
  const service = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const day = url.searchParams.get('reportDate');
    const base = ready.get(day);
    const route = url.pathname.replace('/api/v1', '');
    const reply = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (unavailable) return reply(503, { error: { code: 'SOURCE_UNAVAILABLE' } });
    if (route === '/openapi.json') return reply(200, {});
    if (route === '/input-rates') {
      const points = base?.curves[0].points.filter((_, index) => index % 4 === 0)
        .map(({ tenorYears, ratePercent }) => ({ tenorYears, ratePercent })) ?? [];
      return reply(200, { reportDate: day, source: 'moex', available: !!base, points,
        sourceAsOf: base?.completedAt ?? null, loadedAt: base?.completedAt ?? null });
    }
    if (route === '/curve-preparations') {
      const data = [];
      for await (const chunk of request) data.push(chunk);
      const selected = day ?? JSON.parse(Buffer.concat(data).toString()).reportDate;
      const match = ready.get(selected);
      return reply(200, { reportDate: selected, status: match ? 'ready' : 'no_data',
        runId: match?.runId ?? null, errorCode: null });
    }
    const state = (run, status = 'ready') => ({
      reportDate: run.reportDate, runId: run.runId, usedParameters: run.usedParameters,
      runOrigin: run.runOrigin, dataProvenance: run.dataProvenance, status,
      stage: 'stress', createdAt: run.completedAt, baseCurve: run.curves[0],
    });
    if (route === '/curve-runs/standard-result' && base) return reply(200, base);
    if (route === '/curve-runs') return reply(200, { reportDate: day,
      runs: [...runs.values()].filter(run => run.reportDate === day).map(run => state(run)) });
    const [, pathId, subroute] = route.match(/^\/curve-runs\/([\da-f-]+)(?:\/(\w+))?$/) ?? [];
    const run = runs.get(pathId);
    if (!run) return reply(404, { error: { code: 'NOT_FOUND' } });
    if (subroute === 'result') return reply(200, run);
    if (subroute === 'recalculations' && request.method === 'POST') {
      const data = [];
      for await (const chunk of request) data.push(chunk);
      const { scenarioParameters } = JSON.parse(Buffer.concat(data).toString());
      const id = randomUUID();
      const created = { ...run, runId: id, runOrigin: 'manual',
        usedParameters: scenarioParameters.mode === 'standard' ? base?.usedParameters ?? { mode: 'standard', p: 4, k: 5, d: 3 } : scenarioParameters };
      checks.set(id, 1);
      runs.set(id, created);
      return reply(202, { runId: id, status: 'queued' });
    }
    const pending = checks.get(pathId) || 0;
    if (pending) checks.set(pathId, pending - 1);
    return reply(200, state(run, pending ? 'running' : 'ready'));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  return { service, url: `http://127.0.0.1:${service.address().port}`,
    original: ready.get(reportDate).runId, fail: () => { unavailable = true; } };
}

test('embedded curves share the shell and pin a validated run to portfolio valuation', { timeout: 110_000 }, async () => {
  const date = '2026-08-25';
  const upstream = await contractServer(date);
  const data = await mkdtemp(join(tmpdir(), 'spectrum-embedded-'));
  const env = { ...process.env, SPECTRUM_DATA_DIR: data, SPECTRUM_LLM_ENABLED: '0', DEEPSEEK_API_KEY: '',
    SPECTRUM_CURVES_URL: upstream.url, SPECTRUM_CURVE_ASSETS: join(data, 'curve-ui') };
  let browser, server;
  try {
    execFileSync(python, ['-m', 'service.curve_ui'], { env, timeout: 40_000 });
    server = spawn(python, ['-m', 'service.server', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = await waitForServer(server);
    browser = await browserType.launch({ headless: true, executablePath: process.env.SPECTRUM_CHROME || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.setDefaultTimeout(9_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const heading = page.getByRole('heading', { name: 'Кривые доходности', exact: true });
    const use = page.getByRole('button', { name: 'Использовать для оценки портфеля' });
    const graph = page.getByRole('group', { name: /^Базовая и стрессовые кривые/ });
    const workspace = async () => (await page.request.get(origin + '/api/workspace')).json();
    await page.goto(origin + '/#curves?reportDate=' + date);
    assert.equal((await page.request.get(origin + '/curve-ui/curves.js')).status(), 200, 'native startup must provide the embedded entry');
    assert.equal((await page.request.get(origin + '/curve-ui/curves.css')).status(), 200, 'native startup must provide the embedded stylesheet');
    await heading.waitFor();
    await use.waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await page.getByRole('button', { name: /^Отчётная дата/ }).click();
    const dayPicker = page.getByRole('dialog').filter({ has: page.getByRole('group', { name: 'Дни месяца' }) });
    await dayPicker.waitFor();
    const selectedDay = dayPicker.locator('[data-date="2026-08-25"]');
    await selectedDay.focus();
    await selectedDay.press('PageUp');
    await dayPicker.locator('[data-date="2026-07-25"]').waitFor();
    assert.equal(await dayPicker.isVisible(), true, 'changing the focused month keeps the calendar open');
    await dayPicker.getByRole('button', { name: 'Предыдущий месяц', exact: true }).click();
    await dayPicker.locator('[data-date="2026-06-01"]').waitFor();
    await dayPicker.getByRole('button', { name: 'Следующий месяц', exact: true }).click();
    await dayPicker.getByRole('button', { name: 'Следующий месяц', exact: true }).click();
    await dayPicker.locator('[data-date="2026-08-24"]').click();
    await page.getByText('Нет публикации MOEX за выбранную дату.', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Отчётная дата/ }).click();
    await dayPicker.locator('[data-date="2026-08-25"]').click();
    await use.waitFor();
    await page.getByRole('button', { name: 'Общий рост ставок', exact: true }).click();
    assert.equal(await graph.locator('polyline').count(), 2);
    await graph.locator('.curve-chart__hit').first().focus();
    await page.getByRole('tooltip').filter({ hasText: 'Общий рост ставок' }).waitFor();
    await page.getByRole('button', { name: 'Показать исходную MOEX' }).click();
    await page.getByText('К расчётным кривым', { exact: true }).click();
    await page.getByRole('tab', { name: 'Таблица', exact: true }).click();
    assert.equal(await page.getByRole('table').getByRole('row').count(), 24);
    const curveDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать CSV' }).click();
    assert.match((await curveDownload).suggestedFilename(), /\.csv$/);
    await page.getByRole('tab', { name: 'График', exact: true }).click();
    await noOverflow(page, [[1440, 900], [390, 844], [320, 720]]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '09-curves-contract');
    await page.locator('#curve-screen').evaluate(host => { host.shadowRoot.querySelector('.curve-app').dataset.mountCheck = 'retained'; });
    await page.getByRole('link', { name: 'Данные', exact: true }).click();
    await page.goBack();
    await use.waitFor();
    assert.equal(await page.locator('.curve-app').getAttribute('data-mount-check'), 'retained');

    await use.click();
    await page.getByLabel('Сделок на старте', { exact: true }).fill('30');
    await page.getByLabel('Число отчётных дат').fill('4');
    await page.getByLabel('Новых сделок в месяц').fill('2');
    await page.getByRole('button', { name: 'Создать тестовый портфель', exact: true }).click();
    await page.getByRole('heading', { name: 'Состав портфеля', exact: true }).waitFor({ timeout: 40_000 });
    const old = await workspace();
    assert.equal(old.periods.at(-1).runId, upstream.original);
    assert.equal(old.periods.at(-1).curveSource, 'pinned');
    assert.equal(new Set(old.periods.map(period => period.runId)).size, 4);
    await page.getByRole('table', { name: 'Найденные сделки' }).getByRole('button').first().click();
    const deal = page.locator('#inspector');
    await deal.getByText('Валюта', { exact: true }).waitFor();
    await deal.getByText('PV по стрессовым сценариям', { exact: true }).click();
    assert.equal(await deal.getByRole('table', { name: 'PV по стрессовым сценариям' }).getByRole('row').count(), 7);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Сценарии', exact: true }).click();
    await page.getByRole('link', { name: 'Открыть использованные кривые' }).click();
    await page.getByRole('heading', { name: 'Кривые из оценки портфеля' }).waitFor();
    await graph.waitFor();
    assert.ok(page.url().includes(old.id) && page.url().includes(upstream.original));
    await page.reload();
    await graph.waitFor();
    await page.getByRole('button', { name: 'К кривым за эту дату' }).click();
    await use.waitFor();

    const settings = page.getByRole('dialog', { name: 'Смена параметров сценариев', exact: true });
    const parameters = page.getByRole('button', { name: 'Редактировать параметры' });
    await parameters.click();
    const shock = settings.locator('input[name=p]');
    await shock.fill('0');
    await settings.getByRole('button', { name: 'Применить' }).click();
    await settings.getByRole('alert').waitFor();
    await shock.fill('6');
    await settings.getByRole('button', { name: 'Применить' }).click();
    const recalc = page.getByRole('button', { name: 'Пересчитать кривые', exact: true });
    await recalc.click();
    await page.getByText('Запуск находится в очереди или рассчитывается.', { exact: true }).waitFor();
    await page.getByText(/Этот запуск доступен для просмотра и выгрузки/).waitFor();
    const customRun = new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('runId');
    assert.ok(customRun && customRun !== upstream.original);
    assert.equal(await use.count(), 0);
    assert.equal((await workspace()).id, old.id);
    const refused = await page.request.post(origin + '/api/revalue', { data: {
      workspaceId: old.id, analysisId: old.report.analysisId, curveSelection: { reportDate: date, runId: customRun },
    } });
    const { job: rejectedId } = await refused.json();
    const failure = await waitForJob(page, origin, rejectedId);
    assert.equal(failure.state, 'failed');
    assert.match(failure.message, /стандартными/);
    assert.equal((await workspace()).id, old.id);
    await page.getByRole('button', { name: 'История', exact: true }).click();
    await page.getByRole('button', { name: /Стандартные · Автоматический/ }).click();
    await use.waitFor();
    assert.ok(page.url().endsWith(upstream.original));
    await recalc.click();
    await page.waitForFunction(id => !location.hash.endsWith(id), upstream.original);
    await use.click();
    await page.getByText('Выбран новый запуск кривых', { exact: false }).waitFor();
    assert.equal((await workspace()).id, old.id);
    await page.getByRole('button', { name: 'Переоценить портфель', exact: true }).click();
    await page.getByRole('heading', { name: 'Расчёт завершён', exact: true }).waitFor({ timeout: 30_000 });
    const updated = await workspace();
    assert.notEqual(updated.id, old.id);
    assert.notEqual(updated.periods.at(-1).runId, upstream.original);
    assert.deepEqual(updated.periods.slice(0, -1).map(p => p.sha256), old.periods.slice(0, -1).map(p => p.sha256));
    const readFlows = async (workspaceId) => (await page.request.get(origin + `/api/export/${workspaceId}/${date}/cashflows.csv`)).text();
    assert.equal(await readFlows(updated.id), await readFlows(old.id));
    upstream.fail();
    await page.getByRole('link', { name: 'Кривые', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /MOEX временно недоступен|Сервер временно недоступен/ }).waitFor();
    assert.equal((await workspace()).id, updated.id);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'close');
    }
    upstream.service.closeAllConnections();
    await new Promise(resolve => upstream.service.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
});
