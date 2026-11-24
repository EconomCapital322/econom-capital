import { day, esc } from './charts.mjs';
import { analysisChart, analysisPage, analysisTab, assistantStatus, dataPage, dealTable, explanation, factorDetails, flowDialog,
  pages, portfolioCurveNote, portfolioPage, portfolioPreview, portfolioProgress, reportTabs, scenarioPage } from './views.mjs';

const main = document.querySelector('#content');
const activity = document.querySelector('#activity');
const inspector = document.querySelector('#inspector');
const drawer = document.querySelector('#factor-drawer');
const state = {
  workspace: null, route: 'analysis', tab: 'timeline', factor: null, effect: null, effectPlot: 'ale', scenarioCode: null,
  scenarioDay: null, portfolioDay: null, dealQuery: '', dealPage: 0, draft: null, answer: null,
  mapping: null, preview: null, comparison: null, pair: null, pairDeal: null, health: null, generating: false,
  chart: 'contributions', compareExpanded: false, portfolioTab: 'builder', portfolioJob: null, sourceFormat: 'csv',
  question: '', focusFactor: null, allowExternal: false, asking: false,
};
let dealsRequest = 0;
let flowRequest = 0;
let healthTimer;
let explanationRequest, mappingRequest;

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
  const route = location.hash.slice(1);
  return Object.hasOwn(pages, route) ? route : 'analysis';
}

function swapWorkspace(workspace) {
  explanationRequest?.abort();
  mappingRequest?.abort();
  dealsRequest++;
  flowRequest++;
  if (inspector.open) inspector.close();
  if (drawer.open) drawer.close();
  state.workspace = workspace;
  state.tab = 'timeline';
  state.pair = null;
  state.pairDeal = null;
  state.comparison = null;
  state.compareExpanded = false;
  state.preview = null;
  state.factor = null;
  state.effect = null;
  state.effectPlot = 'ale';
  state.answer = null;
  state.mapping = null;
  state.question = '';
  state.focusFactor = null;
  state.allowExternal = false;
  state.asking = false;
  state.sourceFormat = workspace?.periods ? 'zip' : 'csv';
}

function render() {
  document.querySelector('#crumb').textContent = pages[state.route];
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

function refreshAssistant() {
  const status = document.querySelector('#assistant-status');
  if (status) status.innerHTML = assistantStatus(state);
  const consent = document.querySelector('#assistant-consent');
  if (consent) consent.hidden = !(state.health?.llm && state.health?.ai?.provider === 'deepseek');
}

async function updateHealth() {
  const host = document.querySelector('#services');
  try {
    const result = await api('/api/services');
    state.health = result;
    const provider = result.ai?.provider === 'local' ? 'Локальная модель' : 'DeepSeek';
    host.innerHTML = Object.entries({ calculator: 'Калькулятор', curves: 'Кривые ставок', llm: provider }).map(([key, text]) => {
      const facts = key === 'llm' && result.ai?.provider === 'facts';
      const status = facts ? 'Выключен' : key === 'llm' && result.ai?.status === 'configured'
        ? 'Настроен' : result[key] ? 'Подключено' : 'Недоступно';
      return `<li class="${result[key] ? 'up' : facts ? '' : 'down'}"><i aria-hidden="true"></i><span>${text}</span><small>${status}</small></li>`;
    }).join('');
  } catch {
    host.innerHTML = '<li class="down"><i aria-hidden="true"></i>Состояние неизвестно</li>';
    state.health = { ai: { provider: 'facts' }, llm: false };
  }
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

function selectChart(chart) {
  if (!['contributions', 'waterfall'].includes(chart)) return;
  state.chart = chart;
  document.querySelector('#bridge-chart').innerHTML = analysisChart(state);
  for (const control of document.querySelectorAll('[data-action="analysis-chart"]')) {
    control.setAttribute('aria-pressed', String(control.dataset.key === chart));
  }
}

function applyComparison(form, rerender) {
  state.comparison = Object.fromEntries(new FormData(form));
  if (rerender) render();
  else {
    const report = state.workspace?.report;
    const draft = state.comparison;
    const note = form.querySelector('.pending-note');
    if (note && report) {
      const submitted = draft.mode === report.mode && draft.target === report.target && draft.before === report.before
        && draft.after === report.after && (draft.target !== 'stress_delta' || draft.scenario === report.scenario);
      note.hidden = submitted;
      form.querySelector('.compare-draft').hidden = submitted;
    }
  }
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

async function followJob(id, kind = 'report') {
  remember({ id, kind });
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
          if (drawer.open) selectFactor(state.factor);
        } else {
          swapWorkspace(latest);
          state.scenarioCode = null;
          state.scenarioDay = null;
          state.portfolioDay = null;
          state.dealPage = 0;
          state.dealQuery = '';
          if (kind === 'portfolio') {
            updatePortfolioJob({ ...job, message: 'Портфель рассчитан. Можно открыть договорные платежи и факторный анализ.' });
            state.portfolioTab = 'holdings';
            navigate('portfolio');
          } else navigate('analysis');
        }
        notice(['diagnostics', 'portfolio'].includes(kind) ? '' : 'Факторное разложение готово.');
        return true;
      }
      if (job.state === 'failed') throw new Error(job.message);
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
    ...drawer.querySelectorAll('[data-action="diagnostics"]')]
    .map((control) => [control, control.disabled]);
  for (const [control] of locked) control.disabled = true;
  notice(message);
  try {
    const { job } = await api(path, { body });
    return await followJob(job, kind);
  } catch (error) {
    notice(error.message, 'error');
    return false;
  } finally {
    state.generating = false;
    for (const [control, previous] of locked) {
      if (control.isConnected) control.disabled = previous;
    }
  }
}

