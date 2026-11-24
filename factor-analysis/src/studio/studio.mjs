import { day, esc } from './charts.mjs';
import { analysisPage, analysisTab, dataPage, dealTable, explanation, factorDetails, flowDialog, pages, portfolioPage, scenarioPage } from './views.mjs';

const main = document.querySelector('#content');
const activity = document.querySelector('#activity');
const inspector = document.querySelector('#inspector');
const state = {
  workspace: null, route: 'analysis', tab: 'timeline', factor: null, effect: null, scenarioCode: null,
  scenarioDay: null, portfolioDay: null, dealQuery: '', dealPage: 0, draft: null, answer: null,
  mapping: null, generating: false,
};
let dealsRequest = 0;
let flowRequest = 0;
let healthTimer;

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

function routeName() {
  const route = location.hash.slice(1);
  return Object.hasOwn(pages, route) ? route : 'analysis';
}

function swapWorkspace(workspace) {
  state.workspace = workspace;
  state.factor = null;
  state.effect = null;
  state.answer = null;
  state.mapping = null;
}

function render() {
  document.querySelector('#crumb').textContent = pages[state.route];
  document.querySelector('#origin').innerHTML = state.workspace?.source === 'integrated'
    ? '<strong>Синтетический портфель</strong> · Рыночные кривые MOEX'
    : state.workspace?.source === 'imported' ? esc(state.workspace.filename) : '';
  for (const anchor of document.querySelectorAll('[data-route]')) {
    if (anchor.dataset.route === state.route) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  main.innerHTML = { analysis: analysisPage, scenarios: scenarioPage, portfolio: portfolioPage, data: dataPage }[state.route](state);
  if (state.route === 'portfolio') void loadDeals();
}

function navigate(route) {
  if (state.route === route) {
    render();
    window.scrollTo(0, 0);
  } else {
    location.hash = route;
  }
}

async function updateHealth() {
  const host = document.querySelector('#services');
  try {
    const result = await api('/api/services');
    host.innerHTML = Object.entries({ calculator: 'Калькулятор · команда 1', curves: 'Кривые · команда 2', llm: 'Локальная LLM' })
      .map(([key, text]) => `<li class="${result[key] ? 'up' : 'down'}" title="${result[key] ? 'Подключено' : 'Сервис недоступен'}">
        <i aria-hidden="true"></i>${text}<span class="sr-only">${result[key] ? ', подключено' : ', недоступно'}</span></li>`).join('');
  } catch {
    host.innerHTML = '<li class="down"><i></i>Состояние неизвестно</li>';
  }
}

function selectFactor(key) {
  if (!state.workspace?.report) return;
  state.factor = key;
  const target = document.querySelector('#factor-details');
  if (!target) return;
  const selected = document.activeElement?.id === 'factor-select';
  target.innerHTML = factorDetails(state.workspace, key);
  for (const control of document.querySelectorAll('#bridge-chart [data-key]')) {
    control.setAttribute('aria-pressed', String(control.dataset.key === key));
  }
  if (selected) document.querySelector('#factor-select')?.focus({ preventScroll: true });
}

function selectTab(tab, focus = false) {
  if (!Object.hasOwn({ timeline: 1, importance: 1, interactions: 1, effects: 1, quality: 1, explanation: 1 }, tab)) return;
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
  try { return sessionStorage.getItem('spectrum-job'); } catch { return null; }
};
const remember = (job) => {
  try {
    if (job) sessionStorage.setItem('spectrum-job', job);
    else sessionStorage.removeItem('spectrum-job');
  } catch { /* Running in a browser with storage disabled is supported. */ }
};

async function followJob(id) {
  remember(id);
  state.generating = true;
  document.querySelector('#generate-form button[type="submit"]')?.setAttribute('disabled', '');
  try {
    let errors = 0;
    for (;;) {
      let job;
      try {
        job = await api('/api/job/' + id);
        errors = 0;
      } catch (error) {
        if (++errors === 3) throw error;
        await pause(850);
        continue;
      }
      if (job.state === 'ready') {
        swapWorkspace(await api('/api/workspace'));
        state.tab = 'timeline';
        state.scenarioCode = null;
        state.scenarioDay = null;
        state.portfolioDay = null;
        state.dealPage = 0;
        navigate('analysis');
        notice('Расчёт завершён. Кривые, потоки и факторное разложение готовы.');
        return;
      }
      if (job.state === 'failed') throw new Error(job.message);
      notice(job.message, '', job);
      await pause(750);
    }
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    remember(null);
    state.generating = false;
    document.querySelector('#generate-form button[type="submit"]')?.removeAttribute('disabled');
    void updateHealth();
  }
}

async function generate(form) {
  if (state.generating) return;
  state.generating = true;
  form.querySelector('button[type="submit"]').disabled = true;
  const settings = Object.fromEntries(new FormData(form));
  for (const key of ['count', 'monthly', 'periods']) settings[key] = Number(settings[key]);
  settings.useSavedCurves = settings.useSavedCurves === 'on';
  state.draft = settings;
  notice('Запускаем совместный расчёт.');
  try {
    const { job } = await api('/api/run', { body: settings });
    await followJob(job);
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    state.generating = false;
    form.querySelector('button[type="submit"]').disabled = false;
  }
}

async function analyze(form, config = false) {
  const work = state.workspace;
  if (!work) return;
  const fields = new FormData(form);
  const target = fields.get('target');
  const body = { ...work.options, workspaceId: work.id, target };
  delete body.labels;
  delete body.targets;
  delete body.candidateFeatures;
  if (config) {
    body.dateColumn = fields.get('dateColumn') ?? work.options.dateColumn;
    body.idColumn = fields.get('idColumn') ?? work.options.idColumn;
    body.features = fields.getAll('feature');
    if (body.dateColumn === work.options.dateColumn && work.report) {
      body.before = work.report.before;
      body.after = work.report.after;
    }
  } else {
    body.before = fields.get('before');
    body.after = fields.get('after');
    if (work.source === 'integrated' || target === work.report?.target) body.features = work.report?.selectedFeatures;
  }
  form.querySelector('button[type="submit"]').disabled = true;
  notice('Считаем вклады и проверяем модель на поздних датах.');
  try {
    swapWorkspace(await api('/api/analyze', { body }));
    notice('');
    if (config) navigate('analysis');
    else render();
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    form.querySelector('button[type="submit"]').disabled = false;
  }
}

async function importCsv(form) {
  const file = new FormData(form).get('csvfile');
  if (!file?.size) return;
  const button = form.querySelector('button');
  button.disabled = true;
  notice('Проверяем историю из CSV.');
  try {
    if (file.size > 6_000_000) throw new Error('Выберите CSV размером до 6 МБ.');
    swapWorkspace(await api('/api/import', { body: { filename: file.name, text: await file.text() } }));
    notice(state.workspace.setupError || 'История загружена.', state.workspace.setupError ? 'warn' : '');
    render();
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function ask(form) {
  const question = String(new FormData(form).get('question') || '').trim();
  const box = document.querySelector('#answer');
  const button = form.querySelector('button');
  button.disabled = true;
  box.innerHTML = '<p class="note checks-note">Подбираем факты по текущему расчёту…</p>';
  try {
    state.answer = await api('/api/explain', { body: { workspaceId: state.workspace.id, question } });
  } catch (error) {
    state.answer = { error: error.message };
  } finally {
    button.disabled = false;
    if (box.isConnected) box.innerHTML = explanation(state.answer);
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
    notice(error.message, 'error');
  }
}

function selectScenario(code, focus) {
  state.scenarioCode = code;
  main.innerHTML = scenarioPage(state);
  if (focus) {
    const selector = '[data-action="scenario"][data-key="' + CSS.escape(code) + '"]';
    main.querySelector(selector)?.focus({ preventScroll: true });
  } else main.querySelector('#scenario-code')?.focus({ preventScroll: true });
}

function action(element) {
  const { action: kind, key } = element.dataset;
  if (kind === 'factor') selectFactor(key);
  if (kind === 'tab') selectTab(key, true);
  if (kind === 'scenario') selectScenario(key, true);
  if (kind === 'flow') void showFlows(key);
  if (kind === 'deal-page') {
    state.dealPage = Math.max(0, Number(key));
    void loadDeals();
  }
  if (kind === 'fact-source') {
    if (key === '#quality') selectTab('quality');
    if (key === '#interactions') selectTab('interactions');
    (document.querySelector(key) ?? document.querySelector('#analysis-tabs'))?.scrollIntoView({ block: 'start' });
  }
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (element) action(element);
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
  if (element.id === 'factor-select') selectFactor(element.value);
  if (element.id === 'effect-select') {
    state.effect = element.value;
    selectTab('effects');
    document.querySelector('#effect-select')?.focus({ preventScroll: true });
  }
  if (element.id === 'scenario-date') {
    state.scenarioDay = element.value;
    render();
    document.querySelector('#scenario-date')?.focus({ preventScroll: true });
  }
  if (element.id === 'scenario-code') selectScenario(element.value, false);
  if (element.id === 'portfolio-date') {
    state.portfolioDay = element.value;
    state.dealPage = 0;
    void loadDeals();
  }
  if (element.dataset.column && state.workspace?.source === 'imported') {
    const data = new FormData(element.form);
    state.mapping = Object.fromEntries(['dateColumn', 'idColumn', 'target'].map((name) => [name, data.get(name)]));
    render();
    document.querySelector('[data-column="' + CSS.escape(element.dataset.column) + '"]')?.focus({ preventScroll: true });
  }
});

window.addEventListener('hashchange', () => {
  if (location.hash === '#content') return;
  state.route = routeName();
  render();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
});

async function start() {
  state.route = routeName();
  try {
    swapWorkspace(await api('/api/workspace'));
    render();
    const job = rememberedJob();
    if (job) void followJob(job);
  } catch (error) {
    notice(error.message, 'error');
    render();
  }
  void updateHealth();
  healthTimer = window.setInterval(updateHealth, 30_000);
}
window.addEventListener('pagehide', () => clearInterval(healthTimer));
void start();
