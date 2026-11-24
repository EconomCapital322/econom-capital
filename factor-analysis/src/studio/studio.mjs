import { day, esc } from './charts.mjs';
import { analysisChart, analysisPage, analysisTab, assistantConversation, assistantPanel, assistantStatus, comparisonPanel,
  codes, dataPage, dealTable, factorDetails, flowDialog, methodologyContent, metricName, pages, portfolioCurveNote, portfolioPage,
  portfolioPreview, portfolioProgress, reportTabs, scenarioPage, servicesList, titleOf } from './views.mjs';

const main = document.querySelector('#content');
const studioScreen = document.querySelector('#studio-screen');
const curveScreen = document.querySelector('#curve-screen');
const activity = document.querySelector('#activity');
const inspector = document.querySelector('#inspector');
const drawer = document.querySelector('#factor-drawer');
const assistant = document.querySelector('#assistant-drawer');
const settings = document.querySelector('#settings-dialog');
const state = {
  workspace: null, route: 'analysis', tab: 'timeline', factor: null, effect: null, effectPlot: 'ale', scenarioCode: null,
  scenarioDay: null, portfolioDay: null, dealQuery: '', dealPage: 0, draft: null, answer: null,
  mapping: null, preview: null, comparison: null, pair: null, pairDeal: null, health: null, generating: false,
  chart: 'contributions', research: false, portfolioTab: 'builder', portfolioJob: null, sourceFormat: 'csv',
  question: '', focusFactor: null, allowExternal: false, asking: false, assistantMessage: '',
  assistantContext: null, dialogId: null, turns: [], summary: null,
  curveSelection: null,
};
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
}

function routeName() {
  const route = location.hash.slice(1).split('?')[0];
  return Object.hasOwn(pages, route) ? route : 'analysis';
}

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
      onExplain: (curve) => openAssistant(null, curve) });
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
  assistant.replaceChildren();
  settings.replaceChildren();
  state.workspace = workspace;
  state.tab = 'timeline';
  state.pair = null;
  state.pairDeal = null;
  state.comparison = null;
  state.research = false;
  state.chart = 'contributions';
  state.preview = null;
  state.factor = null;
  state.effect = null;
  state.effectPlot = 'ale';
  state.answer = null;
  state.mapping = null;
  state.question = '';
  state.focusFactor = null;
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
  for (const anchor of document.querySelectorAll('[data-route]')) {
    if (anchor.dataset.route === state.route) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  const curvesActive = state.route === 'curves';
  curveScreen.hidden = !curvesActive;
  studioScreen.hidden = curvesActive;
  renderCurves(curvesActive);
  if (curvesActive) return;
  studioScreen.innerHTML = { analysis: analysisPage, scenarios: scenarioPage, portfolio: portfolioPage, data: dataPage }[state.route](state);
  if (state.route === 'portfolio') void loadDeals();
}

function closeDialogs() {
  for (const dialog of [inspector, drawer, assistant, settings]) {
    if (dialog.open) dialog.close();
  }
}

function navigate(route, enter) {
  if (state.route === route) {
    render();
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
    enter?.();
  } else {
    afterNavigation = enter ? { route, enter } : null;
    location.hash = route;
  }
}

function openSettings() {
  if (!state.workspace?.report) return;
  settings.innerHTML = comparisonPanel(state);
  if (!settings.open) settings.showModal();
}

