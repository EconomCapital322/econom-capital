import { day, esc } from './charts.mjs';
import { animateCharts, captureCharts, installChartInteraction, updateChartPlot } from './chart-interaction.mjs';
import { assistantDock } from './assistant-dock.mjs';
import { commandPalette } from './command-palette.mjs';
import { animateContent, captureIndicators, installLighting, installPanels, motionAllowed, openPanel, settleChartTransition, syncIndicators, transitionChart } from './motion.mjs';
import { analysisChart, analysisPage, analysisTab, assistantConversation, assistantPanel, assistantStatus, comparisonPanel,
  codes, dataPage, dateCountLabel, dealTable, factorDetails, flowDialog, holdingsDateNote, holdingsOverview, methodologyContent, metricName, pages, portfolioCurveNote, portfolioPage,
  portfolioPreview, portfolioProgress, portfolioSources, reportTabs, scenarioPage, servicesList, titleOf, uploadBox } from './views.mjs';

const main = document.querySelector('#content');
const studioScreen = document.querySelector('#studio-screen');
const curveScreen = document.querySelector('#curve-screen');
const activity = document.querySelector('#activity');
const inspector = document.querySelector('#inspector');
const drawer = document.querySelector('#factor-drawer');
const assistant = document.querySelector('#assistant-drawer');
const dock = assistantDock(assistant, document.querySelector('#assistant-restore'));
const settings = document.querySelector('#settings-dialog');
const appearance = document.querySelector('#appearance-dialog');
const palette = document.querySelector('#command-palette');
const chartFocus = document.querySelector('#chart-focus');
const root = document.documentElement;
const locationLabel = document.querySelector('#page-location');
const workspaceContext = document.querySelector('#workspace-context');
const serviceLink = document.querySelector('.service-link');
const { hide: hideChartTooltip, restore: restoreChartViews } = installChartInteraction(document);
installPanels();
installLighting();

const state = {
  workspace: null, route: 'analysis', tab: 'timeline', factor: null, effect: null, effectPlot: 'ale', scenarioCode: null,
  scenarioDay: null, portfolioDay: null, dealQuery: '', dealPage: 0, draft: null, answer: null,
  mapping: null, preview: null, comparison: null, pair: null, pairDeal: null, health: null, generating: false,
  chart: 'waterfall', research: false, portfolioTab: 'builder', portfolioJob: null, sourceFormat: 'csv',
  question: '', assistantFactor: null, allowExternal: false, asking: false, assistantMessage: '',
  assistantContext: null, dialogId: null, turns: [], summary: null,
  curveSelection: null,
};
const conversations = new Map();
let curvesContext = null;
let dealsRequest = 0;
let flowRequest = 0;
let healthTimer;
let explanationRequest, mappingRequest;
let afterNavigation;
let curveModule, curveLoading, curveLocation;

async function api(path, { body, ...options } = {}) {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), ...options,
  } : options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Сервер не выполнил запрос.');
  return result;
}

function notice(message, kind = '', value = null) {
  activity.innerHTML = message ? `<div class="status ${kind} ${value ? 'job' : ''}" role="${kind === 'error' ? 'alert' : 'status'}">
    <span>${esc(message)}</span>${value ? `<progress aria-label="Готовность расчёта" value="${value.done}" max="${value.total}"></progress>` : ''}</div>` : '';
}

function updatePortfolioJob(job) {
  state.portfolioJob = job;
  const host = document.querySelector('#portfolio-progress');
  if (host) host.innerHTML = portfolioProgress(job);
  syncBusy();
}

function syncBusy() {
  root.toggleAttribute('data-calculating', state.generating);
}

function routeName() {
  const route = location.hash.slice(1).split('?')[0];
  return Object.hasOwn(pages, route) ? route : 'analysis';
}

function readAnalysisLocation() {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  state.research = query.get('view') === 'details';
  const tab = query.get('tab');
  if (state.research && Object.hasOwn(reportTabs(state.workspace), tab)) state.tab = tab;
}

const analysisLocation = () => state.research ? 'analysis?view=details&tab=' + state.tab : 'analysis';

function curveRoute() {
  const params = new URLSearchParams(location.hash.split('?')[1]);
  const reportDate = params.get('reportDate');
  const workspaceId = params.get('workspaceId');
  const runId = params.get('runId') || undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    return { reportDate, runId, workspaceId: /^[a-f0-9]{32}$/.test(workspaceId) ? workspaceId : undefined };
  }
  return curveLocation ?? {
    reportDate: state.workspace?.periods?.at(-1)?.date ??
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()),
  };
}

function showCurveLocation(next) {
  if (!next.workspaceId) curveLocation = next;
  const hash = new URLSearchParams({ reportDate: next.reportDate });
  if (next.runId) hash.set('runId', next.runId);
  if (next.workspaceId) hash.set('workspaceId', next.workspaceId);
  history.replaceState(history.state, '', '#curves?' + hash);
  renderCurves(true);
  syncDockContext();
}

function selectCurveRun(reportDate, runId) {
  if (curveLocation?.reportDate !== reportDate) return;
  curveLocation = { reportDate, runId };
  if (state.route === 'curves' && !curveRoute().workspaceId) showCurveLocation(curveLocation);
}

function useCurve(selection) {
  state.curveSelection = selection;
  const period = state.workspace?.periods?.find((p) => p.date === selection.reportDate);
  if (period) {
    state.portfolioTab = 'holdings';
    state.portfolioDay = period.date;
  } else {
    state.portfolioTab = 'builder';
    state.draft = { ...state.draft, valuationDate: selection.reportDate, curveSource: 'api' };
  }
  navigate('portfolio');
}

function renderCurves(active) {
  const selection = active ? curveRoute() : curveLocation;
  if (active && !selection.workspaceId) curveLocation = selection;
  if (curveModule) {
    const location = selection ?? curveRoute();
    curveModule.update({ active, location,
      valuationRunId: state.workspace?.periods?.find((p) => p.date === location.reportDate)?.runId,
      onLocation: showCurveLocation, onRunSelect: selectCurveRun, onUse: useCurve,
      onExplain: (curve) => openAssistant(null, curve, curveScreen.shadowRoot?.activeElement),
      onContext: (curve) => {
        curvesContext = curve;
        if (state.route === 'curves') syncDockContext();
      } });
  } else if (active && !curveLoading) {
    curveLoading = import('/curve-ui/curves.js').then(({ mountCurves }) => {
      curveScreen.replaceChildren();
      curveModule = mountCurves(curveScreen);
      renderCurves(state.route === 'curves');
    }).catch(() => {
      curveScreen.innerHTML = '<h1>Кривые доходности</h1><p class="status error" role="alert">Не удалось загрузить интерфейс кривых. Перезапустите «Спектр» и обновите страницу.</p>';
    });
  }
}

