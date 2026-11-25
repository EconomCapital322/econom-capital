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
assert.ok(['chromium', 'webkit', 'firefox'].includes(engine), 'Use chromium, webkit, or firefox for browser checks.');
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

async function recordThemes(page, name, selector, fullPage = true) {
  if (!screenshotDirectory) return;
  await record(page, name, selector, fullPage);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await record(page, name + '-dark', selector, fullPage);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
}

async function noOverflow(page, viewports) {
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    const span = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (span[0] > span[1] + 1) {
      const overhang = await page.evaluate(() => [...document.body.querySelectorAll('*')]
        .filter((element) => !element.closest('.table-wrap, .chart-scroll, .icon-library') &&
          element.getBoundingClientRect().left + Math.max(element.getBoundingClientRect().width, element.scrollWidth) > innerWidth + 1)
        .slice(0, 14).map((element) => `${element.tagName}${element.id ? '#' + element.id : ''}.${element.getAttribute('class') ?? ''}(${element.clientWidth}/${element.scrollWidth})`));
      assert.fail(`layout overflow at ${width}: ${span}. ${overhang.join(', ')}`);
    }
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

const cases = [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 720]];

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
    env: { ...process.env, SPECTRUM_DATA_DIR: data, SPECTRUM_CURVES_DIR: join(data, 'curves-cache'),
      SPECTRUM_LLM_ENABLED: '0', DEEPSEEK_API_KEY: '', SPECTRUM_CURVES_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    const origin = await waitForServer(server);
    browser = await browserType.launch({ headless: true, executablePath: process.env.SPECTRUM_CHROME || undefined });
    const brandPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await brandPage.route('**/spectrum.svg', (route) => route.fulfill({ status: 404 }));
    let releaseWorkspace;
    const startupPending = new Promise(resolve => { releaseWorkspace = resolve; });
    await brandPage.route('**/api/workspace', async route => { await startupPending; await route.continue(); });
    try {
      await brandPage.goto(origin);
      await brandPage.waitForFunction(() => document.documentElement.hasAttribute('data-opening') &&
        getComputedStyle(document.querySelector('.prism-incoming')).animationName === 'prism-beam');
    } finally {
      releaseWorkspace();
    }
    await brandPage.getByRole('heading', { name: 'Подготовьте историю портфеля' }).waitFor();
    assert.equal(await brandPage.locator('html').getAttribute('data-opening'), null);
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
    await recordThemes(page, '00-empty-workspace');
    const appearance = page.locator('#appearance-dialog');
    const appearanceButton = page.getByRole('button', { name: 'Внешний вид', exact: true });
    await appearanceButton.click();
    await appearance.getByLabel('Тема').selectOption('dark');
    await appearance.getByLabel('Прозрачность').selectOption('reduced');
    await appearance.getByLabel('Анимация').selectOption('reduced');
    await appearance.getByLabel('Плотность').selectOption('compact');
    await appearance.getByLabel('Оптика блика').selectOption('enhanced');
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('html').getAttribute('data-transparency'), 'reduced');
    assert.equal(await page.locator('html').getAttribute('data-motion'), 'reduced');
    assert.equal(await page.locator('html').getAttribute('data-density'), 'compact');
    assert.equal(await page.locator('html').getAttribute('data-optics'), 'enhanced');
    const navigationMaterial = await page.locator('.navigation-shell').evaluate((nav) => getComputedStyle(nav).backdropFilter);
    assert.equal(navigationMaterial, 'none');
    await appearanceButton.click();
    await appearance.getByLabel('Тема').selectOption('system');
    await appearance.getByLabel('Прозрачность').selectOption('full');
    await appearance.getByLabel('Анимация').selectOption('full');
    await page.keyboard.press('Escape');
    await appearance.waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+k');
    const commands = page.locator('#command-palette');
    const search = commands.getByRole('combobox');
    await search.fill('параметры');
    const restoredQuery = await commands.evaluate((dialog) => {
      const shortcut = () => dialog.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true,
      }));
      shortcut();
      const closing = dialog.hasAttribute('data-closing');
      shortcut();
      return { closing, open: dialog.open && !dialog.hasAttribute('data-closing'), value: dialog.querySelector('input').value };
    });
    assert.deepEqual(restoredQuery, { closing: true, open: true, value: 'параметры' });
    await search.press('Escape');
    await commands.waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+k');
    await search.fill('пустой поиск');
    await commands.getByText('Действия не найдены.').waitFor();
    await search.fill('плотность');
    assert.equal(await commands.getByRole('option').count(), 2);
    await search.press('ArrowDown');
    await search.press('Enter');
    await commands.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('html').getAttribute('data-density'), 'comfortable');
    const navMark = page.getByRole('link', { name: 'Анализ', exact: true }).locator('.icon');
    const beforeCollapse = await navMark.boundingBox();
    await page.getByRole('button', { name: 'Свернуть меню', exact: true }).click();
    await page.waitForFunction(() => Math.abs(document.querySelector('.navigation-shell').getBoundingClientRect().width - 68) < 1);
    assert.equal(Math.round((await navMark.boundingBox()).x), Math.round(beforeCollapse.x));
    await page.getByRole('button', { name: 'Развернуть меню', exact: true }).click();
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
    await recordThemes(page, '03-portfolio');
    await page.getByRole('button', { name: 'Создать тестовый портфель' }).click();
    await page.getByRole('heading', { name: 'Расчёт завершён', exact: true }).waitFor({ timeout: 40_000 });
    await page.getByRole('heading', { name: 'Состав портфеля', exact: true }).waitFor();
    await page.locator('#holding-overview').getByText(/^Активы ·/).waitFor();
    const holdings = page.locator('#portfolio-holdings');
    const holdingDate = holdings.locator('#portfolio-date');
    const latestDate = await holdingDate.inputValue();
    const earliestDate = await holdingDate.locator('option').first().getAttribute('value');
    const distributions = holdings.getByText('Структура по ставкам, платежам и срокам', { exact: true });
    await distributions.click();
    await holdingDate.evaluate(select => { select.dataset.identity = 'retained'; });
    await holdingDate.selectOption(earliestDate);
    await page.locator('#portfolio-holdings[data-date="' + earliestDate + '"]').waitFor();
    assert.equal(await holdingDate.getAttribute('data-identity'), 'retained');
    assert.equal(await distributions.evaluate(summary => summary.parentElement.open), true);
    assert.ok((await holdings.getByRole('link', { name: 'CSV для калькулятора' }).getAttribute('href'))
      .endsWith('/' + earliestDate + '/calculator_input.csv'));
    await holdingDate.selectOption(latestDate);
    await page.locator('#portfolio-holdings[data-date="' + latestDate + '"]').waitFor();
    await distributions.click();
    await page.getByRole('button', { name: 'Спросить AI', exact: true }).click();
    await page.getByRole('button', { name: 'Как распределяются сроки?' }).click();
    await page.locator('#answer').getByText(/Оставшиеся сроки на/).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#assistant-drawer').waitFor({ state: 'hidden' });
    await recordThemes(page, '03-portfolio-holdings');
    await page.getByRole('link', { name: 'Открыть факторный анализ' }).click();
    await page.getByRole('heading', { name: 'NPV базы', exact: true }).waitFor();
    await page.getByText('Сверено с калькулятором', { exact: true }).waitFor({ timeout: 40_000 });
    await page.getByRole('group', { name: /^Водопад изменения показателя/ }).waitFor();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
    const animationDuration = await page.locator('.chart-waterfall-compact .waterfall-bar').first().evaluate(bar => getComputedStyle(bar).animationDuration);
    assert.equal(animationDuration, '0s', 'chart respects reduced motion');
    await recordThemes(page, '01-valuation-mobile');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await recordThemes(page, '01-valuation');
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
    await settings.waitFor({ state: 'hidden' });
    assert.equal(await settings.isVisible(), false);
    assert.equal(await applied.textContent(), actualPeriod);
    const cash = page.locator('#bridge-chart [data-key="factor:cash_effect"]:visible');
    await cash.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('#factor-drawer');
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await drawer.getByText('Метод и источник', { exact: true }).click();
    await drawer.getByRole('button', { name: 'Детализация потоков и источник' }).waitFor();
    await recordThemes(page, '01-factor-drawer', undefined, false);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await cash.evaluate((element) => element === document.activeElement), true);
    await cash.click();
    const factorAnswer = page.waitForRequest((request) => request.url().endsWith('/api/explain'));
    await drawer.getByRole('button', { name: 'Объяснить с помощью AI' }).click();
    assert.equal((await factorAnswer).postDataJSON().focusFactor, 'factor:cash_effect');
    await page.locator('#answer').getByText('Показаны проверенные факты расчёта.', { exact: true }).waitFor();
    assert.equal(await assistant.evaluate(dialog => dialog.matches(':modal')), false);
    await page.waitForFunction(() => {
      const panel = document.querySelector('#assistant-drawer').getBoundingClientRect();
      const workspace = document.querySelector('.workspace').getBoundingClientRect();
      return panel.left >= workspace.right;
    });
    const grip = assistant.getByRole('separator', { name: 'Ширина помощника' });
    const startWidth = Number(await grip.getAttribute('aria-valuenow'));
    await grip.press('ArrowLeft');
    assert.equal(Number(await grip.getAttribute('aria-valuenow')), startWidth + 24);
    await page.waitForFunction((width) => Math.abs(document.querySelector('#assistant-drawer').getBoundingClientRect().width - width) < 1,
      startWidth + 24);
    const handle = await grip.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2, { steps: 4 });
    await page.mouse.up();
    assert.ok(Number(await grip.getAttribute('aria-valuenow')) < startWidth + 24);
    await assistant.locator('#question').fill('Черновик вопроса');
    await assistant.getByRole('button', { name: 'Свернуть помощника' }).click();
    await assistant.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Восстановить AI' }).click();
    assert.equal(await assistant.locator('#question').inputValue(), 'Черновик вопроса');
    await noOverflow(page, [[1920, 1080], [1440, 900], [1280, 800]]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await recordThemes(page, 'ai-valuation', undefined, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('.assistant-composer').getBoundingClientRect().bottom <= innerHeight + 1);
    await page.waitForFunction(() => document.querySelector('#assistant-drawer').matches(':modal'));
    await record(page, 'ai-valuation-mobile', undefined, false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => !document.querySelector('#assistant-drawer').matches(':modal'));
    await page.locator('#answer').getByRole('button', { name: /^Открыть источник/ }).first().click();
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await assistant.isVisible(), true, 'Follow a verified source and keep the assistant visible.');
    await page.getByRole('button', { name: 'К вкладам', exact: true }).click();
    await page.getByRole('group', { name: 'Вклады факторов относительно нуля' }).waitFor();
    await page.getByRole('button', { name: 'Водопад', exact: true }).click();
    await page.getByRole('group', { name: /^Водопад изменения показателя/ }).waitFor();
    await record(page, '01-waterfall', '#waterfall');
    await cash.click();
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await drawer.getByRole('button', { name: 'Закрыть детали', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await assistant.getByRole('button', { name: 'Закрыть помощника' }).click();
    await assistant.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'К вкладам', exact: true }).click();
    await openResearch.click();
    await page.getByRole('img', { name: 'История выбранного показателя' }).waitFor();
    assert.match(page.url(), /#analysis\?view=details&tab=timeline$/);
    await page.goBack();
    await openResearch.waitFor();
    await page.goForward();
    await page.getByRole('img', { name: 'История выбранного показателя' }).waitFor();
    await page.locator('.tab-body .chart-scroll').focus();
    await page.keyboard.press('ArrowRight');
    assert.match(await page.locator('[data-chart-announcement]').textContent(), /₽/);
    const trend = page.locator('#tab-body [data-chart-figure]');
    await page.keyboard.press('Enter');
    await page.locator('.chart-tooltip').getByText('Закреплено · Esc для сброса').waitFor();
    await trend.getByRole('button', { name: 'Увеличить масштаб' }).click();
    assert.match(await trend.locator('[data-plot]').getAttribute('transform'), /scale\(1.5,1\)/);
    await trend.getByRole('button', { name: 'Развернуть график' }).click();
    const chartFocus = page.locator('#chart-focus');
    assert.match(await chartFocus.locator('[data-plot]').getAttribute('transform'), /scale\(1.5,1\)/);
    const fullView = chartFocus.locator('.chart-scroll');
    await fullView.press('End');
    await page.waitForFunction(() => {
      const modal = document.querySelector('#chart-focus').getBoundingClientRect();
      const tip = document.querySelector('.chart-tooltip').getBoundingClientRect();
      return tip.width > 0 && tip.left >= modal.left && tip.right <= modal.right && tip.top >= modal.top && tip.bottom <= modal.bottom;
    });
    await chartFocus.getByRole('button', { name: 'Закрыть полноэкранный график' }).click();
    await trend.waitFor();
    const lastPoint = trend.locator('[data-date]').last();
    const lastPointValue = await lastPoint.getAttribute('data-value');
    const tabs = page.getByRole('group', { name: 'Разделы аналитики' });
    const indicatorJump = await tabs.evaluate(track => {
      const pill = track.firstElementChild;
      const [timeline, factors] = track.querySelectorAll('button');
      factors.click();
      const flight = pill.getAnimations()[0];
      flight.pause();
      flight.currentTime = 66;
      const a = pill.getBoundingClientRect();
      timeline.click();
      const reversal = pill.getAnimations()[0];
      reversal.pause();
      reversal.currentTime = 0;
      const b = pill.getBoundingClientRect();
      reversal.play();
      return Math.abs(a.x - b.x) + Math.abs(a.width - b.width);
    });
    assert.ok(indicatorJump <= 1, 'the tab capsule continues from the previous pose');
    assert.match(await trend.locator('[data-plot]').getAttribute('transform'), /scale\(1.5,1\)/);
    await page.locator('.chart-tooltip').getByText(lastPointValue, { exact: false }).waitFor();
    await trend.getByRole('button', { name: 'Сбросить' }).click();
    await trend.getByRole('button', { name: 'Период', exact: true }).click();
    const firstAnalysisDay = await trend.getByLabel('Начало').locator('option').first().getAttribute('value');
    const lastAnalysisDay = await trend.getByLabel('Конец').locator('option').last().getAttribute('value');
    const plot = trend.locator('[data-plot-hit]');
    await plot.scrollIntoViewIfNeeded();
    const hit = await plot.boundingBox();
    const middlePoint = trend.locator('[data-date]').nth(3);
    const middleDay = await middlePoint.getAttribute('data-date');
    const first = await trend.locator('[data-date]').first().boundingBox();
    const middle = await middlePoint.boundingBox();
    const y = hit.y + hit.height / 2;
    await page.mouse.move(middle.x + middle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(first.x + first.width / 2 + 1, y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await trend.getByLabel('Начало').inputValue(), firstAnalysisDay);
    assert.equal(await trend.getByLabel('Конец').inputValue(), middleDay);
    assert.equal(await trend.locator('[data-period-mark]').getAttribute('visibility'), 'visible');
    const keyboardPlot = trend.locator('.chart-scroll');
    await keyboardPlot.press('End');
    await keyboardPlot.press('Enter');
    await keyboardPlot.press('Home');
    await keyboardPlot.press('Enter');
    assert.equal(await trend.getByLabel('Начало').inputValue(), firstAnalysisDay);
    assert.equal(await trend.getByLabel('Конец').inputValue(), lastAnalysisDay);
    await trend.getByRole('button', { name: 'К параметрам расчёта' }).click();
    assert.equal(await settings.locator('#from').inputValue(), firstAnalysisDay);
    assert.equal(await applied.textContent(), actualPeriod);
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'hidden' });
    if (engine === 'chromium') {
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await phone.goto(origin + '/#analysis?view=details&tab=timeline');
      const phoneTrend = phone.locator('#tab-body [data-chart-figure]');
      await phoneTrend.getByRole('button', { name: 'Период', exact: true }).tap();
      const phonePlot = phoneTrend.locator('[data-plot-hit]');
      await phonePlot.scrollIntoViewIfNeeded();
      const bounds = await phonePlot.boundingBox();
      const endpoints = await phoneTrend.locator('[data-date]').evaluateAll(dots =>
        [dots[1], dots.at(-2)].map(dot => {
          const box = dot.getBoundingClientRect();
          return { x: box.x + box.width / 2, date: dot.dataset.date };
        }));
      for (const endpoint of endpoints) await phone.touchscreen.tap(endpoint.x, bounds.y + bounds.height / 2);
      assert.equal(await phoneTrend.getByLabel('Начало').inputValue(), endpoints[0].date);
      assert.equal(await phoneTrend.getByLabel('Конец').inputValue(), endpoints[1].date);
      await phone.close();
    }
    await trend.getByRole('button', { name: 'Период', exact: true }).click();
    if (screenshotDirectory) await page.keyboard.press('Escape');
    await recordThemes(page, '05-research');
    await page.getByRole('button', { name: 'Вклады', exact: true }).click();
    const ledger = page.getByRole('table', { name: 'Полное разложение' });
    await ledger.waitFor();
    await ledger.getByRole('button', { name: 'Денежные потоки', exact: true }).click();
    await drawer.getByRole('heading', { name: 'Денежные потоки', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const researchTabs = page.getByRole('group', { name: 'Разделы аналитики' });
    const cashTab = researchTabs.getByRole('button', { name: 'Денежные потоки', exact: true });
    const decompose = page.getByRole('button', { name: 'Разложить денежные потоки' });
    await cashTab.click();
    await decompose.click({ trial: true });
    await researchTabs.getByRole('button', { name: 'Динамика', exact: true }).click();
    await cashTab.click();
    await decompose.click();
    await page.getByRole('group', { name: 'Вклады в изменение денежных потоков' }).waitFor();
    await page.getByText('Все вклады и их суммы', { exact: true }).click();
    await page.getByRole('table', { name: 'Вклады в изменение денежных потоков' }).waitFor();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await recordThemes(page, '08-cash-details', '#cash-details');
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
    await openAI.click();
    await assistant.getByRole('button', { name: 'Есть ли пропуски и выбросы?' }).click();
    await assistant.locator('#answer').getByText(/Пропуски:/).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Сценарии', exact: true }).click();
    const curve = page.getByRole('img', { name: 'Базовая и выбранная стрессовая кривые' });
    await curve.waitFor();
    assert.equal(await page.getByRole('group', { name: 'Выбор сценария' }).getByRole('button').count(), 6);
    const initialCurve = await curve.locator('polyline').last().getAttribute('points');
    const bucketDetail = page.locator('details[data-scenario-detail="buckets"]');
    const buckets = bucketDetail.getByRole('group', { name: 'Вклад сроков платежей', exact: true });
    assert.equal(await buckets.isVisible(), true);
    await bucketDetail.locator('summary').click();
    assert.equal(await buckets.isVisible(), false);
    await bucketDetail.locator('summary').click();
    const initialBuckets = await buckets.textContent();
    const steepener = page.getByRole('button', { name: /^Увеличение наклона кривой/ });
    const baseLine = await curve.locator('polyline').first().getAttribute('points');
    await curve.locator('polyline').first().evaluate(line => { line.dataset.identity = 'unchanged'; });
    if (screenshotDirectory && engine === 'chromium') await page.context().tracing.start({ screenshots: true, snapshots: true });
    await steepener.click();
    assert.equal(await steepener.getAttribute('aria-pressed'), 'true');
    const numberText = (input) => input.replace(/\s+/g, '');
    assert.equal(numberText(await page.locator('.scenario-values dd').last().textContent()),
      numberText(await steepener.locator('strong').textContent()), 'the selected amount stays exact during the visual transition');
    await page.waitForFunction((points) => document.querySelector('[data-morph-line] polyline').getAttribute('points') !== points, initialCurve);
    assert.equal(await curve.locator('polyline').first().getAttribute('points'), baseLine);
    assert.equal(await curve.locator('polyline').first().getAttribute('data-identity'), 'unchanged');
    if (screenshotDirectory && engine === 'chromium') {
      await page.locator('svg[data-morphing]').waitFor({ state: 'hidden' });
      await page.context().tracing.stop({ path: join(screenshotDirectory, 'scenario-transition.zip') });
    }
    assert.notEqual(await buckets.textContent(), initialBuckets);
    await bucketDetail.locator('summary').click();
    const scenarioFiles = page.locator('details[data-scenario-detail="results"]');
    await scenarioFiles.locator('summary').click();
    await scenarioFiles.getByRole('table', { name: 'PV всех сделок по сценариям' }).waitFor();
    await scenarioFiles.getByRole('link', { name: 'Снимок кривых' }).waitFor();
    await scenarioFiles.locator('summary').click();
    await noOverflow(page, cases);
    await page.setViewportSize({ width: 1440, height: 900 });
    await recordThemes(page, '02-scenarios');
    await openAI.click();
    await assistant.getByRole('button', { name: 'Какие сроки дали главный вклад?' }).click();
    await assistant.locator('#answer').getByText(/Бакет .* даёт/).first().waitFor();
    await assistant.getByRole('button', { name: /^Открыть источник · Срок/ }).first().click();
    assert.equal(await bucketDetail.evaluate((element) => element.open), true);
    await page.getByRole('button', { name: 'Разобрать изменение сценария' }).click();
    await settings.waitFor();
    assert.equal(await page.locator('#metric').inputValue(), 'stress_delta');
    assert.equal(await page.locator('#analysis-scenario').inputValue(), 'steepener');
    await page.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await page.getByRole('heading', { name: 'ΔPV · Увеличение наклона кривой' }).waitFor();
    const periodBeforeModeSwitch = await applied.locator('li').first().textContent();
    await page.getByRole('button', { name: 'ML-анализ', exact: true }).click();
    await applied.getByText('Анализ зависимостей (ML)', { exact: true }).waitFor();
    assert.equal(await applied.locator('li').first().textContent(), periodBeforeModeSwitch);
    await page.getByRole('button', { name: 'Расчётный', exact: true }).click();
    await applied.getByText('Расчётный анализ', { exact: true }).waitFor();
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
    await recordThemes(page, '10-model-quality');
    if (await assistant.isVisible()) {
      await assistant.getByRole('button', { name: 'Закрыть помощника' }).click();
      await assistant.waitFor({ state: 'hidden' });
    }
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
    await recordThemes(page, '04-data');
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
    const sources = page.locator('#data-sources');
    await sources.evaluate(details => { details.dataset.identity = 'retained'; });
    await page.getByRole('button', { name: 'Таблица CSV', exact: true }).click();
    assert.equal(await sources.getAttribute('data-identity'), 'retained');
    assert.equal(await sources.evaluate(details => details.open), true);
    const example = await (await page.request.get(origin + '/api/example.csv')).text();
    const untrusted = '<b data-column-name="test">Длинное пользовательское название укладывается на мобильном экране</b>';
    const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
    const renamed = example.replace('размер', quote(untrusted));
    const picker = page.locator('#import-form .file-picker');
    await page.getByLabel('Файл истории').setInputFiles({ name: 'too-large.csv', mimeType: 'text/csv', buffer: Buffer.alloc(6_000_001) });
    await page.getByRole('button', { name: 'Загрузить CSV' }).click();
    await page.locator('#import-form').getByRole('alert').getByText('Выберите CSV размером до 6 МБ.').waitFor();
    assert.equal(await page.getByLabel('Файл истории').getAttribute('aria-invalid'), 'true');
    await recordThemes(page, '11-import-error');
    await picker.evaluate((target, csv) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([csv], 'данные.csv', { type: 'text/csv' }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, renamed);
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
    await recordThemes(page, '06-nonlinearity');
    await page.locator('#effect-select').selectOption(untrusted);
    const effectChart = page.getByRole('combobox', { name: 'Вид графика', exact: true });
    await effectChart.selectOption('shap');
    await page.getByRole('img', { name: 'Значение признака и вклад SHAP' }).waitFor();
    await effectChart.selectOption('ice');
    await page.getByRole('img', { name: 'Изменение предсказания для отдельных наблюдений' }).waitFor();
    await effectChart.selectOption('pdp');
    await page.getByRole('img', { name: 'Среднее предсказание по выбранному признаку' }).waitFor();
    await page.getByRole('columnheader', { name: 'Средний прогноз' }).waitFor();
    await openAI.click();
    const selectedEffect = page.waitForRequest(request => request.url().endsWith('/api/explain'));
    await assistant.getByRole('button', { name: 'Какая форма зависимости у выбранного признака?' }).click();
    assert.deepEqual((await selectedEffect).postDataJSON().analysisFocus, { kind: 'effect', item: untrusted });
    await assistant.locator('button[data-key="#effects"]').first().click();
    assert.equal(await effectChart.inputValue(), 'ale');
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
    await recordThemes(page, '07-interactions');
    await method.getByText('Методология и выгрузки', { exact: true }).click();
    assert.match(await method.locator('.formula').textContent(), /SHAP/);
    await method.getByRole('link', { name: 'Взаимодействия CSV', exact: true }).waitFor();
    await method.getByRole('link', { name: 'Качество CSV', exact: true }).waitFor();
    await openAI.click();
    assert.equal(await assistant.locator('#answer').textContent(), '');
    await assistant.getByRole('button', { name: 'Какие факторы главные?' }).click();
    await assistant.getByText('Показаны проверенные факты расчёта.', { exact: true }).waitFor();
    await assistant.locator('#question').fill('А без них?');
    await assistant.getByRole('button', { name: 'Объяснить', exact: true }).click();
    await assistant.locator('#answer').getByText(/арифметика существующего разложения/).waitFor();
    await assistant.getByText('Предыдущие вопросы (1)', { exact: true }).waitFor();
    await assistant.getByRole('button', { name: 'Новый диалог', exact: true }).click();
    assert.equal(await assistant.locator('#answer').textContent(), '');
    await assistant.getByRole('button', { name: 'Сформировать аналитическое резюме', exact: true }).click();
    await assistant.getByRole('heading', { name: 'Аналитическое резюме', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await record(page, 'ai-summary-mobile', undefined, false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await record(page, 'ai-summary', undefined, false);
    const current = await (await page.request.get(origin + '/api/workspace')).json();
    const reportUrl = origin + `/api/export/${current.id}/reports/${current.report.analysisId}/analysis.json`;
    const report = await (await page.request.get(reportUrl)).json();
    assert.equal(report.unit, 'ед.');
    assert.equal(report.aiSummary.analysisId, report.analysisId);
    assert.equal(report.aiSummary.kind, 'summary');
    assert.equal((await (await page.request.get(reportUrl + '?includeSummary=0')).json()).aiSummary, null);
    await page.route('**/api/explain', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await route.fulfill({ json: { analysisId: report.analysisId, facts: [{ text: 'Устаревший ответ' }], mode: 'facts' } }).catch(() => {});
    });
    await assistant.getByRole('button', { name: 'Какие факторы главные?' }).click();
    await assistant.getByText('Ожидаем ответ по текущему расчёту…', { exact: true }).waitFor();
    await assistant.getByRole('button', { name: 'Отменить ожидание', exact: true }).click();
    await assistant.getByText('Ожидание отменено.', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'К обзору', exact: true }).click();
    await edit.click();
    await settings.locator('#from').selectOption('2026-05-25');
    await settings.getByRole('button', { name: 'Рассчитать вклады' }).click();
    await applied.getByText('25.05.2026 — 25.08.2026', { exact: true }).waitFor();
    const stale = await page.request.post(origin + '/api/explain', { data: {
      workspaceId: current.id, analysisId: report.analysisId, question: 'Почему изменился показатель?',
    } });
    assert.equal(stale.status(), 409);
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
  const preparationFailures = new Map();
  const preparationRetries = new Map();
  let unavailable = false;
  const service = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const day = url.searchParams.get('reportDate');
    const base = preparationFailures.has(day) ? undefined : ready.get(day);
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
      const body = request.method === 'POST' ? JSON.parse(Buffer.concat(data).toString()) : null;
      const selected = day ?? body.reportDate;
      if (body?.retry) {
        preparationRetries.set(selected, (preparationRetries.get(selected) ?? 0) + 1);
        const failures = preparationFailures.get(selected);
        if (failures === 0) preparationFailures.delete(selected);
        else if (failures > 0) preparationFailures.set(selected, failures - 1);
      }
      if (preparationFailures.has(selected)) return reply(200, {
        reportDate: selected, status: 'failed', runId: null, errorCode: 'SOURCE_UNAVAILABLE',
      });
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
      runs: preparationFailures.has(day) ? [] : [...runs.values()].filter(run => run.reportDate === day).map(run => state(run)) });
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
    original: ready.get(reportDate).runId, fail: () => { unavailable = true; },
    failPreparation: (day, count) => preparationFailures.set(day, count),
    retries: day => preparationRetries.get(day) ?? 0 };
}