async function generate(form) {
  if (state.generating) return;
  const settings = Object.fromEntries(new FormData(form));
  for (const key of ['count', 'monthly', 'periods', 'liabilityShare']) settings[key] = Number(settings[key]);
  settings.useSavedCurves = settings.curveSource === 'saved';
  settings.demoCurves = settings.curveSource === 'fixture';
  state.draft = settings;
  updatePortfolioJob(null);
  await launch('/api/run', settings, 'Запускаем совместный расчёт.', 'portfolio');
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
  if (!state.workspace) return;
  const body = { ...settingsFrom(form, config), background: true };
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

async function ask(form) {
  const initial = state.workspace;
  if (!initial?.report || state.generating) return;
  const values = new FormData(form);
  const question = String(values.get('question') || '').trim();
  state.question = question;
  state.allowExternal = values.has('allowExternal');
  const focusFactor = state.focusFactor?.key;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  explanationRequest?.abort();
  const request = new AbortController();
  explanationRequest = request;
  state.asking = true;
  document.querySelector('#answer').innerHTML = '<p class="note checks-note">Подбираем факты по текущему расчёту…</p>';
  try {
    const needsMLDetails = initial.report.diagnosticsReady === false && !focusFactor
      && /нелинейн|насыщ|порог|взаим|совмест|пара факторов/i.test(question);
    const needsCashDetails = initial.report.mode === 'valuation' && !initial.report.cashDetails && !focusFactor &&
      /погашен|проценты по преж|выпавшие проценты|перенос (платеж|срок|поток)|остат(ок|ка) долга|баланс договора|договорн|график[а]? платеж|срок договора|детализац.*поток/i.test(question);
    if ((needsMLDetails || needsCashDetails) && !await diagnostics()) throw new Error('Сначала завершите расчёт детализации.');
    const answer = await api('/api/explain', { body: { workspaceId: initial.id, analysisId: initial.report.analysisId, question,
      focusFactor, allowExternal: values.has('allowExternal') }, signal: request.signal });
    if (request.signal.aborted || answer.analysisId !== (state.workspace?.report?.analysisId ?? null)) return;
    state.answer = answer;
  } catch (error) {
    if (!request.signal.aborted) state.answer = { error: error.message };
  } finally {
    if (!request.signal.aborted && explanationRequest === request && initial.report.analysisId === state.workspace?.report?.analysisId) {
      state.asking = false;
      button.disabled = false;
      const box = document.querySelector('#answer');
      if (box) box.innerHTML = explanation(state.answer);
      refreshAssistant();
    }
  }
}

function setQuestionContext(factor) {
  state.focusFactor = factor;
  const context = document.querySelector('#answer-focus');
  if (!context) return;
  context.hidden = !factor;
  context.textContent = factor ? `Вопрос о компоненте «${factor.label}».` : '';
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

function selectScenario(code) {
  state.scenarioCode = code;
  main.innerHTML = scenarioPage(state);
  main.querySelector('[data-action="scenario"][aria-pressed="true"]')?.focus({ preventScroll: true });
}

function action(element) {
  const { action: kind, key } = element.dataset;
  if (kind === 'factor') selectFactor(key);
  if (kind === 'analysis-chart') selectChart(key);
  if (kind === 'toggle-comparison') {
    state.compareExpanded = !state.compareExpanded;
    element.form.dataset.expanded = String(state.compareExpanded);
    element.setAttribute('aria-expanded', String(state.compareExpanded));
  }
  if (kind === 'analysis-mode') {
    const form = element.closest('form');
    form.elements.mode.value = key;
    applyComparison(form, true);
    main.querySelector('[data-action="analysis-mode"][aria-pressed="true"]')?.focus({ preventScroll: true });
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
  if (kind === 'upload-history') {
    state.sourceFormat = 'zip';
    navigate('data');
  }
  if (kind === 'tab') selectTab(key, true);
  if (kind === 'scenario') selectScenario(key);
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
    setQuestionContext(null);
    form.elements.question.value = key;
    form.requestSubmit();
  }
  if (kind === 'explain-factor') {
    drawer.close();
    const form = document.querySelector('#explain-form');
    setQuestionContext({ key, label: element.dataset.label });
    form.elements.question.value = ('Каков вклад компонента «' + element.dataset.label + '»?').slice(0, 300);
    form.closest('#assistant').scrollIntoView({ block: 'nearest' });
    form.elements.question.focus({ preventScroll: true });
    form.requestSubmit();
  }
  if (kind === 'compare-scenario') {
    const dates = state.workspace.periods.map((item) => item.date);
    const at = dates.indexOf(element.dataset.date);
    state.comparison = { mode: 'valuation', target: 'stress_delta', scenario: key,
      before: dates[Math.max(0, at - 1)], after: dates[Math.max(1, at)] };
    state.compareExpanded = true;
    navigate('analysis');
  }
  if (kind === 'deal-page') {
    state.dealPage = Math.max(0, Number(key));
    void loadDeals();
  }
  if (kind === 'fact-source') {
    const { detail } = element.dataset;
    if (key === '#waterfall' && detail) {
      selectFactor(detail);
      return;
    }
    if (drawer.open) drawer.close();
    if (key === '#interactions' && detail) state.pair = Number(detail);
    if (key === '#effects' && detail) state.effect = detail;
    const targetTab = { '#quality': 'quality', '#interactions': 'interactions', '#effects': 'effects', '#valuation-detail': 'calculation', '#cash-details': 'calculation' }[key];
    if (targetTab) selectTab(targetTab);
    (document.querySelector(key) ?? document.querySelector('#analysis-tabs'))?.scrollIntoView({ block: 'start' });
  }
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  if (['new-run', 'upload-history'].includes(element.dataset.action) && element.tagName === 'A') event.preventDefault();
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
    render();
    document.querySelector('#scenario-date')?.focus({ preventScroll: true });
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
    document.querySelector('#portfolio-preview').innerHTML = portfolioPreview(draft);
    document.querySelector('#curve-note').textContent = portfolioCurveNote(draft.curveSource);
  }
  if (element.form?.id === 'explain-form') {
    if (element.name === 'question') {
      state.question = element.value;
      setQuestionContext(null);
    }
    if (element.name === 'allowExternal') state.allowExternal = element.checked;
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
  document.querySelector('.services').open = !matchMedia('(max-width: 810px)').matches;
  try {
    swapWorkspace(await api('/api/workspace'));
    render();
    const job = rememberedJob();
    if (job) {
      state.generating = true;
      void followJob(job.id, job.kind).finally(() => { state.generating = false; render(); });
    }
  } catch (error) {
    notice(error.message, 'error');
    render();
  }
  void updateHealth();
  healthTimer = window.setInterval(updateHealth, 30_000);
}
window.addEventListener('pagehide', () => clearInterval(healthTimer));
void start();
