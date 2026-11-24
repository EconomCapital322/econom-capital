import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
      const [brand, action] = await Promise.all([
        page.locator('.brand').boundingBox(),
        page.getByRole('link', { name: 'Новый расчёт', exact: true }).boundingBox(),
      ]);
      assert.ok(brand && action, `missing mobile navigation at ${width}`);
      assert.ok(brand.x + brand.width <= action.x,
        `overlapping navigation at ${width} (brand ends at ${brand.x + brand.width}, action starts at ${action.x})`);
    }
  }
}

const cases = [[1920, 1080], [1440, 900], [1280, 720], [768, 900], [390, 844]];

test('portfolio, valuation, stress, CSV and ZIP analysis, exports, and responsive navigation', { timeout: 150_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'spectrum-browser-'));
  const server = spawn(python, ['-m', 'service.server', '--port', '0'], {
    env: { ...process.env, SPECTRUM_DATA_DIR: data, SPECTRUM_LLM_ENABLED: '0', DEEPSEEK_API_KEY: '', SPECTRUM_CURVES_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    const origin = await waitForServer(server);
    browser = await chromium.launch({ headless: true, executablePath: process.env.SPECTRUM_CHROME || undefined });
    const brandPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await brandPage.route('**/spectrum.svg', (route) => route.fulfill({ status: 404 }));
    await brandPage.goto(origin);
    const renderedMark = await brandPage.locator('.brand').evaluate((brand) => {
      const svg = brand.querySelector('svg');
      return svg ? svg.getBBox().width > 0 : brand.querySelector('img')?.naturalWidth > 0;
    });
    assert.ok(renderedMark, 'The sidebar logo is visible when the standalone SVG is unavailable.');
    await brandPage.evaluate(() => document.fonts.ready);
    const mobileAction = brandPage.getByRole('link', { name: 'Новый расчёт', exact: true });
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
    await page.getByRole('heading', { name: 'Почему изменился NPV?', exact: true }).waitFor();
    await page.getByText('Сверено с калькулятором', { exact: true }).waitFor({ timeout: 40_000 });
    await page.getByRole('group', { name: 'Вклады факторов относительно нуля' }).waitFor();
    await noOverflow(page, cases);
    const settings = page.getByRole('button', { name: /^Параметры расчёта/ });
    assert.equal(await settings.getAttribute('aria-expanded'), 'false');
    assert.ok(await page.locator('#bridge-chart').evaluate((chart) => chart.getBoundingClientRect().top < innerHeight));
    await settings.click();
    await page.getByRole('button', { name: 'Расчётный анализ', exact: true }).waitFor();
    assert.equal(await settings.getAttribute('aria-expanded'), 'true');
    await settings.click();
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
    await page.getByRole('button', { name: 'Вклады', exact: true }).click();
    await page.getByRole('button', { name: 'Как выполнен расчёт' }).click();
    await page.getByRole('heading', { name: 'Сверка и четыре пересчёта' }).waitFor();
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
    await page.getByText('Экспорт', { exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Вклады CSV' }).click();
    assert.equal((await downloaded).suggestedFilename(), 'factors.csv');
    const downloadedHtml = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Отчёт HTML' }).click();
    assert.equal((await downloadedHtml).suggestedFilename(), 'analysis.html');
    await page.getByRole('link', { name: 'Стресс-сценарии', exact: true }).click();
    const curve = page.getByRole('img', { name: 'Базовая и выбранная стрессовая кривые' });
    await curve.waitFor();
    assert.equal(await page.getByRole('group', { name: 'Выбор сценария' }).getByRole('button').count(), 6);
    const initialCurve = await curve.locator('polyline').last().getAttribute('points');
    const initialBuckets = await page.getByRole('group', { name: 'Вклад сроков платежей', exact: true }).textContent();
    const steepener = page.getByRole('button', { name: /^Увеличение наклона кривой/ });
    await steepener.click();
    assert.equal(await steepener.getAttribute('aria-pressed'), 'true');
    assert.notEqual(await curve.locator('polyline').last().getAttribute('points'), initialCurve);
    assert.notEqual(await page.getByRole('group', { name: 'Вклад сроков платежей', exact: true }).textContent(), initialBuckets);
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, '02-scenarios');
    await page.getByRole('button', { name: 'Разобрать изменение сценария' }).click();
    assert.equal(await page.locator('#metric').inputValue(), 'stress_delta');
    assert.equal(await page.locator('#analysis-scenario').inputValue(), 'steepener');
    await page.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await page.getByText('ΔPV · Увеличение наклона', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Анализ зависимостей (ML)', exact: true }).click();
    await page.getByLabel('Показатель').selectOption('npv');
    await page.getByText('Параметры изменены. Ниже показан предыдущий результат.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await page.getByRole('button', { name: 'Проверка качества модели' }).click();
    await page.getByRole('heading', { name: 'Проверка качества модели' }).waitFor();
    await page.getByRole('link', { name: 'Портфель', exact: true }).click();
    await page.getByRole('searchbox', { name: 'ID сделки' }).fill('1');
    const results = page.waitForResponse((response) => response.url().includes('/api/deals/') && new URL(response.url()).searchParams.get('q') === '1');
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    assert.equal((await (await results).json()).rows[0].deal_id, '1');
    await page.getByRole('table', { name: 'Найденные сделки' }).getByRole('button', { name: '1', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: 'Данные и источники', exact: true }).click();
    await record(page, '04-data');
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
    await page.getByRole('button', { name: 'Как меняется связь с показателем' }).click();
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
    await page.getByRole('button', { name: 'Совместное влияние факторов' }).click();
    await page.getByRole('heading', { name: 'Совместное влияние факторов' }).waitFor();
    const matrix = page.getByRole('table', { name: 'Тепловая карта попарных взаимодействий' });
    const newPair = matrix.locator('.heat-cell[aria-pressed="false"]').first();
    const pairKey = await newPair.getAttribute('data-key');
    await newPair.click();
    assert.equal(await page.getByLabel('Пара факторов').inputValue(), pairKey);
    await record(page, '07-interactions');
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
    await page.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await page.locator('.hero-meta').getByText('25.05.2026 — 25.08.2026', { exact: true }).waitFor();
    assert.equal(await page.getByText('Показаны проверенные факты расчёта.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Устаревший ответ', { exact: true }).count(), 0);
    await page.getByRole('link', { name: 'Данные и источники', exact: true }).click();
    await page.getByRole('button', { name: 'Снимки ZIP', exact: true }).click();
    await page.getByLabel('Архив снимков').setInputFiles({ name: 'history.zip', mimeType: 'application/zip', buffer: await readFile(history) });
    await page.getByRole('button', { name: 'Загрузить ZIP', exact: true }).click();
    await page.getByRole('heading', { name: 'Почему изменился NPV?', exact: true }).waitFor();
    const restored = await (await page.request.get(origin + '/api/workspace')).json();
    assert.equal(restored.source, 'historical');
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