test('embedded curves share the shell and pin a validated run to portfolio valuation', { timeout: 110_000 }, async () => {
  const date = '2026-08-25';
  const upstream = await contractServer(date);
  const data = await mkdtemp(join(tmpdir(), 'spectrum-embedded-'));
  const prebuilt = process.env.SPECTRUM_TEST_CURVE_ASSETS;
  const env = { ...process.env, SPECTRUM_DATA_DIR: data, SPECTRUM_CURVES_DIR: join(data, 'curves-cache'),
    SPECTRUM_LLM_ENABLED: '0', DEEPSEEK_API_KEY: '',
    SPECTRUM_CURVES_URL: upstream.url, SPECTRUM_CURVE_ASSETS: prebuilt || join(data, 'curve-ui') };
  let browser, server;
  try {
    if (!prebuilt) execFileSync(python, ['-m', 'service.curve_ui'], { env, timeout: 40_000 });
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
    upstream.failPreparation(date, 0);
    await page.goto(origin + '/#curves?reportDate=' + date);
    assert.equal((await page.request.get(origin + '/curve-ui/curves.js')).status(), 200, 'native startup must provide the embedded entry');
    assert.equal((await page.request.get(origin + '/curve-ui/curves.css')).status(), 200, 'native startup must provide the embedded stylesheet');
    await heading.waitFor();
    const curveFailure = page.locator('.curve-preparation-error');
    await curveFailure.getByRole('alert').filter({ hasText: 'Источник MOEX временно недоступен' }).waitFor();
    await curveFailure.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await use.waitFor();
    assert.equal(upstream.retries(date), 1);
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
    await recordThemes(page, '11-moex-no-publication');
    await page.getByRole('button', { name: /^Отчётная дата/ }).click();
    await dayPicker.locator('[data-date="2026-08-25"]').click();
    await use.waitFor();
    await page.getByRole('button', { name: 'Общий рост ставок', exact: true }).click();
    assert.equal(await graph.locator('polyline').count(), 2);
    const curveAssistant = page.locator('#assistant-drawer');
    await page.getByRole('button', { name: 'Спросить AI', exact: true }).click();
    await curveAssistant.getByText('Общий рост ставок', { exact: true }).waitFor();
    await curveAssistant.getByRole('button', { name: 'Что означают P, K и D?' }).click();
    await curveAssistant.locator('#answer').getByText(/P = 4,00, K = 5,00, D = 3,00/).waitFor();
    await page.getByRole('button', { name: 'Общее снижение ставок', exact: true }).click();
    await curveAssistant.getByText('Общее снижение ставок', { exact: true }).waitFor();
    assert.equal(await curveAssistant.locator('#answer').textContent(), '');
    await page.getByRole('button', { name: 'Общее снижение ставок', exact: true }).click();
    await curveAssistant.locator('#answer').getByText(/P = 4,00, K = 5,00, D = 3,00/).waitFor();
    await curveAssistant.locator('#question').focus();
    await page.keyboard.press('Escape');
    await curveAssistant.waitFor({ state: 'hidden' });
    await graph.locator('.curve-chart__hit').first().focus();
    await page.getByRole('tooltip').filter({ hasText: 'Общий рост ставок' }).waitFor();
    await graph.locator('.curve-chart__hit').first().press('Enter');
    await page.getByRole('tooltip').getByText('Закреплено · Esc для сброса').waitFor();
    await graph.locator('.curve-chart__hit').first().press('Escape');
    await page.getByRole('button', { name: 'Показать исходную MOEX' }).click();
    await page.getByText('К расчётным кривым', { exact: true }).click();
    await page.getByRole('tab', { name: 'Таблица', exact: true }).click();
    const rates = page.getByRole('region', { name: 'Таблица ставок с прокруткой', exact: true });
    assert.equal(await rates.getByRole('row').count(), 24);
    const headerGeometry = await rates.evaluate(region => {
      const header = region.querySelector('thead');
      const cell = header.querySelector('th');
      const fits = header.scrollHeight <= header.clientHeight + 1;
      const before = cell.getBoundingClientRect();
      region.scrollTop = 180;
      const after = cell.getBoundingClientRect();
      const scrolled = region.scrollTop > 0 && Math.abs(before.top - after.top) < 1;
      region.scrollTop = 0;
      return { fits, scrolled };
    });
    assert.deepEqual(headerGeometry, { fits: true, scrolled: true });
    const curveDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать CSV' }).click();
    assert.match((await curveDownload).suggestedFilename(), /\.csv$/);
    await page.getByRole('tab', { name: 'График', exact: true }).click();
    await noOverflow(page, [[1440, 900], [390, 844], [320, 720]]);
    await page.setViewportSize({ width: 390, height: 844 });
    await record(page, '09-curves-mobile');
    await page.setViewportSize({ width: 1440, height: 900 });
    await recordThemes(page, '09-curves-contract');
    await page.locator('#curve-screen').evaluate(host => { host.shadowRoot.querySelector('.curve-app').dataset.mountCheck = 'retained'; });
    await page.getByRole('link', { name: 'Данные', exact: true }).click();
    await page.goBack();
    await use.waitFor();
    assert.equal(await page.locator('.curve-app').getAttribute('data-mount-check'), 'retained');

    await use.click();
    await page.getByLabel('Сделок на старте', { exact: true }).fill('30');
    await page.getByLabel('Число отчётных дат').fill('4');
    await page.getByLabel('Новых сделок в месяц').fill('2');
    const stalledDay = '2026-06-30';
    const recoveringDay = '2026-07-31';
    upstream.failPreparation(stalledDay, 1);
    upstream.failPreparation(recoveringDay, 0);
    const submitted = () => page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/run'));
    const initialRequest = submitted();
    await page.getByRole('button', { name: 'Создать тестовый портфель', exact: true }).click();
    const portfolioFailure = page.locator('#portfolio-progress');
    await portfolioFailure.getByRole('alert').waitFor({ timeout: 20_000 });
    assert.match(await portfolioFailure.getByRole('alert').textContent(), /30\.06\.2026.*MOEX временно недоступен/);
    await recordThemes(page, '11-moex-retry');
    assert.equal(upstream.retries(stalledDay), 1);
    const retryRequest = submitted();
    await portfolioFailure.getByRole('button', { name: 'Повторить расчёт', exact: true }).click();
    assert.deepEqual((await retryRequest).postDataJSON(), (await initialRequest).postDataJSON());
    await page.getByRole('heading', { name: 'Состав портфеля', exact: true }).waitFor({ timeout: 40_000 });
    assert.equal(upstream.retries(stalledDay), 2);
    assert.equal(upstream.retries(recoveringDay), 1);
    const old = await workspace();
    assert.equal(old.periods.at(-1).runId, upstream.original);
    assert.equal(old.periods.at(-1).curveSource, 'pinned');
    assert.equal(new Set(old.periods.map(period => period.runId)).size, 4);
    await page.getByRole('table', { name: 'Найденные сделки' }).getByRole('button').first().click();
    const deal = page.locator('#inspector');
    await deal.getByText('Валюта', { exact: true }).waitFor();
    await deal.getByRole('img', { name: 'Договорные платежи по датам' }).waitFor();
    await deal.getByText('PV по стрессовым сценариям', { exact: true }).click();
    assert.equal(await deal.getByRole('table', { name: 'PV по стрессовым сценариям' }).getByRole('row').count(), 7);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Сценарии', exact: true }).click();
    await page.getByRole('link', { name: 'Открыть использованные кривые' }).click();
    await page.getByRole('heading', { name: 'Кривые из оценки портфеля' }).waitFor();
    await graph.waitFor();
    await page.getByRole('button', { name: 'Спросить AI', exact: true }).click();
    await curveAssistant.getByRole('button', { name: 'Откуда взяты кривые?' }).click();
    await curveAssistant.locator('#answer').getByText(/Архивный снимок портфеля/).waitFor();
    await page.keyboard.press('Escape');
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