function assistantScope(factor, curve) {
  const work = state.workspace;
  const report = work?.report;
  const page = state.route;
  const scope = { page, workspaceId: work?.id ?? null, analysisId: report?.analysisId ?? null };
  let title = pages[page], subtitle = '';
  if (page === 'analysis') {
    if (!report) return null;
    scope.focusFactor = factor?.key ?? null;
    title = factor?.label ?? metricName(work);
    subtitle = day(report.before) + ' — ' + day(report.after);
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
  return { ...scope, key: JSON.stringify(scope), title, subtitle };
}

function openAssistant(factor = null, curve = null) {
  const context = assistantScope(factor, curve);
  if (!context) return;
  if (state.assistantContext?.key !== context.key) {
    stopWaiting();
    state.dialogId = null;
    state.turns = [];
    state.answer = null;
    state.question = '';
    state.allowExternal = false;
  }
  state.assistantContext = context;
  state.focusFactor = factor;
  assistant.innerHTML = assistantPanel(state);
  if (!assistant.open) assistant.showModal();
  if (context.page === 'analysis' && state.summary?.analysisId !== context.analysisId) {
    void api('/api/summary/' + context.workspaceId + '/' + context.analysisId).then((saved) => {
      if (saved && state.assistantContext?.key === context.key && !state.summary) {
        state.summary = saved;
        refreshAnswer();
      }
    }).catch(() => {});
  }
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
  refreshAssistant();
}

function selectFactor(key) {
  if (!state.workspace?.report) return;
  const wasOpen = drawer.open;
  const selectedInDrawer = drawer.contains(document.activeElement);
  const controlId = document.activeElement?.id;
  state.factor = key;
  drawer.innerHTML = factorDetails(state);
  for (const control of document.querySelectorAll('#bridge-chart [data-action="factor"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.key === key));
  }
  if (!wasOpen) drawer.showModal();
  else if (selectedInDrawer) drawer.querySelector(controlId === 'factor-select' ? '#factor-select' : '.drawer-head button')?.focus({ preventScroll: true });
}

function selectChart(chart, control) {
  if (!['contributions', 'waterfall'].includes(chart)) return;
  state.chart = chart;
  document.querySelector('#bridge-chart').innerHTML = analysisChart(state);
  control.dataset.key = chart === 'waterfall' ? 'contributions' : 'waterfall';
  control.textContent = chart === 'waterfall' ? 'К вкладам' : 'Водопад';
}

function applyComparison(form, rerender) {
  state.comparison = Object.fromEntries(new FormData(form));
  if (rerender) openSettings();
}

function selectTab(tab, focus = false) {
  if (!Object.hasOwn(reportTabs(state.workspace), tab)) return;
  const target = document.querySelector('#tab-body');
  if (!target || !state.workspace?.report) return;
  state.tab = tab;
  target.innerHTML = analysisTab(state);
  for (const control of document.querySelectorAll('[data-action="tab"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.key === tab));
    if (focus && control.dataset.key === tab) control.focus({ preventScroll: true });
  }
}

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
  if (kind !== 'diagnostics') {
    explanationRequest?.abort();
    mappingRequest?.abort();
  }
  const locked = [...main.querySelectorAll('button[type="submit"], [data-action="diagnostics"]'),
    ...settings.querySelectorAll('button[type="submit"]'),
    ...drawer.querySelectorAll('[data-action="diagnostics"]')]
    .map((control) => [control, control.disabled]);
  for (const [control] of locked) control.disabled = true;
  notice(message);
  try {
    const { job } = await api(path, { body });
    return await followJob(job, kind, path === '/api/run' ? body : null);
  } catch (error) {
    notice(error.message, 'error');
    return false;
  } finally {
    state.generating = false;
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
    render();
    document.querySelector('[data-action="check-mapping"]')?.focus({ preventScroll: true });
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
  state.generating = true;
  explanationRequest?.abort();
  mappingRequest?.abort();
  notice('Проверяем историю из CSV.');
  try {
    if (file.size > 6_000_000) throw new Error('Выберите CSV размером до 6 МБ.');
    swapWorkspace(await api('/api/import', { body: { filename: file.name, text: await file.text() } }));
    state.generating = false;
    notice('CSV загружен. Проверьте колонки и запустите анализ.');
    render();
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    state.generating = false;
    button.disabled = false;
  }
}

async function importHistory(form) {
  if (state.generating) return;
  const values = new FormData(form);
  const file = values.get('history');
  if (!file?.size || file.size > 16_000_000) return notice('Выберите ZIP размером до 16 МБ.', 'error');
  try {
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const parts = [];
    for (let i = 0; i < fileBytes.length; i += 12_288) parts.push(btoa(String.fromCharCode(...fileBytes.subarray(i, i + 12_288))));
    await launch('/api/import-history', { archive: parts.join(''), provenance: values.has('bank') ? 'bank' : 'external' }, 'Проверяем историю из ZIP.');
  } catch (error) {
    notice(error.message, 'error');
  }
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
  assistant.innerHTML = assistantPanel(state);
  assistant.querySelector('#question')?.focus({ preventScroll: true });
}

function refreshAnswer() {
  const host = assistant.querySelector('#answer');
  if (host) host.innerHTML = assistantConversation(state);
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
    const { key, title, subtitle, ...scope } = context;
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
  const work = state.workspace;
  if (!panel || !work?.periods?.length) return;
  const serial = ++dealsRequest;
  const selected = document.querySelector('#portfolio-date').value;
  const params = new URLSearchParams({ date: selected, q: state.dealQuery, page: state.dealPage });
  try {
    const data = await api('/api/deals/' + work.id + '?' + params);
    if (panel.isConnected && serial === dealsRequest) panel.innerHTML = dealTable(data);
  } catch (error) {
    if (panel.isConnected && serial === dealsRequest) panel.innerHTML = `<p class="status error">${esc(error.message)}</p>`;
  }
}

async function showFlows(id) {
  const work = state.workspace;
  const serial = ++flowRequest;
  const date = document.querySelector('#portfolio-date').value;
  try {
    const data = await api('/api/flows/' + work.id + '?' + new URLSearchParams({ id, date }));
    if (serial !== flowRequest || state.route !== 'portfolio' || work !== state.workspace) return;
    inspector.innerHTML = flowDialog(data, work);
    if (!inspector.open) inspector.showModal();
  } catch (error) {
    if (serial === flowRequest && state.route === 'portfolio') notice(error.message, 'error');
  }
}

function refreshScenarios(focus) {
  const open = new Set([...main.querySelectorAll('details[data-scenario-detail][open]')]
    .map((element) => element.dataset.scenarioDetail));
  render();
  for (const disclosure of main.querySelectorAll('details[data-scenario-detail]')) {
    disclosure.open = open.has(disclosure.dataset.scenarioDetail);
  }
  main.querySelector(focus)?.focus({ preventScroll: true });
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
  if (assistant.open) assistant.close();
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
  if (kind === 'factor') selectFactor(key);
  if (kind === 'analysis-chart') selectChart(key, element);
  if (kind === 'edit-parameters') openSettings();
  if (kind === 'open-assistant') openAssistant();
  if (kind === 'new-dialogue') newDialogue();
  if (kind === 'cancel-explanation') stopWaiting('Ожидание отменено.');
  if (kind === 'prepare-summary') void ask(assistant.querySelector('#explain-form'), true);
  if (kind === 'overview' || kind === 'research') {
    state.research = kind === 'research';
    navigate('analysis');
  }
  if (kind === 'analysis-mode') {
    const form = element.closest('form');
    form.elements.mode.value = key;
    applyComparison(form, true);
    settings.querySelector('[data-action="analysis-mode"][aria-pressed="true"]')?.focus({ preventScroll: true });
  }
  if (kind === 'source-format' || kind === 'portfolio-tab') {
    if (kind === 'source-format') state.sourceFormat = key;
    else state.portfolioTab = key;
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
  if (kind === 'tab') selectTab(key, true);
  if (kind === 'scenario') {
    state.scenarioCode = key;
    refreshScenarios('[data-action="scenario"][aria-pressed="true"]');
  }
  if (kind === 'flow') void showFlows(key);
  if (kind === 'diagnostics') void diagnostics();
  if (kind === 'check-mapping') void checkMapping(element.form);
  if (kind === 'pair') {
    state.pair = Number(key);
    selectTab('interactions');
    document.querySelector('#pair-select')?.focus({ preventScroll: true });
  }
  if (kind === 'question') {
    const form = document.querySelector('#explain-form');
    form.elements.question.value = key;
    form.requestSubmit();
  }
  if (kind === 'explain-factor') {
    drawer.close();
    openAssistant({ key, label: element.dataset.label });
    const form = assistant.querySelector('#explain-form');
    form.elements.question.value = 'Каков вклад выбранного компонента?';
    form.elements.question.focus({ preventScroll: true });
    form.requestSubmit();
  }
  if (kind === 'compare-scenario') {
    const dates = state.workspace.periods.map((item) => item.date);
    const at = dates.indexOf(element.dataset.date);
    state.comparison = { mode: 'valuation', target: 'stress_delta', scenario: key,
      before: dates[Math.max(0, at - 1)], after: dates[Math.max(1, at)] };
    state.research = false;
    navigate('analysis', openSettings);
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
    const file = element.files[0];
    const name = element.closest('.file-picker').querySelector('.file-name');
    name.textContent = file?.name || 'Файл не выбран';
    name.title = file?.name || '';
    element.form.querySelector('button[type="submit"]').disabled = !file?.size || state.generating;
  }
  if (element.id === 'factor-select') selectFactor(element.value);
  if (element.id === 'effect-select') {
    state.effect = element.value;
    selectTab('effects');
    document.querySelector('#effect-select')?.focus({ preventScroll: true });
  }
  if (element.id === 'effect-plot') {
    state.effectPlot = element.value;
    selectTab('effects');
    document.querySelector('#effect-plot')?.focus({ preventScroll: true });
  }
  if (element.id === 'scenario-date') {
    state.scenarioDay = element.value;
    refreshScenarios('#scenario-date');
  }
  if (element.id === 'pair-deal') {
    state.pairDeal = element.value;
    selectTab('interactions');
    document.querySelector('#pair-deal')?.focus({ preventScroll: true });
  }
  if (element.id === 'pair-select') {
    state.pair = Number(element.value);
    selectTab('interactions');
    document.querySelector('#pair-select')?.focus({ preventScroll: true });
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
    render();
    document.querySelector('#portfolio-date')?.focus({ preventScroll: true });
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
      render();
      document.querySelector('[data-column="' + CSS.escape(element.dataset.column) + '"]')?.focus({ preventScroll: true });
    } else {
      document.querySelector('#mapping-verified').hidden = true;
    }
  }
});

document.addEventListener('input', (event) => {
  const element = event.target;
  if (element.form?.id === 'generate-form') {
    const draft = Object.fromEntries(new FormData(element.form));
    state.draft = draft;
    const preview = document.querySelector('#portfolio-preview');
    preview.innerHTML = portfolioPreview(draft, preview.querySelector('details').open);
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

assistant.addEventListener('close', () => {
  if (!assistant.open && state.asking) stopWaiting();
});

window.addEventListener('hashchange', () => {
  if (location.hash === '#content') return;
  closeDialogs();
  state.route = routeName();
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
  }
  void updateHealth();
  healthTimer = window.setInterval(updateHealth, 30_000);
}
window.addEventListener('pagehide', () => clearInterval(healthTimer));
void start();