function swapWorkspace(workspace) {
  explanationRequest?.abort();
  mappingRequest?.abort();
  dealsRequest++;
  flowRequest++;
  closeDialogs();
  conversations.clear();
  if (!assistant.open && !dock.minimized()) assistant.replaceChildren();
  settings.replaceChildren();
  state.workspace = workspace;
  state.tab = 'timeline';
  state.pair = null;
  state.pairDeal = null;
  state.comparison = null;
  state.research = false;
  state.preview = null;
  state.factor = null;
  state.effect = null;
  state.effectPlot = 'ale';
  state.answer = null;
  state.mapping = null;
  state.question = '';
  state.assistantFactor = null;
  state.assistantContext = null;
  state.dialogId = null;
  state.turns = [];
  state.summary = null;
  state.assistantMessage = '';
  state.allowExternal = false;
  state.asking = false;
  state.sourceFormat = workspace?.periods ? 'zip' : 'csv';
}

function render() {
  settleChartTransition();
  syncBusy();
  for (const anchor of document.querySelectorAll('[data-route]')) {
    if (anchor.dataset.route === state.route) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  locationLabel.textContent = state.route === 'analysis' ? 'Анализ' : '';
  locationLabel.hidden = state.route !== 'analysis';
  const portfolioType = state.workspace?.periods ? portfolioSources[state.workspace.portfolioSource] ?? 'Загруженный портфель'
    : state.workspace?.filename;
  const dateCount = state.workspace?.periods?.length;
  workspaceContext.textContent = portfolioType ? portfolioType + (dateCount ? ` · ${dateCountLabel(dateCount)}` : '') : '';
  workspaceContext.hidden = !portfolioType;
  hideChartTooltip();
  const curvesActive = state.route === 'curves';
  curveScreen.hidden = !curvesActive;
  studioScreen.hidden = curvesActive;
  renderCurves(curvesActive);
  syncIndicators(document.querySelector('.navigation-shell'));
  if (curvesActive) { syncDockContext(); return; }
  const previousIndicators = captureIndicators(studioScreen);
  const previousCharts = motionAllowed() ? captureCharts(studioScreen) : null;
  studioScreen.innerHTML = { analysis: analysisPage, scenarios: scenarioPage, portfolio: portfolioPage, data: dataPage }[state.route](state);
  syncIndicators(studioScreen, previousIndicators);
  if (previousCharts) animateCharts(studioScreen, previousCharts);
  restoreChartViews(studioScreen);
  if (state.route === 'portfolio') void loadDeals();
  syncDockContext();
}

function closeDialogs() {
  for (const dialog of [inspector, drawer, assistant, settings, appearance, palette, chartFocus]) {
    if (dialog === assistant && dock.isDocked()) continue;
    if (dialog.open) dialog.close();
  }
}

function navigate(route, enter) {
  const hash = '#' + (route === 'analysis' ? analysisLocation() : route);
  if (state.route === route) {
    if (location.hash !== hash) history.pushState(history.state, '', hash);
    render();
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
    enter?.();
  } else {
    afterNavigation = enter ? { route, enter } : null;
    location.hash = hash;
  }
}

function openSettings(source) {
  if (!state.workspace?.report) return;
  const previous = captureIndicators(settings);
  settings.innerHTML = comparisonPanel(state);
  openPanel(settings, source);
  syncIndicators(settings, previous);
}

function assistantScope(factor, curve) {
  const work = state.workspace;
  const report = work?.report;
  const page = state.route;
  const scope = { page, workspaceId: work?.id ?? null, analysisId: report?.analysisId ?? null };
  let title = pages[page], subtitle = '', reportLabel = '';
  if (page === 'analysis') {
    if (!report) return null;
    scope.focusFactor = factor?.key ?? null;
    title = factor?.label ?? metricName(work);
    subtitle = day(report.before) + ' — ' + day(report.after);
    reportLabel = [metricName(work), report.mode === 'valuation' ? 'Расчётный анализ' : 'ML-анализ'].join(' · ');
    if (!factor && state.research && state.tab === 'effects' && report.effects?.length) {
      const selected = report.effects.find(item => item.key === state.effect)
        ?? report.effects.find(item => item.points?.length) ?? report.effects[0];
      scope.analysisFocus = { kind: 'effect', item: selected.key };
      title = titleOf(work, selected.key);
    }
    if (!factor && state.research && state.tab === 'interactions' && report.interactions?.length) {
      const item = state.pair ?? 0;
      const selected = report.interactions[item];
      if (selected) {
        scope.analysisFocus = { kind: 'interaction', item };
        title = titleOf(work, selected.a) + ' × ' + titleOf(work, selected.b);
      }
    }
  } else if (page === 'curves') {
    if (!curve) return null;
    scope.curveRef = { reportDate: curve.reportDate, runId: curve.runId };
    scope.curveWorkspaceId = curve.workspaceId ?? null;
    scope.scenario = curve.scenario;
    title = codes[curve.scenario] ?? title;
    subtitle = day(curve.reportDate) + (curve.workspaceId ? ' · Снимок оценки' : ' · Готовый запуск');
  } else if (page === 'data') {
    if (!work?.profile) return null;
    subtitle = 'Профиль загруженного набора';
  } else {
    if (!work?.periods?.length) return null;
    scope.reportDate = (page === 'scenarios' ? state.scenarioDay : state.portfolioDay) ?? work.periods.at(-1).date;
    if (page === 'scenarios') {
      scope.scenario = document.querySelector('[data-action="scenario"][aria-pressed="true"]')?.dataset.key;
      title = codes[scope.scenario] ?? title;
    }
    subtitle = day(scope.reportDate);
  }
  if (page === 'analysis' && title === metricName(work)) reportLabel = reportLabel.split(' · ').at(-1);
  return { ...scope, key: JSON.stringify(scope), title, subtitle, reportLabel };
}

function setAssistantContext(context) {
  if (state.assistantContext?.key === context?.key && assistant.firstElementChild
    && assistant.dataset.contextReady === String(Boolean(context))) return false;
  const previous = state.assistantContext;
  if (previous) {
    conversations.delete(previous.key);
    conversations.set(previous.key, {
      turns: state.turns, answer: state.answer, dialogId: state.dialogId,
      question: state.question, scroll: assistant.querySelector('.drawer-body')?.scrollTop ?? 0,
    });
    if (conversations.size > 16) conversations.delete(conversations.keys().next().value);
  }
  explanationRequest?.abort();
  explanationRequest = null;
  const saved = conversations.get(context?.key);
  state.asking = false;
  state.assistantMessage = '';
  state.dialogId = saved?.dialogId ?? null;
  state.turns = saved?.turns ?? [];
  state.answer = saved?.answer ?? null;
  state.question = saved?.question ?? '';
  state.allowExternal = false;
  state.assistantContext = context;
  if (context?.page === 'analysis' && state.summary?.analysisId !== context.analysisId) state.summary = null;
  assistant.innerHTML = assistantPanel(state);
  assistant.dataset.contextReady = String(Boolean(context));
  dock.resize();
  if (saved?.scroll) assistant.querySelector('.drawer-body').scrollTop = saved.scroll;
  if (context?.page === 'analysis' && !state.summary) {
    void api('/api/summary/' + context.workspaceId + '/' + context.analysisId).then((response) => {
      if (response && state.assistantContext?.key === context.key && !state.summary) {
        state.summary = response;
        refreshAnswer();
      }
    }).catch(() => {});
  }
  return true;
}

function currentCurveContext() {
  const routeCurve = state.route === 'curves' ? curveRoute() : null;
  const matchingCurve = routeCurve && curvesContext?.reportDate === routeCurve.reportDate
    && (!routeCurve.runId || curvesContext.runId === routeCurve.runId)
    && (curvesContext.workspaceId ?? null) === (routeCurve.workspaceId ?? null);
  return matchingCurve ? curvesContext : null;
}

function syncDockContext() {
  if ((!assistant.open || !dock.isDocked()) && !dock.minimized()) return;
  const selectedFactor = state.route === 'analysis' && (!state.research || state.tab === 'contributions')
    ? state.assistantFactor : null;
  setAssistantContext(assistantScope(selectedFactor, currentCurveContext()));
}

function openAssistant(factor = null, curve = null, source) {
  const context = assistantScope(factor, curve);
  if (!context) return;
  state.assistantFactor = factor;
  const changed = setAssistantContext(context);
  const wasOpen = assistant.open;
  dock.open(source);
  if (changed || !wasOpen) animateContent(assistant.querySelector('.assistant-context'));
}

function refreshAssistant() {
  const status = document.querySelector('#assistant-status');
  if (status) status.innerHTML = assistantStatus(state);
  const consent = document.querySelector('#assistant-consent');
  if (consent) consent.hidden = state.health?.ai?.provider !== 'deepseek' || !state.health?.llm;
}

async function updateHealth() {
  try {
    state.health = await api('/api/services');
  } catch {
    state.health = { ai: { provider: 'facts' }, llm: false, unavailable: true };
  }
  const host = document.querySelector('#services');
  if (host) host.innerHTML = servicesList(state.health);
  serviceLink.dataset.online = String(Boolean(state.health.calculator && state.health.curves));
  serviceLink.title = state.health.calculator && state.health.curves ? 'Калькулятор и кривые доступны' : 'Проверить подключения';
  refreshAssistant();
}

function selectFactor(key, source) {
  if (!state.workspace?.report) return;
  const wasOpen = drawer.open;
  const selectedInDrawer = drawer.contains(document.activeElement);
  const controlId = document.activeElement?.id;
  state.factor = key;
  if (chartFocus.open) {
    source = source?.getBoundingClientRect?.() ?? source;
    chartFocus.close();
  }
  const adjacent = assistant.open && dock.isDocked();
  drawer.toggleAttribute('data-adjacent', adjacent);
  if (wasOpen && drawer.matches(':modal') === adjacent) drawer.close();
  drawer.innerHTML = factorDetails(state);
  state.assistantFactor = { key, label: drawer.querySelector('#factor-title').textContent.trim() };
  for (const control of document.querySelectorAll('[data-action="factor"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.key === key));
  }
  if (!drawer.open) openPanel(drawer, source, { modal: !adjacent });
  else if (selectedInDrawer) drawer.querySelector(controlId === 'factor-select' ? '#factor-select' : '.drawer-head button')?.focus({ preventScroll: true });
  syncDockContext();
}

function selectChart(chart, control) {
  if (!['contributions', 'waterfall'].includes(chart)) return;
  state.chart = chart;
  control.dataset.key = chart === 'waterfall' ? 'contributions' : 'waterfall';
  control.textContent = chart === 'waterfall' ? 'К вкладам' : 'Водопад';
  const host = document.querySelector('#bridge-chart');
  transitionChart(host, () => {
    if (!host.isConnected) return;
    hideChartTooltip();
    host.innerHTML = analysisChart(state);
  });
}

function applyComparison(form, rerender) {
  state.comparison = Object.fromEntries(new FormData(form));
  if (rerender) openSettings();
}

function selectTab(tab, focus = false) {
  if (!Object.hasOwn(reportTabs(state.workspace), tab)) return;
  const target = document.querySelector('#tab-body');
  if (!target || !state.workspace?.report) return;
  if (state.tab !== tab) state.assistantFactor = null;
  state.tab = tab;
  if (state.research) history.replaceState(history.state, '', '#' + analysisLocation());
  hideChartTooltip();
  target.innerHTML = analysisTab(state);
  restoreChartViews(target);
  for (const control of document.querySelectorAll('[data-action="tab"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.key === tab));
    if (focus && control.dataset.key === tab) control.focus({ preventScroll: true });
  }
  syncIndicators(target.parentElement);
  // Animate the heading so the interactive content keeps a stable hit area.
  const heading = focus && target.querySelector('h2');
  if (heading) animateContent(heading);
  syncDockContext();
}

const openCommands = commandPalette(palette, (source) => {
  const appearanceCommand = (key, value, title, keywords) => ({ title, group: 'Внешний вид', keywords,
    run: () => document.dispatchEvent(new CustomEvent('spectrum-appearance', { detail: { key, value } })) });
  const commands = Object.entries(pages).map(([route, name]) => ({
    title: 'Открыть ' + ({ analysis: 'анализ', curves: 'кривые доходности', scenarios: 'сценарии', portfolio: 'портфель', data: 'данные' }[route]),
    group: 'Разделы', keywords: name, run: () => navigate(route),
  }));
  if (state.workspace?.report && !state.generating) {
    commands.push({ title: 'Изменить параметры анализа', group: 'Расчёт', keywords: 'метрика период даты',
      run: () => openSettings(source) });
    commands.push({ title: state.research ? 'К обзору' : 'Подробный анализ', group: 'Анализ',
      run: () => { state.research = !state.research; navigate('analysis'); } });
  }
  const assistantButton = [...main.querySelectorAll('[data-action="open-assistant"]')].find((button) => !button.closest('[hidden]'));
  if (dock.minimized()) commands.push({ title: 'Восстановить AI', group: 'Помощник', run: () => { syncDockContext(); dock.open(source); } });
  else if (assistantButton || currentCurveContext()) {
    commands.push({ title: 'Спросить AI', group: 'Помощник', keywords: 'ии ассистент',
      run: () => openAssistant(null, currentCurveContext(), source) });
  }
  commands.push(
    { title: 'Настроить внешний вид', group: 'Внешний вид', run: () => openPanel(appearance, source) },
    appearanceCommand('theme', 'light', 'Светлая тема', 'light'),
    appearanceCommand('theme', 'dark', 'Тёмная тема', 'dark'),
    appearanceCommand('theme', 'system', 'Системная тема', 'system'),
    appearanceCommand('density', 'compact', 'Компактная плотность', 'compact'),
    appearanceCommand('density', 'comfortable', 'Комфортная плотность', 'comfortable'),
  );
  return commands;
});

const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const rememberedJob = () => {
  try {
    const saved = sessionStorage.getItem('spectrum-job');
    return saved?.startsWith('{') ? JSON.parse(saved) : saved ? { id: saved, kind: 'report' } : null;
  } catch { return null; }
};
const remember = (job) => {
  try {
    if (job) sessionStorage.setItem('spectrum-job', JSON.stringify(job));
    else sessionStorage.removeItem('spectrum-job');
  } catch { /* Running in a browser with storage disabled is supported. */ }
};

async function followJob(id, kind = 'report', portfolioSettings = null) {
  remember({ id, kind, portfolioSettings });
  try {
    let errors = 0;
    for (;;) {
      let job;
      try {
        job = await api('/api/job/' + id);
        errors = 0;
      } catch (error) {
        if (++errors === 3) throw error;
        await pause(700);
        continue;
      }
      if (job.state === 'ready') {
        const latest = await api('/api/workspace');
        if (latest?.report?.analysisId !== job.analysisId) throw new Error('Открыт другой отчёт. Обновите страницу.');
        state.generating = false;
        if (kind === 'diagnostics' && state.workspace?.report?.analysisId === latest.report.analysisId) {
          state.workspace = latest;
          if (state.route === 'analysis') selectTab(state.tab);
          const method = document.querySelector('#methodology-body');
          if (method) method.innerHTML = methodologyContent(latest);
          if (drawer.open) selectFactor(state.factor);
        } else {
          swapWorkspace(latest);
          state.scenarioCode = null;
          state.scenarioDay = null;
          state.portfolioDay = null;
          state.dealPage = 0;
          state.dealQuery = '';
          if (kind === 'portfolio') {
            if (latest.periods.some((p) => p.date === state.curveSelection?.reportDate && p.runId === state.curveSelection.runId)) {
              state.portfolioDay = state.curveSelection.reportDate;
              state.curveSelection = null;
            }
            updatePortfolioJob({ ...job, message: 'Портфель рассчитан. Можно открыть договорные платежи и факторный анализ.' });
            state.portfolioTab = 'holdings';
            navigate('portfolio');
          } else navigate('analysis');
        }
        notice('');
        return true;
      }
      if (job.state === 'failed') {
        if (portfolioSettings) {
          updatePortfolioJob({ ...job, retrySettings: portfolioSettings });
          notice(state.route === 'portfolio' ? '' : job.message, 'error');
          return false;
        }
        throw new Error(job.message);
      }
      if (kind === 'portfolio') updatePortfolioJob(job);
      if (kind !== 'portfolio' || state.route !== 'portfolio') notice(job.message, '', job);
      else notice('');
      await pause(350);
    }
  } catch (error) {
    if (kind === 'portfolio') updatePortfolioJob(null);
    notice(error.message, 'error');
    return false;
  } finally {
    remember(null);
    void updateHealth();
  }
}

async function launch(path, body, message, kind = 'report') {
  if (state.generating) return false;
  state.generating = true;
  syncBusy();
  if (kind !== 'diagnostics') {
    if (state.asking) stopWaiting();
    mappingRequest?.abort();
  }
  const initiating = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  const locked = [...main.querySelectorAll('button[type="submit"], [data-action="diagnostics"], [data-action="change-mode"]'),
    ...settings.querySelectorAll('button[type="submit"]'),
    ...drawer.querySelectorAll('[data-action="diagnostics"]')]
    .map((control) => [control, control.disabled]);
  for (const [control] of locked) control.disabled = true;
  initiating?.setAttribute('aria-busy', 'true');
  notice(message);
  try {
    const { job } = await api(path, { body });
    return await followJob(job, kind, path === '/api/run' ? body : null);
  } catch (error) {
    notice(error.message, 'error');
    return false;
  } finally {
    state.generating = false;
    syncBusy();
    initiating?.removeAttribute('aria-busy');
    for (const [control, previous] of locked) {
      if (control.isConnected) control.disabled = previous;
    }
    const submit = settings.querySelector('#compare-form button[type="submit"]');
    if (submit) submit.disabled = false;
  }
}

async function generate(form) {
  if (state.generating) return;
  const settings = Object.fromEntries(new FormData(form));
  for (const key of ['count', 'monthly', 'periods', 'liabilityShare']) settings[key] = Number(settings[key]);
  settings.useSavedCurves = settings.curveSource === 'saved';
  settings.demoCurves = settings.curveSource === 'fixture';
  if (settings.curveSource === 'api' && state.curveSelection) settings.curveSelection = state.curveSelection;
  await runPortfolio(settings);
}

async function runPortfolio(settings) {
  if (state.generating) return;
  state.draft = settings;
  updatePortfolioJob(null);
  await launch('/api/run', settings, 'Запускаем совместный расчёт.', 'portfolio');
}

async function revaluePortfolio() {
  const work = state.workspace;
  if (!work?.report || !state.curveSelection) return;
  await launch('/api/revalue', { workspaceId: work.id, analysisId: work.report.analysisId, curveSelection: state.curveSelection },
    'Готовим переоценку по выбранным кривым.', 'portfolio');
}

function settingsFrom(form, config) {
  const work = state.workspace;
  const fields = new FormData(form);
  const saved = work.report?.settings ?? {};
  const body = { ...saved, workspaceId: work.id, analysisId: work.report?.analysisId,
    dateColumn: fields.get('dateColumn') ?? work.options.dateColumn,
    idColumn: fields.get('idColumn') ?? work.options.idColumn,
    unit: fields.get('unit') ?? work.options.unit ?? '', aggregation: fields.get('aggregation') ?? 'sum',
    target: fields.get('target'), mode: config ? 'ml' : fields.get('mode') ?? 'ml',
    before: fields.get('before'), after: fields.get('after'), scenario: fields.get('scenario') || (config ? work.scenario : 'base') };
  if (config) body.features = fields.getAll('feature');
  return body;
}

async function analyze(form, config = false) {
  if (!state.workspace || state.generating) return;
  const body = { ...settingsFrom(form, config), background: true };
  if (!config) {
    applyComparison(form, false);
    settings.close();
  }
  await launch('/api/analyze', body, body.mode === 'valuation' ? 'Проверяем выгрузки и рассчитываем вклады.' : 'Подбираем модель и проверяем её на датах сравнения.');
}

async function changeReportMode(mode) {
  const work = state.workspace, report = work?.report;
  if (state.generating || !work?.periods || !report || report.mode === mode || !['valuation', 'ml'].includes(mode)) return;
  const targets = mode === 'valuation' ? ['npv', 'stress_delta'] : work.options.targets;
  const target = targets.includes(report.target) ? report.target : targets[0];
  const scenario = target === 'stress_delta' ? report.scenario ?? work.scenario ?? 'parallel_up' : 'base';
  const { before, after } = report;
  const accepted = await launch('/api/analyze', { workspaceId: work.id, analysisId: report.analysisId,
    mode, target, before, after, scenario, background: true },
  mode === 'valuation' ? 'Проверяем выгрузки и рассчитываем вклады.' : 'Подбираем модель для открытого периода.');
  if (!accepted && state.workspace === work) document.querySelector('[data-action="change-mode"][aria-pressed="true"]')?.focus({ preventScroll: true });
}

async function checkMapping(form) {
  mappingRequest?.abort();
  const request = new AbortController();
  mappingRequest = request;
  const work = state.workspace;
  const body = settingsFrom(form, true);
  try {
    const preview = await api('/api/profile', { body, signal: request.signal });
    if (request.signal.aborted || work !== state.workspace || state.route !== 'data') return;
    state.preview = preview;
    state.mapping = { ...body, before: preview.before, after: preview.after };
    notice(preview.message);
    refreshMapping();
  } catch (error) {
    if (!request.signal.aborted) notice(error.message, 'error');
  }
}

async function importCsv(form) {
  if (state.generating) return;
  const file = new FormData(form).get('csvfile');
  if (!file?.size) return;
  const button = form.querySelector('button');
  button.disabled = true;
  form.querySelector('[data-file-warning]').hidden = true;
  state.generating = true;
  syncBusy();
  if (state.asking) stopWaiting();
  mappingRequest?.abort();
  notice('Проверяем историю из CSV.');
  try {
    if (file.size > 6_000_000) throw new Error('Выберите CSV размером до 6 МБ.');
    swapWorkspace(await api('/api/import', { body: { filename: file.name, text: await file.text() } }));
    state.generating = false;
    notice('CSV загружен. Проверьте колонки и запустите анализ.');
    render();
  } catch (error) {
    importError(form, error.message);
  } finally {
    state.generating = false;
    syncBusy();
    button.disabled = false;
  }
}

async function importHistory(form) {
  if (state.generating) return;
  const values = new FormData(form);
  const file = values.get('history');
  if (!file?.size || file.size > 16_000_000) return importError(form, 'Выберите ZIP размером до 16 МБ.');
  form.querySelector('[data-file-warning]').hidden = true;
  try {
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const parts = [];
    for (let i = 0; i < fileBytes.length; i += 12_288) parts.push(btoa(String.fromCharCode(...fileBytes.subarray(i, i + 12_288))));
    await launch('/api/import-history', { archive: parts.join(''), provenance: values.has('bank') ? 'bank' : 'external' }, 'Проверяем историю из ZIP.');
  } catch (error) {
    importError(form, error.message);
  }
}

function importError(form, message) {
  if (!form.isConnected || form.closest('[hidden]')) return notice(message, 'error');
  notice('');
  const warning = form.querySelector('[data-file-warning]');
  warning.textContent = message;
  warning.hidden = false;
  const file = form.querySelector('input[type="file"]');
  file.setAttribute('aria-invalid', 'true');
  file.setAttribute('aria-describedby', file.id + '-selected ' + warning.id);
}

async function diagnostics() {
  const work = state.workspace;
  if (!work?.report?.analysisId) return false;
  const message = work.report.mode === 'valuation' ? 'Сверяем и раскладываем денежные потоки.' : 'Рассчитываем взаимодействия и форму эффектов.';
  return await launch('/api/diagnostics', { workspaceId: work.id, analysisId: work.report.analysisId }, message, 'diagnostics');
}

function stopWaiting(message = '') {
  explanationRequest?.abort();
  explanationRequest = null;
  state.asking = false;
  state.assistantMessage = message;
  const button = assistant.querySelector('#explain-form button[type="submit"]');
  if (button) button.disabled = false;
  refreshAnswer();
}

function newDialogue() {
  stopWaiting();
  state.turns = [];
  state.dialogId = null;
  state.answer = null;
  state.question = '';
  const field = assistant.querySelector('#question');
  if (field) {
    field.value = '';
    field.focus({ preventScroll: true });
  }
  refreshAnswer();
}

function refreshAnswer() {
  const host = assistant.querySelector('#answer');
  if (host) {
    host.setAttribute('aria-busy', String(state.asking));
    const details = [...host.querySelectorAll('details')].map((item) => [item.querySelector('summary').textContent, item.open]);
    host.innerHTML = assistantConversation(state);
    for (const item of host.querySelectorAll('details')) {
      item.open = details.some(([label, open]) => open && label === item.querySelector('summary').textContent);
    }
  }
  refreshAssistant();
}

async function ask(form, summary = false) {
  const context = state.assistantContext;
  if (!context || state.generating) return;
  const values = new FormData(form);
  const question = summary ? '' : String(values.get('question') || '').trim();
  if (!summary && !question) return;
  state.allowExternal = values.has('allowExternal');
  state.question = '';
  if (!summary) form.elements.question.value = '';
  state.assistantMessage = '';
  if (!summary) state.answer = null;
  explanationRequest?.abort();
  const controller = new AbortController();
  explanationRequest = controller;
  state.asking = true;
  form.querySelector('button[type="submit"]').disabled = true;
  refreshAnswer();
  try {
    const { key, title, subtitle, reportLabel, ...scope } = context;
    const answer = await api('/api/explain', { body: { ...scope, question, summary,
      dialogId: summary ? null : state.dialogId, allowExternal: state.allowExternal }, signal: controller.signal });
    if (controller.signal.aborted || state.assistantContext?.key !== key || answer.workspaceId !== scope.workspaceId
        || answer.analysisId !== scope.analysisId || answer.page !== scope.page) return;
    state.answer = answer;
    if (summary) {
      state.summary = answer;
    } else {
      state.dialogId = answer.dialogId;
      state.turns = [...state.turns, { question, answer }].slice(-5);
    }
  } catch (error) {
    if (!controller.signal.aborted) state.answer = { error: error.message };
  } finally {
    if (!controller.signal.aborted && explanationRequest === controller) {
      state.asking = false;
      explanationRequest = null;
      assistant.querySelector('#explain-form button[type="submit"]')?.removeAttribute('disabled');
      refreshAnswer();
    }
  }
}

async function loadDeals() {
  const panel = document.querySelector('#deal-table');
  const summary = document.querySelector('#holding-overview');
  const work = state.workspace;
  if (!panel || !work?.periods?.length) return;
  const serial = ++dealsRequest;
  const selected = document.querySelector('#portfolio-date').value;
  const holdings = document.querySelector('#portfolio-holdings');
  const loading = holdings.querySelector('[data-holdings-loading]');
  const dateChanged = holdings.dataset.date !== selected;
  const scroll = panel.querySelector('.table-wrap')?.scrollLeft;
  if (dateChanged) {
    loading.textContent = 'Загружаем сделки на ' + day(selected) + '…';
    loading.hidden = false;
    panel.inert = true;
    panel.setAttribute('aria-busy', 'true');
  }
  const params = new URLSearchParams({ date: selected, q: state.dealQuery, page: state.dealPage });
  if (dateChanged || !summary.children.length) params.set('overview', '1');
  try {
    const data = await api('/api/deals/' + work.id + '?' + params);
    if (panel.isConnected && serial === dealsRequest) {
      if (dateChanged) {
        const date = work.periods.find(period => period.date === selected);
        holdings.querySelector('[data-holdings-date]').textContent = holdingsDateNote(date);
        for (const link of holdings.querySelectorAll('a[href^="/api/export/"]')) {
          const path = link.getAttribute('href');
          link.setAttribute('href', path.replace('/' + holdings.dataset.date + '/', '/' + selected + '/'));
        }
        holdings.dataset.date = selected;
      }
      panel.innerHTML = dealTable(data);
      if (scroll) panel.querySelector('.table-wrap')?.scrollTo({ left: scroll });
      if (data.overview) {
        const expanded = summary.querySelector('details')?.open;
        summary.innerHTML = holdingsOverview(data.overview, work.periods);
        if (expanded) summary.querySelector('details').open = true;
      }
    }
  } catch (error) {
    if (panel.isConnected && serial === dealsRequest) panel.innerHTML = `<p class="status error">${esc(error.message)}</p>`;
  } finally {
    if (panel.isConnected && serial === dealsRequest) {
      loading.hidden = true;
      panel.inert = false;
      panel.removeAttribute('aria-busy');
      syncDockContext();
    }
  }
}

async function showFlows(id, source) {
  const work = state.workspace;
  const serial = ++flowRequest;
  const date = document.querySelector('#portfolio-date').value;
  inspector.dataset.kind = 'deal';
  inspector.innerHTML = `<header class="drawer-head"><h2 id="inspector-title">Платежи по сделке № ${esc(id)}</h2>
    <form method="dialog"><button class="button small">Закрыть</button></form></header>
    <div class="drawer-body"><p class="note" role="status">Загружаем договорные платежи…</p></div>`;
  openPanel(inspector, source);
  try {
    const data = await api('/api/flows/' + work.id + '?' + new URLSearchParams({ id, date }));
    if (serial !== flowRequest || !inspector.open || state.route !== 'portfolio' || work !== state.workspace) return;
    const wasFocused = inspector.contains(document.activeElement);
    inspector.innerHTML = flowDialog(data, work);
    if (wasFocused) inspector.querySelector('button')?.focus({ preventScroll: true });
  } catch (error) {
    if (serial === flowRequest && inspector.open && state.route === 'portfolio') {
      inspector.querySelector('.drawer-body').innerHTML = `<p class="status error" role="alert">${esc(error.message)}</p>`;
    }
  }
}

function fragment(html) {
  const view = document.createElement('template');
  view.innerHTML = html;
  return view.content;
}

function refreshMapping() {
  const next = fragment(dataPage(state));
  const setup = main.querySelector('#data-setup');
  const updated = next.querySelector('#data-setup');
  setup.querySelector('.panel-head').replaceWith(updated.querySelector('.panel-head'));
  main.querySelector('#data-quality .quality-grid').replaceWith(next.querySelector('.quality-grid'));
  for (const name of ['before', 'after']) {
    const control = setup.querySelector('[name="' + name + '"]');
    const replacement = updated.querySelector('[name="' + name + '"]');
    const value = replacement.value;
    control.replaceChildren(...replacement.children);
    control.value = value;
  }
  const features = setup.querySelector('.feature-list');
  const focused = features.contains(document.activeElement) ? document.activeElement.value : null;
  features.replaceChildren(...updated.querySelector('.feature-list').children);
  if (state.preview) features.closest('details').open = true;
  if (focused !== null) {
    const control = [...features.querySelectorAll('input')].find(input => input.value === focused);
    (control ?? features.closest('details').querySelector('summary')).focus({ preventScroll: true });
  }
  const buttons = updated.querySelectorAll('button');
  setup.querySelectorAll('button').forEach((button, index) => { button.disabled = buttons[index].disabled; });
}

function refreshScenarios(focus) {
  const next = fragment(scenarioPage(state));
  const previous = motionAllowed() ? captureCharts(studioScreen) : null;
  hideChartTooltip();
  for (const selector of ['.scope-meta', '[data-action="compare-scenario"]', '.scenario-values', '.rate-panel .legend', '.rate-panel > a']) {
    main.querySelector(selector).replaceWith(next.querySelector(selector));
  }
  const currentChart = main.querySelector('.rate-panel figure');
  const nextChart = next.querySelector('.rate-panel figure');
  const compatible = currentChart.querySelector('svg').dataset.chartScope === nextChart.querySelector('svg').dataset.chartScope;
  updateChartPlot(currentChart, nextChart, compatible);
  const buttons = main.querySelectorAll('[data-action="scenario"]');
  const updates = next.querySelectorAll('[data-action="scenario"]');
  buttons.forEach((button, index) => {
    const update = updates[index];
    const pressed = update.getAttribute('aria-pressed');
    const selectionChanged = pressed !== button.getAttribute('aria-pressed');
    button.setAttribute('aria-pressed', pressed);
    if (!compatible) button.replaceChildren(...update.childNodes);
    if (selectionChanged && pressed === 'true' && motionAllowed()) {
      button.querySelector('strong').animate?.([{ opacity: .65 }, { opacity: 1 }], { duration: 160 });
    }
  });
  for (const details of main.querySelectorAll('[data-scenario-detail]')) {
    const incoming = next.querySelector('#' + details.id);
    const summary = details.querySelector('summary');
    const scroll = details.querySelector('.table-wrap')?.scrollLeft;
    for (const child of [...details.children]) if (child !== summary) child.remove();
    details.append(...[...incoming.children].filter(child => child.tagName !== 'SUMMARY'));
    if (scroll) details.querySelector('.table-wrap').scrollLeft = scroll;
  }
  if (previous) animateCharts(studioScreen, previous);
  restoreChartViews(studioScreen);
  main.querySelector(focus)?.focus({ preventScroll: true });
  syncDockContext();
}

function refreshEffect() {
  const next = fragment(analysisTab(state));
  const selected = main.querySelector('#effect-select');
  const formPlot = main.querySelector('#effect-plot');
  const nextPlot = next.querySelector('#effect-plot');
  selected.value = next.querySelector('#effect-select').value;
  if (formPlot && nextPlot) formPlot.value = nextPlot.value;
  else if (formPlot) formPlot.closest('label').remove();
  else if (nextPlot) selected.closest('.effect-controls').append(nextPlot.closest('label'));
  main.querySelector('#effects .note').textContent = next.querySelector('#effects .note').textContent;
  hideChartTooltip();
  main.querySelector('#effect-detail').replaceWith(next.querySelector('#effect-detail'));
  syncDockContext();
}

function refreshInteraction(localOnly = false) {
  const next = fragment(analysisTab(state));
  if (localOnly) {
    main.querySelector('.local-pair .note').textContent = next.querySelector('.local-pair .note').textContent;
    return;
  }
  const selector = main.querySelector('#pair-select');
  selector.value = next.querySelector('#pair-select').value;
  const incoming = [...next.querySelectorAll('.heatmap th, .heatmap td')];
  document.querySelectorAll('.heatmap th, .heatmap td').forEach((cell, index) => {
    cell.classList.toggle('heat-axis-selected', incoming[index].classList.contains('heat-axis-selected'));
    const button = cell.querySelector('button');
    if (button) button.setAttribute('aria-pressed', incoming[index].querySelector('button').getAttribute('aria-pressed'));
  });
  main.querySelector('#interaction-detail').replaceWith(next.querySelector('#interaction-detail'));
  syncDockContext();
}

function reveal(target) {
  if (!target) return;
  const disclosure = target.closest('details');
  if (disclosure) disclosure.open = true;
  const focus = target.matches('details') ? target.querySelector('summary') : target;
  if (focus.tabIndex < 0) focus.tabIndex = -1;
  focus.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
}

function openFactSource(key, detail) {
  if (assistant.open && !dock.isDocked()) assistant.close();
  const contextual = {
    '#scenario-results': 'scenarios', '#scenario-buckets': 'scenarios',
    '#portfolio-holdings': 'portfolio', '#data-profile': 'data', '#data-setup': 'data', '#curve-context': 'curves',
  }[key];
  if (contextual) {
    if (contextual === 'curves') {
      reveal(curveScreen.shadowRoot?.querySelector('.results-panel') ?? curveScreen);
      return;
    }
    if (contextual === 'portfolio') state.portfolioTab = 'holdings';
    if (contextual === 'scenarios' && detail) state.scenarioCode = detail;
    navigate(contextual, () => reveal(main.querySelector(key === '#data-profile' ? '#data-quality' : key)));
    return;
  }
  if (key === '#waterfall' && detail) {
    state.research = false;
    if (state.route !== 'analysis') {
      navigate('analysis', () => selectFactor(detail));
      return;
    }
    selectFactor(detail);
    return;
  }
  if (drawer.open) drawer.close();
  if (key === '#interactions' && detail) {
    state.pair = Number(detail);
    state.pairDeal = null;
  }
  if (key === '#effects' && detail) {
    state.effect = detail;
    state.effectPlot = 'ale';
  }
  const targetTab = { '#quality': 'quality', '#importance': 'importance', '#interactions': 'interactions',
    '#effects': 'effects', '#cash-details': 'cash', '#valuation-detail': 'contributions' }[key];
  if (targetTab && Object.hasOwn(reportTabs(state.workspace), targetTab)) state.tab = targetTab;
  state.research = key !== '#waterfall';
  const anchors = ['#waterfall', '#quality', '#interactions', '#effects', '#cash-details',
    '#valuation-detail', '#analysis-methodology'];
  navigate('analysis', () => reveal((anchors.includes(key) ? main.querySelector(key) : null) ?? main.querySelector('#tab-body')));
}

function action(element) {
  const { action: kind, key } = element.dataset;
  if (kind === 'factor') selectFactor(key, element);
  if (kind === 'analysis-chart') selectChart(key, element);
  if (kind === 'edit-parameters') openSettings(element);
  if (kind === 'open-assistant') openAssistant(null, null, element);
  if (kind === 'minimize-assistant') dock.minimize();
  if (kind === 'restore-assistant') { syncDockContext(); dock.open(element); }
  if (kind === 'appearance') openPanel(appearance, element);
  if (kind === 'commands') openCommands(element);
  if (kind === 'service-status') navigate('data', () => reveal(main.querySelector('#data-services')));
  if (kind === 'change-mode') void changeReportMode(key);
  if (kind === 'new-dialogue') newDialogue();
  if (kind === 'cancel-explanation') stopWaiting('Ожидание отменено.');
  if (kind === 'prepare-summary') void ask(assistant.querySelector('#explain-form'), true);
  if (kind === 'overview' || kind === 'research') {
    state.research = kind === 'research';
    state.assistantFactor = null;
    navigate('analysis');
    const target = main.querySelector('h1');
    if (target) animateContent(target);
  }
  if (kind === 'analysis-mode') {
    const form = element.closest('form');
    form.elements.mode.value = key;
    applyComparison(form, true);
    settings.querySelector('[data-action="analysis-mode"][aria-pressed="true"]')?.focus({ preventScroll: true });
  }
  if (kind === 'source-format') {
    if (element.getAttribute('aria-pressed') === 'true') return;
    state.sourceFormat = key;
    const importer = element.closest('.data-import');
    importer.querySelector('.upload-box').replaceWith(fragment(uploadBox(key)));
    for (const control of importer.querySelectorAll('[data-action="source-format"]')) {
      control.setAttribute('aria-pressed', String(control.dataset.key === key));
    }
    syncIndicators(importer);
  }
  if (kind === 'portfolio-tab') {
    if (element.getAttribute('aria-pressed') === 'true') return;
    state.portfolioTab = key;
    render();
    main.querySelector('[data-action="' + kind + '"][aria-pressed="true"]')?.focus({ preventScroll: true });
  }
  if (kind === 'new-run') {
    state.portfolioTab = 'builder';
    state.portfolioJob = state.generating ? state.portfolioJob : null;
    navigate('portfolio');
  }
  if (kind === 'retry-portfolio' && state.portfolioJob?.retrySettings) {
    void runPortfolio(state.portfolioJob.retrySettings);
  }
  if (kind === 'upload-history') {
    state.sourceFormat = 'zip';
    navigate('data');
  }
  if (kind === 'calculation-sources') {
    navigate('data', () => reveal(main.querySelector('#data-sources') ?? main.querySelector('#data-quality')));
  }
  if (kind === 'tab' && key !== state.tab) selectTab(key, true);
  if (kind === 'scenario' && element.getAttribute('aria-pressed') !== 'true') {
    state.scenarioCode = key;
    refreshScenarios('[data-action="scenario"][aria-pressed="true"]');
  }
  if (kind === 'flow') void showFlows(key, element);
  if (kind === 'diagnostics') void diagnostics();
  if (kind === 'check-mapping') void checkMapping(element.form);
  if (kind === 'pair') {
    state.pair = Number(key);
    state.pairDeal = null;
    refreshInteraction();
  }
  if (kind === 'question') {
    const form = document.querySelector('#explain-form');
    form.elements.question.value = key;
    form.requestSubmit();
  }
  if (kind === 'explain-factor') {
    const source = element.getBoundingClientRect();
    if (drawer.matches(':modal')) drawer.close();
    openAssistant({ key, label: element.dataset.label }, null, source);
    const form = assistant.querySelector('#explain-form');
    form.elements.question.value = 'Каков вклад выбранного компонента?';
    form.elements.question.focus({ preventScroll: true });
    form.requestSubmit();
  }
  if (kind === 'compare-scenario') {
    const source = element.getBoundingClientRect();
    const dates = state.workspace.periods.map((item) => item.date);
    const at = dates.indexOf(element.dataset.date);
    state.comparison = { mode: 'valuation', target: 'stress_delta', scenario: key,
      before: dates[Math.max(0, at - 1)], after: dates[Math.max(1, at)] };
    state.research = false;
    navigate('analysis', () => openSettings(source));
  }
  if (kind === 'deal-page') {
    state.dealPage = Math.max(0, Number(key));
    void loadDeals();
  }
  if (kind === 'curve-revalue') void revaluePortfolio();
  if (kind === 'curve-clear') {
    state.curveSelection = null;
    render();
  }
  if (kind === 'fact-source') openFactSource(key, element.dataset.detail);
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  if (['new-run', 'upload-history', 'overview', 'calculation-sources'].includes(element.dataset.action) && element.tagName === 'A') {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
  }
  action(element);
});
document.addEventListener('keydown', (event) => {
  const tab = event.target.closest('button[data-action="tab"]');
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const tabs = [...tab.parentElement.querySelectorAll('button[data-action="tab"]')];
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    event.preventDefault();
    selectTab(tabs[next].dataset.key, true);
    return;
  }
  if (!['Enter', ' '].includes(event.key)) return;
  const control = event.target.closest('g[data-action]');
  if (!control) return;
  event.preventDefault();
  action(control);
});
document.addEventListener('submit', (event) => {
  const form = event.target;
  const handlers = {
    'generate-form': generate,
    'compare-form': analyze,
    'mapping-form': (form) => analyze(form, true),
    'import-form': importCsv,
    'history-form': importHistory,
    'explain-form': ask,
    'deal-search': (form) => {
      state.dealQuery = String(new FormData(form).get('query') || '').trim();
      state.dealPage = 0;
      return loadDeals();
    },
  };
  if (!Object.hasOwn(handlers, form.id)) return;
  event.preventDefault();
  void handlers[form.id](form);
});
document.addEventListener('change', (event) => {
  const element = event.target;
  if (element.id === 'report-with-summary') {
    for (const link of main.querySelectorAll('[data-report-download]')) {
      const url = new URL(link.href);
      url.searchParams.set('includeSummary', element.checked ? '1' : '0');
      link.href = url;
    }
  }
  if (element.type === 'file' && element.classList.contains('sr-only')) {
    const warning = element.closest('.file-field').querySelector('[data-file-warning]');
    warning.hidden = true;
    element.removeAttribute('aria-invalid');
    element.setAttribute('aria-describedby', element.id + '-selected');
    const file = element.files[0];
    const name = element.closest('.file-picker').querySelector('.file-name');
    name.textContent = file?.name || 'Файл не выбран';
    name.title = file?.name || '';
    element.form.querySelector('button[type="submit"]').disabled = !file?.size || state.generating;
  }
  if (element.id === 'factor-select') selectFactor(element.value);
  if (element.id === 'effect-select') {
    state.effect = element.value;
    refreshEffect();
  }
  if (element.id === 'effect-plot') {
    state.effectPlot = element.value;
    refreshEffect();
  }
  if (element.id === 'scenario-date') {
    state.scenarioDay = element.value;
    refreshScenarios('#scenario-date');
  }
  if (element.id === 'pair-deal') {
    state.pairDeal = element.value;
    refreshInteraction(true);
  }
  if (element.id === 'pair-select') {
    state.pair = Number(element.value);
    state.pairDeal = null;
    refreshInteraction();
  }
  if (element.form?.id === 'compare-form') {
    applyComparison(element.form, element.id === 'metric');
    if (element.id === 'metric') document.getElementById(element.id)?.focus({ preventScroll: true });
  }
  if (element.id === 'portfolio-date') {
    flowRequest++;
    if (inspector.open) inspector.close();
    state.portfolioDay = element.value;
    state.dealPage = 0;
    void loadDeals();
  }
  if (element.form?.id === 'mapping-form') {
    mappingRequest?.abort();
    const data = new FormData(element.form);
    state.preview = null;
    state.mapping = { ...Object.fromEntries(data), features: data.getAll('feature') };
    if (element.dataset.column) {
      if (element.dataset.column === 'dateColumn') {
        state.mapping.before = '';
        state.mapping.after = '';
      }
      refreshMapping();
    } else {
      document.querySelector('#mapping-verified').hidden = true;
    }
  }
});

studioScreen.addEventListener('dragover', (event) => {
  const picker = event.target.closest('.file-picker');
  if (!picker || !event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  picker.classList.add('is-dragging');
});
studioScreen.addEventListener('dragleave', (event) => {
  const picker = event.target.closest('.file-picker');
  if (picker && !picker.contains(event.relatedTarget)) picker.classList.remove('is-dragging');
});
studioScreen.addEventListener('drop', (event) => {
  const picker = event.target.closest('.file-picker');
  if (!picker || !event.dataTransfer.files.length) return;
  event.preventDefault();
  picker.classList.remove('is-dragging');
  const control = picker.querySelector('input[type="file"]');
  const extensions = control.accept.split(',').filter((value) => value.startsWith('.'));
  const files = event.dataTransfer.files;
  if (files.length !== 1 || !extensions.some((extension) => files[0].name.toLowerCase().endsWith(extension))) {
    importError(control.form, 'Перетащите один файл. Допустимые форматы — ' + extensions.join(', ') + '.');
    return;
  }
  control.files = files;
  control.dispatchEvent(new Event('change', { bubbles: true }));
});

document.addEventListener('input', (event) => {
  const element = event.target;
  if (element.form?.id === 'generate-form') {
    const draft = Object.fromEntries(new FormData(element.form));
    state.draft = draft;
    const preview = document.querySelector('#portfolio-preview');
    const next = fragment(portfolioPreview(draft));
    const distribution = preview.querySelector('details');
    const summary = distribution.querySelector('summary');
    for (const item of [...preview.children]) if (item !== distribution) item.remove();
    distribution.before(...[...next.children].filter(item => item.tagName !== 'DETAILS'));
    for (const item of [...distribution.children]) if (item !== summary) item.remove();
    distribution.append(...[...next.querySelector('details').children].filter(item => item.tagName !== 'SUMMARY'));
    document.querySelector('#curve-note').textContent = portfolioCurveNote(draft.curveSource);
    const pinned = document.querySelector('#pinned-curve');
    if (pinned) pinned.hidden = draft.curveSource !== 'api';
  }
  if (element.form?.id === 'explain-form') {
    if (element.name === 'question') {
      state.question = element.value;
    }
    if (element.name === 'allowExternal') state.allowExternal = element.checked;
  }
});

document.addEventListener('spectrum-chart-period', ({ detail: { before, after, origin } }) => {
  const report = state.workspace?.report;
  if (!report || !report.timeline.some((item) => item.date === before)
    || !report.timeline.some((item) => item.date === after) || before >= after) return;
  state.comparison = { mode: report.mode, target: report.target, scenario: report.scenario, before, after };
  openSettings(origin);
});

assistant.addEventListener('close', () => {
  if (!assistant.open && !dock.minimized() && state.asking) stopWaiting();
});
drawer.addEventListener('close', () => {
  if (!drawer.open) delete drawer.dataset.adjacent;
});

inspector.addEventListener('close', () => {
  if (inspector.open) return;
  flowRequest++;
  delete inspector.dataset.kind;
});

function fitIndicators() { syncIndicators(document, new Map(), false); }
new ResizeObserver(() => syncIndicators(document.querySelector('.navigation-shell'), new Map(), false))
  .observe(document.querySelector('.workspace-nav'));
window.addEventListener('resize', fitIndicators, { passive: true });
document.fonts.ready.then(fitIndicators);

window.addEventListener('hashchange', () => {
  if (location.hash === '#content') return;
  closeDialogs();
  state.assistantFactor = null;
  state.route = routeName();
  if (state.route === 'analysis') readAnalysisLocation();
  const next = afterNavigation;
  afterNavigation = null;
  render();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
  if (next?.route === state.route) next.enter();
});

async function start() {
  state.route = routeName();
  try {
    swapWorkspace(await api('/api/workspace'));
    if (state.route === 'analysis') readAnalysisLocation();
    const job = rememberedJob();
    if (job) {
      state.generating = true;
      if (job.portfolioSettings) {
        state.draft = job.portfolioSettings;
        state.curveSelection = job.portfolioSettings.curveSelection ?? null;
      }
      void followJob(job.id, job.kind, job.portfolioSettings).finally(() => { state.generating = false; render(); });
    }
    render();
  } catch (error) {
    notice(error.message, 'error');
    render();
  } finally {
    delete root.dataset.opening;
  }
  void updateHealth();
  healthTimer = window.setInterval(updateHealth, 30_000);
}
window.addEventListener('pagehide', () => clearInterval(healthTimer));
void start();
