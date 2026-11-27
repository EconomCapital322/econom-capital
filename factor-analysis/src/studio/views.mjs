import { bars, divergingBars, expandChart, gapAmount, lineChart, numberMarkup, waterfall, day, esc, exact, n, short, signed, tone } from './charts.mjs';
import { snapshotDates } from './portfolio-dates.mjs';

const icon = (name) => `<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-${name}"/></svg>`;

export const pages = { analysis: 'Анализ', curves: 'Кривые доходности', scenarios: 'Сценарии', portfolio: 'Портфель', data: 'Данные' };
const commonTabs = { timeline: 'Динамика', contributions: 'Вклады' };
export const codes = { parallel_up: 'Общий рост ставок', parallel_down: 'Общее снижение ставок', steepener: 'Увеличение наклона кривой',
  flattener: 'Уменьшение наклона кривой', short_rate_up: 'Рост краткосрочных ставок', short_rate_down: 'Снижение краткосрочных ставок' };
export const portfolioSources = { synthetic: 'Синтетические сделки', bank: 'Банковская выгрузка', external: 'Загруженные сделки' };
const datePlural = new Intl.PluralRules('ru');
export const dateCountLabel = (count) => `${n(count)} ${({ one: 'дата', few: 'даты' })[datePlural.select(count)] ?? 'дат'}`;
const curveSources = { api: 'MOEX через API', pinned: 'Выбранный запуск MOEX', saved: 'Сохранённые кривые MOEX',
  imported: 'Импортированные кривые MOEX', fixture: 'Учебные кривые' };
const help = {
  principal: 'Остаток основного долга, который заёмщики ещё должны вернуть.',
  contract_rate: 'Годовая договорная ставка в процентах. Для плавающих ставок используется тестовый индекс и надбавка.',
  term_years: 'Срок от отчётной даты до погашения. Он определяет горизонт будущих платежей.',
  age_years: 'Время от выдачи сделки до отчётной даты.',
  payment_type: 'Схема возврата основного долга. Она определяет, как платежи распределены по датам.',
  rate_type: 'Тип договорной ставки, фиксированная или плавающая.',
  market_1y: 'Рыночная ставка для срока до года. Она общая для всех сделок на одну дату.',
  market_5y: 'Рыночная ставка для срока до пяти лет. Она общая для всех сделок на одну дату.',
};
const chartLabels = {
  principal: 'Остаток долга', contract_rate: 'Ставка сделки', term_years: 'Срок сделки',
  age_years: 'Возраст сделки', payment_type: 'Схема выплат', rate_type: 'Тип ставки',
  market_1y: 'Кривая 1 год', market_5y: 'Кривая 5 лет',
};
const featureUnits = { principal: '₽', contract_rate: '%', term_years: 'лет', age_years: 'лет', market_1y: '%', market_5y: '%',
  market_short: '%', market_long: '%', market_level: '%', market_slope: 'п.п.', market_curvature: 'п.п.' };
const exportUrl = (workspace, path) => '/api/export/' + workspace.id + '/' + path;
const snapshotUrl = (workspace, period) => '#curves?' + new URLSearchParams({
  workspaceId: workspace.id, reportDate: period.date, runId: period.runId,
});
export const titleOf = (work, key) => {
  const scenario = work.report?.scenario || work.scenario;
  if (key === 'stress_delta') return codes[scenario] ? 'ΔPV · ' + codes[scenario] : 'ΔPV стресса к базе';
  return Object.hasOwn(work.options?.labels ?? {}, key) ? work.options.labels[key] : key;
};
const unitOf = (work) => {
  const unit = work.report?.unit;
  return unit ? ' ' + (unit === 'баллы' ? 'балл.' : unit) : work.periods ? ' ₽' : '';
};
const fmt = (value, unit) => esc(exact(value, unit));
const delta = (value, unit) => esc(signed(value, unit));
const compact = (value, unit) => esc(short(value, unit));
const endSentence = (text) => text.endsWith('.') ? text : text + '.';
const reportGap = (report, key, unit) => gapAmount(report[key], unit, report.decimal?.[key] ?? report[key]);
const gapMarkup = (gap) => gap.hint ? `<span class="gap-value" title="${esc(gap.hint)}">${esc(gap.label)}<span class="sr-only">. ${esc(gap.hint)}</span></span>`
  : esc(gap.label);
const statuses = { verified: 'Сверено с калькулятором', stable: 'Модельное объяснение устойчиво',
  caution: 'Требуется осторожность', insufficient: 'Недостаточно данных', unavailable: 'Анализ недоступен' };
const statusBadge = (status) => `<span class="result-status ${esc(status ?? 'caution')}">${statuses[status] ?? statuses.caution}</span>`;
export const reportTabs = (work) => work?.report?.mode === 'valuation'
  ? { ...commonTabs, cash: 'Денежные потоки' }
  : { ...commonTabs, importance: 'Важность', effects: 'Зависимости', interactions: 'Взаимодействия', quality: 'Качество' };
const reportUrl = (work, filename) => exportUrl(work, 'reports/' + work.report.analysisId + '/' + filename);
const stressOptions = (value) => Object.entries(codes).map(([key, label]) => option(key, label, value)).join('');
export const dateOpts = (dates, selected) => dates.map((value) => option(value, day(value), selected)).join('');
export const option = (key, label, selected) => `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`;
const heading = (title, note, action = '') => `<header class="page-heading"><div><h1>${title}</h1>${note ? `<p class="sub">${note}</p>` : ''}</div>${action}</header>`;
const h2 = (title, note) => `<div class="panel-head"><div><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}</div></div>`;
const link = (url, text) => `<a class="button small" href="${esc(url)}">${esc(text)}</a>`;
const assistantButton = `<button class="button small assistant-button" type="button" data-glass="clear" data-light data-action="open-assistant">${icon('spark')}Спросить AI</button>`;
const uploadHistoryLink = (label, style = 'button small') => `<a class="${style}" href="#data" data-action="upload-history">${icon('upload')}${label}</a>`;
const empty = (title, body, actions = '') => `<section class="panel empty"><h2>${title}</h2><p class="sub">${body}</p>${actions ? `<div class="form-actions">${actions}</div>` : ''}</section>`;
const table = (heads, rows, label) => `${heads.length >= 3 ? `<p class="table-hint note" data-columns="${heads.length}">Таблицу можно листать вправо.</p>` : ''}
  <div class="table-wrap" tabindex="0" aria-label="${esc(label)}"><table class="datagrid" style="--columns:${heads.length}" aria-label="${esc(label)}">
  <thead><tr>${heads.map((head) => `<th scope="col" class="${head[1] ?? ''}">${head[0]}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('')}</tbody></table></div>`;

function segments(action, selected, options, label, disabled = false, controls = '') {
  return `<div class="segmented motion-track" role="group" aria-label="${esc(label)}" data-motion-track="${esc(action)}">
    <span class="selection-pill" aria-hidden="true"></span>${options.map(([key, title]) =>
    `<button type="button" data-action="${action}" data-key="${key}" aria-pressed="${selected === key}"${controls ? ` aria-controls="${controls}"` : ''} ${disabled ? 'disabled' : ''}>${title}</button>`).join('')}</div>`;
}

export const metricName = (work) => titleOf(work, work.report.target);
const metricQuestion = (work) => {
  if (work.report.target === 'npv') return 'Почему изменился NPV?';
  if (work.report.target === 'stress_delta') return 'Почему изменился эффект стресса?';
  return `Почему изменился показатель «${metricName(work)}»?`;
};

export function bridge(work) {
  const r = work.report;
  const unit = unitOf(work);
  const rows = [
    { key: 'added', label: 'Новые сделки', value: r.additions, description: `${n(r.added)} новых ID на конечную дату. Вклад равен их суммарному значению показателя на эту дату.` },
    { key: 'removed', label: 'Выбывшие сделки', value: r.exclusions, description: `${n(r.removed)} ID встречаются только на начальную дату. Вклад равен их начальному значению с обратным знаком.` },
  ];
  for (const factor of r.factors.slice(0, 4)) rows.push({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
    chartLabel: factor.key === 'discount_effect' && r.mode === 'valuation' ? 'Эффект кривой'
      : work.periods ? chartLabels[factor.key] : null,
  });
  const rest = r.factors.slice(4);
  if (rest.length) rows.push({
    key: 'other', label: 'Остальные факторы', value: rest.reduce((total, item) => total + item.value, 0),
    description: 'Сумма остальных вкладов по наблюдениям, присутствующим на обе даты.',
  });
  rows.push(r.mode === 'valuation'
    ? { key: 'reconciliation', label: 'Расхождение с калькулятором', chartLabel: 'Расхождение', value: r.reconciliation,
        gap: reportGap(r, 'reconciliation', unit),
        description: 'Разница между фактическим изменением стоимости и суммой рассчитанных вкладов.' }
    : { key: 'residual', label: 'Изменение, не объяснённое моделью', chartLabel: 'Остаток модели', value: r.residual,
        gap: reportGap(r, 'residual', unit),
        description: 'Разница между наблюдаемым изменением по общим сделкам и изменением прогноза модели.' });
  return rows;
}

export function factorDetails(state) {
  const { workspace: work, factor: key, generating } = state;
  const r = work.report;
  const unit = unitOf(work);
  const items = bridge(work);
  const totals = [
    { key: 'start', label: 'Значение на начало периода', value: r.start, description: `Сумма показателя на ${day(r.before)}.` },
    { key: 'end', label: 'Значение на конец периода', value: r.end, description: `Сумма показателя на ${day(r.after)}.` },
  ];
  const modelFactor = r.factors.find((item) => 'factor:' + item.key === key);
  const item = [...items, ...totals].find((entry) => entry.key === key)
    ?? (modelFactor ? { ...modelFactor, key, label: titleOf(work, modelFactor.key) } : items[0]);
  const source = (target, title) => `<button class="text-button" type="button" data-action="fact-source" data-key="${target}">${title}${icon('arrow')}</button>`;
  let summary = item.description ? `<p class="drawer-description">${esc(item.description)}</p>` : '';
  let body = '';
  let method = '';
  const detail = (name, content) => `<section class="factor-evidence"><h3>${name}</h3>${content}</section>`;
  if (modelFactor && r.mode === 'valuation') {
    const cash = modelFactor.key === 'cash_effect';
    const { v00, v10, v01, v11 } = r.states;
    const before = cash ? v10 - v00 : v01 - v00;
    const after = cash ? v11 - v01 : v11 - v10;
    summary = `<p class="drawer-description">${cash ? 'Вклад изменений в будущих платежах между датами, включая плановые погашения и переносы по срокам.'
      : 'Вклад изменения рыночной кривой в текущую стоимость договорных платежей.'}</p>`;
    body = detail('Два пересчёта вклада', `<dl class="drawer-dl"><dt>${cash ? 'При кривой на начало' : 'На потоках на начало'}</dt><dd>${delta(before, unit)}</dd>
      <dt>${cash ? 'При кривой на конец' : 'На потоках на конец'}</dt><dd>${delta(after, unit)}</dd></dl>
      <p class="note">Итоговый вклад равен среднему этих двух оценок.</p>`);
    if (cash && r.cashDetails) {
      const meaningful = r.cashDetails.parts.filter((part) => Math.abs(part.value) >= .005);
      body += detail('Из чего сложился вклад', `${meaningful.length ? `<dl class="drawer-dl">${meaningful.map((part) =>
        `<dt>${esc(part.label)}</dt><dd>${delta(part.value, unit)}</dd>`).join('')}</dl>` : ''}
        <p class="note">Проверено договорных условий для ${n(r.cashDetails.covered)} из ${n(r.cashDetails.common)} общих сделок.</p>`);
    } else if (cash) {
      body += `<button class="button small" type="button" data-action="diagnostics" ${generating ? 'disabled' : ''}>Разложить денежные потоки</button>`;
    }
    method = `<p class="note">По общим сделкам сначала меняют один набор условий, затем другой. Совместный эффект распределён между потоками и кривой.</p>`
      + source(cash ? '#cash-details' : '#valuation-detail', cash ? 'Детализация потоков и источник' : 'Четыре расчётных состояния');
  } else if (modelFactor) {
    const featureUnit = work.periods && Object.hasOwn(featureUnits, modelFactor.key) ? ' ' + featureUnits[modelFactor.key] : '';
    const show = (facts) => facts.kind === 'numeric'
      ? (facts.mean == null ? '—' : `${n(facts.mean)}${esc(featureUnit)}`)
      : (Object.entries(facts.levels).slice(0, 3).map(([level, count]) => `${esc(level)} · ${n(count)}`).join('<br>') || '—');
    const numeric = modelFactor.before.kind === 'numeric';
    const summaryLabel = numeric ? 'Среднее' : 'Частые категории';
    const meanChange = numeric && modelFactor.before.mean != null && modelFactor.after.mean != null
      ? `<dt>Изменение среднего</dt><dd>${delta(modelFactor.after.mean - modelFactor.before.mean, featureUnit === ' %' ? ' п.п.' : featureUnit)}</dd>` : '';
    const pairs = r.interactions.map((pair, index) => ({ ...pair, index }))
      .filter((pair) => [pair.a, pair.b].includes(modelFactor.key)).slice(0, 2);
    summary = `<p class="drawer-description">${esc((work.periods ? help[modelFactor.key] : null)
      ?? 'Вклад показывает, какую часть изменения прогноза модель относит к этому признаку.')}</p>`;
    body = detail('Значения признака', `<dl class="drawer-dl"><dt>${summaryLabel} · ${day(r.before)}</dt><dd>${show(modelFactor.before)}</dd>
      <dt>${summaryLabel} · ${day(r.after)}</dt><dd>${show(modelFactor.after)}</dd>${meanChange}</dl>`)
      + detail('Устойчивость вклада', `<p class="note">Диапазон по повторным выборкам ${delta(modelFactor.low, unit)} … ${endSentence(delta(modelFactor.high, unit))}</p>
      <p class="note">Знак совпал в ${n(modelFactor.signStability * 100)}% повторных выборок.</p>
      ${modelFactor.refits?.length ? `<p class="note">${modelFactor.refitSignMatches != null
        ? `Знак совпал в ${modelFactor.refitSignMatches} из ${modelFactor.refits.length} переобучений. ` : ''}Вклады при переобучении ${modelFactor.refits.map((value) => delta(value, unit)).join(' · ')}.</p>` : ''}
      `) + (pairs.length ? detail('Связанные пары', pairs.map((pair) => `<button class="text-button" type="button" data-action="fact-source"
        data-key="#interactions" data-detail="${pair.index}">${esc(titleOf(work, pair.a))} × ${esc(titleOf(work, pair.b))}${icon('arrow')}</button>`).join('')) : '');
    method = `<p class="note">${esc(r.model?.name ?? '')} оценивает, как меняется прогноз по сделкам с одним ID на обе даты. Это модельная связь.</p>`
      + source('#quality', 'Проверка качества модели');
  } else if (key === 'other') {
    body = detail('Состав вклада', `<dl class="drawer-dl">${r.factors.slice(4).map((factor) =>
      `<dt>${esc(titleOf(work, factor.key))}</dt><dd>${delta(factor.value, unit)}</dd>`).join('')}</dl>`);
    method = source('#quality', 'Проверка качества модели');
  } else {
    method = source(r.mode === 'valuation' ? '#valuation-detail' : '#quality', r.mode === 'valuation' ? 'Сверка с калькулятором' : 'Проверка качества модели');
  }
  const dropdown = [totals[0], ...items, ...r.factors.slice(4).map((factor) => ({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
  })), totals[1]];
  const total = totals.includes(item);
  const amount = item.gap ? gapMarkup(item.gap) : total ? fmt(item.value, unit) : delta(item.value, unit);
  return `<div class="drawer-head"><span>Детали вклада</span><form method="dialog"><button class="icon-button" aria-label="Закрыть детали">${icon('close')}</button></form></div>
    <div class="drawer-body"><label class="field factor-menu">Компонент<select id="factor-select">${dropdown.map((entry) => option(entry.key, entry.label, item.key)).join('')}</select></label>
      <div class="factor-result"><h2 id="factor-title">${esc(item.label)}</h2>
        <p class="figure-value ${total || item.gap?.belowCent ? '' : tone(item.value)}">${amount}</p>
        <p class="note">${day(r.before)} — ${day(r.after)}</p>${summary}</div>
      ${body}<details class="details factor-method"><summary>Метод и источник</summary>${method}</details>
    </div>
    <footer class="drawer-footer"><button class="button primary" type="button" data-action="explain-factor" data-key="${esc(item.key)}" data-label="${esc(item.label)}">${icon('spark')}Объяснить с помощью AI</button></footer>`;
}

export function analysisChart(state) {
  const { workspace: work, factor, chart } = state;
  const r = work.report;
  const rows = bridge(work);
  if (chart === 'waterfall') return waterfall({ start: r.start, end: r.end, bars: rows, active: factor, unit: unitOf(work) });
  const visible = rows.filter((item) => item.value !== 0 || !['removed', 'added', 'reconciliation', 'residual'].includes(item.key));
  return divergingBars(visible, { active: factor, unit: unitOf(work) })
    + '<p class="note waterfall-note">Вклады сравниваются от нуля по общей шкале. Выберите строку для пояснения.</p>';
}

const modeLabels = { valuation: 'Расчётный анализ', ml: 'Анализ зависимостей (ML)' };

function reportScope(work) {
  const r = work.report;
  const curves = [...new Set(work.periods?.filter((item) => item.date === r.before || item.date === r.after)
    .map((item) => curveSources[item.curveSource] ?? 'Сохранённые кривые') ?? [])];
  const source = work.periods ? [portfolioSources[work.portfolioSource] ?? 'Загруженные сделки', ...curves].join(' · ')
    : work.filename ?? 'Загруженный CSV';
  return `<ul class="report-scope" aria-label="Применённые параметры">
    <li>${day(r.before)} — ${day(r.after)}</li><li title="${esc(source)}">${esc(source)}</li><li>${modeLabels[r.mode] ?? modeLabels.ml}</li>
  </ul>`;
}

function resultDifference(report, unit) {
  const valuation = report.mode === 'valuation';
  return { label: valuation ? 'Расхождение с калькулятором' : 'Необъяснённый остаток',
    gap: reportGap(report, valuation ? 'reconciliation' : 'residual', unit),
    hint: valuation ? 'Разница между фактическим изменением стоимости и суммой вкладов.'
      : 'Разница между наблюдаемым изменением по общим сделкам и изменением прогноза.' };
}

function contributionRows(work) {
  const rows = bridge(work);
  return [...rows.slice(0, 2), ...work.report.factors.map((factor) => ({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
  }))];
}

function contributionTable(work) {
  const r = work.report;
  const unit = unitOf(work);
  const tail = bridge(work).at(-1);
  const relative = r.start > Math.max(.01, Math.abs(r.end) * 1e-9) && r.end >= 0
    ? ` Изменение за период ${esc(signed(100 * r.change / r.start, '%'))}.` : '';
  const rows = [{ key: 'start', label: 'На начало периода', value: r.start },
    ...contributionRows(work), tail, { key: 'end', label: 'На конец периода', value: r.end }];
  return h2('Полное разложение', `${n(r.matched)} общих, ${n(r.added)} новых, ${n(r.removed)} выбывших.${relative}`)
    + table([['Компонент'], ['Значение', 'num']], rows.map(({ key, label, value }) =>
      `<tr data-link-key="${esc(key)}"><th scope="row"><button type="button" class="ghost" data-action="factor" data-key="${esc(key)}">${esc(label)}</button></th>
        <td class="num">${key === tail.key ? gapMarkup(tail.gap) : fmt(value, unit)}</td></tr>`), 'Полное разложение');
}

function conclusion(work) {
  const r = work.report;
  const rows = contributionRows(work).filter(({ value }) => Math.abs(value) >= .005)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const lead = rows[0];
  if (r.mode === 'ml' && Math.abs(r.residual) >= .005 && Math.abs(r.residual) > Math.abs(lead?.value ?? 0)) {
    return 'Необъяснённый остаток больше любого отдельного вклада модели.';
  }
  if (!lead) return 'За период нет вкладов выше точности отображения.';
  const text = {
    added: 'Основной вклад дали новые сделки.',
    removed: 'Наибольший вклад связан с выбытием сделок.',
    'factor:cash_effect': 'Основной вклад внесло изменение будущих платежей.',
    'factor:discount_effect': 'Основной вклад внесла переоценка по кривой ставок.',
  };
  const opposite = rows.find(({ value }) => Math.sign(value) !== Math.sign(lead.value));
  const leading = text[lead.key] ?? `Наибольший вклад модель связывает с признаком «${lead.label}».`;
  if (!opposite) return esc(leading);
  const direction = opposite.value > 0 ? 'повысило' : 'снизило';
  const offsets = {
    added: `Включение новых сделок ${direction} итог.`,
    removed: `Выбытие сделок ${direction} итог.`,
    'factor:cash_effect': `Изменение будущих платежей ${direction} итог.`,
    'factor:discount_effect': `Изменение кривой ставок ${direction} итог.`,
  };
  return esc(leading + ' ' + (offsets[opposite.key] ??
    `Вклад признака «${opposite.label}» ${opposite.value > 0 ? 'положительный' : 'отрицательный'}.`));
}

export function comparisonPanel(state) {
  const work = state.workspace;
  const r = work.report;
  const draft = state.comparison ?? {};
  const mode = draft.mode ?? r.mode ?? 'ml';
  const available = mode === 'valuation' ? ['npv', 'stress_delta'] : work.options.targets;
  const target = available.includes(draft.target ?? r.target) ? (draft.target ?? r.target) : available[0];
  const scenario = (Object.hasOwn(codes, draft.scenario) && draft.scenario)
    || (Object.hasOwn(codes, r.scenario) && r.scenario) || (Object.hasOwn(codes, work.scenario) && work.scenario) || 'parallel_up';
  return `<header class="drawer-head"><h2 id="settings-title">Изменить параметры</h2>
      <form method="dialog"><button class="icon-button" aria-label="Закрыть параметры">${icon('close')}</button></form></header>
    <form id="compare-form" aria-labelledby="settings-title">
      <div class="settings-fields">
        <div class="field mode-field"><span>Режим анализа</span><input type="hidden" name="mode" value="${mode}">
          ${work.periods ? segments('analysis-mode', mode, [['valuation', modeLabels.valuation], ['ml', modeLabels.ml]], 'Режим анализа')
            : '<span class="fixed-mode">Анализ зависимостей (ML)</span>'}
          <p class="note">${mode === 'valuation' ? 'Сравнение договорных потоков и кривых ставок.' : 'Оценка вклада признаков в изменение прогноза модели.'}</p></div>
        <label class="field">Показатель<select id="metric" name="target">${available.map((key) =>
          option(key, key === 'stress_delta' ? 'ΔPV стресса к базе' : titleOf(work, key), target)).join('')}</select></label>
        <div class="form-grid settings-dates">
          <label class="field">Начальная дата<select id="from" name="before">${dateOpts(r.profile.dates, draft.before ?? r.before)}</select></label>
          <label class="field">Конечная дата<select id="to" name="after">${dateOpts(r.profile.dates, draft.after ?? r.after)}</select></label>
        </div>
        ${target === 'stress_delta' && work.periods ? `<label class="field">Стресс-сценарий<select name="scenario" id="analysis-scenario">${stressOptions(scenario)}</select></label>` : ''}
      </div>
      <footer class="drawer-footer"><button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Рассчитать вклады</button></footer>
    </form>`;
}

export function methodologyContent(work) {
  const r = work.report;
  const description = r.mode === 'valuation'
    ? 'Знак CF зависит от стороны сделки. По общим ID одни и те же относительные бакеты оцениваются с потоками и весами обеих дат. Вес для стресса равен разнице коэффициентов дисконтирования стресса и базы.'
    : 'Модель обучается на датах раньше начала сравнения. TreeSHAP применяется к деревьям, Ridge использует коэффициенты, прогноз медианы даёт нулевые вклады. Суммы считаются по общим ID.';
  const equations = r.mode === 'valuation'
    ? ['Vᵢⱼ = Σ CFᵢ(b) × wⱼ(b)',
        'C_CF = [(V₁₀ − V₀₀) + (V₁₁ − V₀₁)] / 2',
        'C_DF = [(V₀₁ − V₀₀) + (V₁₁ − V₁₀)] / 2',
        'I = V₁₁ − V₁₀ − V₀₁ + V₀₀',
        'Изменение = новые + выбывшие + C_CF + C_DF + невязка']
    : ['Cⱼ = Σᵢ [SHAPⱼ(xᵢ₁) − SHAPⱼ(xᵢ₀)]',
        'ΔY_model = Σᵢ [f(xᵢ₁) − f(xᵢ₀)]',
        'Численная невязка = ΔY_model − Σⱼ Cⱼ',
        'Остаток = наблюдаемое изменение по общим ID − ΔY_model',
        'Изменение = новые + выбывшие + ΔY_model + остаток'];
  const exports = r.analysisId ? `<div class="data-actions report-downloads">
    <a class="button small" data-report-download href="${reportUrl(work, 'analysis.html')}">Отчёт HTML</a>
    <a class="button small" data-report-download href="${reportUrl(work, 'analysis.json')}">Отчёт JSON</a>
    ${link(reportUrl(work, 'factors.csv'), 'Вклады CSV')}${r.diagnosticsReady === false ? '' : link(reportUrl(work, 'interactions.csv'), 'Взаимодействия CSV')}
    ${r.mode === 'ml' ? link(reportUrl(work, 'quality.csv'), 'Качество CSV') : ''}
    ${r.cashDetails ? link(reportUrl(work, 'cash-details.csv'), 'Детализация потоков CSV') : ''}</div>
    <label class="check"><input type="checkbox" id="report-with-summary" checked> Включить сохранённое резюме в отчёт</label>
    <p class="note">Ревизия отчёта <code class="mono">${esc(r.analysisId)}</code></p>` : '';
  return `<div class="methodology-intro"><h3>Формулы разложения</h3><p class="note">${description}</p>
    <pre class="formula">${esc(equations.join('\n'))}</pre>
    ${r.mode === 'valuation' ? '<p class="note">В детализации потоков для совместимых договоров проверяются восемь сочетаний трёх групп условий. Шепли усредняет вклад по шести порядкам подстановки.</p>' : ''}
    <div class="data-actions"><a class="text-button" href="#data" data-action="calculation-sources">${work.periods ? 'Источники расчёта' : 'Профиль данных'}</a>
      <a class="text-button" href="https://github.com/EconomCapital322/econom-capital/blob/main/factor-analysis/docs/methodology.md">Полная методология</a></div></div>
    ${r.mode === 'valuation' ? valuationDetail(work) : ''}
    ${exports}`;
}

export function analysisPage(state) {
  const { workspace: work, chart, research, tab } = state;
  if (!work?.report) {
    return heading('Факторный анализ', '') + empty(
      work ? 'Проверьте настройки таблицы' : 'Подготовьте историю портфеля',
      work ? esc(work.setupError || 'Укажите дату, ID и показатель для анализа.') : 'Создайте тестовый портфель или загрузите историю за несколько дат.',
      `<a href="#portfolio" data-action="new-run" class="button primary">Создать тестовый портфель</a>${link('#data', 'Загрузить историю')}`);
  }
  const r = work.report;
  const unit = unitOf(work);
  const difference = resultDifference(r, unit);
  const settings = `<button class="button small" type="button" data-action="edit-parameters">${icon('sliders')}Изменить параметры</button>`;
  const ask = assistantButton;
  const scope = reportScope(work);
  if (research) {
    const menu = Object.entries(reportTabs(work)).map(([key, label]) =>
      `<button type="button" data-action="tab" data-key="${key}" aria-pressed="${tab === key}">${label}</button>`).join('');
    return `<div class="report-layout research-view">
      <button type="button" class="text-button back-link" data-action="overview">${icon('arrow')}К обзору</button>
      <header class="report-header"><div><h1>Подробный анализ</h1><p class="research-metric">${esc(metricName(work))}</p>
        ${scope}</div><div class="data-actions">${ask}</div></header>
      <section class="research-sheet" id="analysis-tabs" aria-label="Детали факторного анализа">
        <div class="tabs motion-track" role="group" aria-label="Разделы аналитики" data-motion-track="report-tabs"><span class="selection-pill" aria-hidden="true"></span>${menu}</div>
        <div class="tab-body" id="tab-body">${analysisTab(state)}</div>
      </section>
      <details class="details technical" id="analysis-methodology"><summary>Методология и выгрузки</summary>
        <div id="methodology-body">${methodologyContent(work)}</div>
      </details>
    </div>`;
  }
  const numberKey = `${r.mode}:${r.target}:${r.scenario ?? 'base'}:${unit}`;
  const relative = r.start > Math.max(.01, Math.abs(r.end) * 1e-9) && r.end >= 0 ? 100 * r.change / r.start : null;
  const modes = work.periods ? segments('change-mode', r.mode, [['valuation', 'Расчётный'], ['ml', 'ML-анализ']], 'Сменить режим отчёта', state.generating) : '';
  return `<div class="report-layout">
    <header class="report-header overview-header"><h1>${esc(metricName(work))}</h1>
      <div class="data-actions overview-tools">${modes}${settings}</div>${scope}</header>
    <div class="report-sheet">
      <section class="report-totals" aria-label="Итог сравнения">
        <div class="report-hero"><span>Изменение за период</span><strong class="hero-value" title="${delta(r.change, unit)}">${numberMarkup(numberKey + ':change', r.change, unit, 'change')}</strong>
          ${relative === null ? '' : `<span class="relative-change">${delta(relative, '%')} к началу периода</span>`}</div>
        <dl class="period-figures">
          <div><dt>На начало периода</dt><dd title="${fmt(r.start, unit)}">${numberMarkup(numberKey + ':start', r.start, unit)}</dd></div>
          <div class="period-end"><dt>На конец периода</dt><dd title="${fmt(r.end, unit)}">${icon('arrow')}${numberMarkup(numberKey + ':end', r.end, unit)}</dd></div>
        </dl>
      </section>
      <div class="result-check" role="group" aria-label="Проверка результата">${statusBadge(r.status)}
        <span class="difference" title="${difference.hint}"><span>${difference.label}</span><strong>${gapMarkup(difference.gap)}</strong></span></div>
      <section class="attribution" id="waterfall">
        <header class="chart-head"><h2>Вклады факторов</h2>
          <div class="chart-tools">
          ${segments('analysis-chart', chart, [['waterfall', 'Водопад'], ['contributions', 'Вклады']], 'Вид графика', false, 'bridge-chart')}
          ${expandChart('#bridge-chart')}</div></header>
        <div id="bridge-chart" data-chart-title="Вклады факторов" data-chart-scope="${esc(numberKey)}">${analysisChart(state)}</div>
        <p class="business-conclusion">${conclusion(work)}</p>
      </section>
      <div class="report-actions"><button type="button" class="button primary" data-action="research">Подробный анализ${icon('arrow')}</button>${ask}</div>
    </div>
  </div>`;
}

function cashFlowDetail(work, unit, busy) {
  const detail = work.report.cashDetails;
  if (!detail) return `<section class="diagnostic-detail" id="cash-details">${h2('Детализация денежных потоков', 'Погашения, перенос сроков и изменения условий по общим сделкам.')}
    <button type="button" data-action="diagnostics" class="button primary" ${busy ? 'disabled' : ''}>Разложить денежные потоки</button></section>`;
  const structureLabels = { ASSET: 'Активы', LIABILITY: 'Обязательства', FIXED: 'Фиксированная ставка', FLOAT: 'Плавающая ставка',
    ANN: 'Аннуитет', RGM: 'Равномерное погашение', SIMPLE: 'Основной долг в конце' };
  const structureNames = { side: 'Сторона', discriminator: 'Схема', rate_type_cd: 'Ставка' };
  const chartLabels = { paid_principal: 'Погашения по графику', paid_interest: 'Проценты по графику',
    elapsed_other: 'Прочие плановые платежи', calendar_shift: 'Перенос платежей по срокам', rebase: 'Прогноз при прежних условиях',
    balance: 'Изменение остатка долга', rate: 'Изменение условий ставки', schedule: 'Изменение срока и графика',
    undivided: 'Общий эффект пересмотра' };
  const chart = detail.parts.filter((part) => Math.abs(part.value) >= .005)
    .map((part) => ({ ...part, chartLabel: chartLabels[part.key] }));
  return `<section class="diagnostic-detail" id="cash-details">${h2('Детализация денежных потоков', `Договорные условия проверены для ${detail.covered} из ${detail.common} общих сделок. Проверочных запусков C++ — ${detail.recalculations}.`)}
    ${detail.message ? `<p class="status warn">${esc(detail.message)}</p><button type="button" data-action="diagnostics" class="button" ${busy ? 'disabled' : ''}>Повторить проверку в C++</button>` : ''}
    ${chart.length ? bars(chart, { unit, label: 'Вклады в изменение денежных потоков' }) : ''}
    <details class="details"><summary>Все вклады и их суммы</summary>
      ${table([['Компонент'], ['Вклад', 'num']], detail.parts.map((part) => `<tr><th scope="row">${esc(part.label)}</th><td class="num">${delta(part.value, unit)}</td></tr>`), 'Вклады в изменение денежных потоков')}</details>
    <p class="note">Платежи за прошедший период взяты из прежнего договорного графика. Вклад новых ID уже учтён отдельно на основном графике.</p>
    <details class="details"><summary>Изменение состава портфеля</summary><p class="note">Новых ID ${detail.newlyIssued.added}. Из них ${detail.newlyIssued.count} имеют дату выдачи в интервале. Их остаток на конец с учётом стороны сделки ${endSentence(fmt(detail.newlyIssued.signedBalance, unit))}</p>
      ${table([['Группа'], ['Сделок в начале', 'num'], ['Сделок в конце', 'num'], ['Остаток в начале', 'num'], ['Остаток в конце', 'num']],
        detail.structure.map((item) => `<tr><th scope="row">${esc(structureNames[item.field])} · ${esc(structureLabels[item.label] ?? item.label ?? '—')}</th>
        <td class="num">${item.before}</td><td class="num">${item.after}</td><td class="num">${fmt(item.signedBalanceBefore, unit)}</td><td class="num">${fmt(item.signedBalanceAfter, unit)}</td></tr>`), 'Структура портфеля')}</details>
    ${detail.excluded.length ? `<details class="details"><summary>Почему часть сделок сгруппирована</summary><ul class="inline-notes">${detail.excluded.map((item) => `<li>${esc(item.reason)} · ${item.count}</li>`).join('')}</ul></details>` : ''}
    <p class="note">Эти строки в сумме дают вклад денежных потоков на основном графике. ${link(reportUrl(work, 'cash-details.csv'), 'Детализация CSV')}</p></section>`;
}

function valuationDetail(work) {
  const r = work.report;
  const unit = unitOf(work);
  const descriptions = [['V₀₀', r.states.v00, 'Начальные потоки и веса'], ['V₁₀', r.states.v10, 'Конечные потоки, начальные веса'],
    ['V₀₁', r.states.v01, 'Начальные потоки, конечные веса'], ['V₁₁', r.states.v11, 'Конечные потоки и веса']];
  return `<div id="valuation-detail">${h2('Сверка и четыре пересчёта', 'Подстановка для общих сделок. Веса сопоставляются по относительным бакетам.')}
    <div class="score-strip">${descriptions.map(([name, value, label]) => `<div class="score"><span>${name} · ${label}</span><strong>${fmt(value, unit)}</strong></div>`).join('')}</div>
    <p class="note">Совместный эффект ${delta(r.joint, unit)} уже распределён между денежными потоками и дисконтированием. ${r.target === 'stress_delta' ? 'Вес здесь равен DF выбранного стресса минус DF базы.' : 'Вес здесь равен DF базы.'}</p>
    <details class="details"><summary>Вклады по срокам и видам платежей</summary>${table([['Срок'], ['Платёж'], ['Потоки в начале', 'num'], ['Потоки в конце', 'num'],
      ['Вклад потоков', 'num'], ['Вклад весов', 'num']], r.buckets.map((row) => `<tr><td>${esc(row.bucket)}</td><td>${row.kind === 'PRINCIPAL' ? 'Основной долг' : row.kind === 'INTEREST' ? 'Проценты' : esc(row.kind)}</td>
      <td class="num">${fmt(row.cfBefore, unit)}</td><td class="num">${fmt(row.cfAfter, unit)}</td><td class="num">${delta(row.cash, unit)}</td><td class="num">${delta(row.discount, unit)}</td></tr>`), 'Эффекты по срокам')}</details>
    <ul class="inline-notes">${r.limitations.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></div>`;
}

function interactionPanel(state, work, unit) {
  const r = work.report;
  if (!r.interactions.length) return h2('Совместное влияние факторов', r.model && ['linear', 'median'].includes(r.model.key)
    ? 'Выбранная модель аддитивна по признакам. Парные эффекты в ней равны нулю.' : 'Для оценки пары нужны два изменчивых признака и общие сделки.');
  const keys = r.factors.slice(0, 9).map((item) => item.key);
  const label = (key) => esc(titleOf(work, key));
  const pairIndex = Number.isInteger(state.pair) && r.interactions[state.pair] ? state.pair : 0;
  const selected = r.interactions[pairIndex];
  const axesSelected = new Set([selected.a, selected.b]);
  const max = r.interactions[0].strength || 1;
  const pairName = (item) => `${titleOf(work, item.a)} × ${titleOf(work, item.b)}`;
  const cells = (a, b) => {
    const index = r.interactions.findIndex((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a));
    if (index < 0) return '<td aria-label="Один признак">·</td>';
    const item = r.interactions[index];
    const amount = short(item.strength);
    const name = pairName(item);
    return `<td class="${axesSelected.has(a) || axesSelected.has(b) ? 'heat-axis-selected' : ''}" style="--heat-level:${(7 + 43 * Math.sqrt(item.strength / max)).toFixed(1)}%"><button class="heat-cell"
      type="button" data-action="pair" data-key="${index}" aria-pressed="${index === pairIndex}"
      aria-label="${esc(amount)} · ${esc(name)}" title="${esc(name)} · ${fmt(item.strength, unit)}">${esc(amount)}</button></td>`;
  };
  const rangeLabel = (range) => Array.isArray(range) ? range.map(n).join(' – ') : String(range);
  const profile = selected.profile ?? [];
  const local = selected.local?.find((item) => item.id === state.pairDeal) ?? selected.local?.[0];
  const ranks = new Map(profile.flatMap((series) => series.points).map((point) => [rangeLabel(point.range), point.range]));
  const bands = [...ranks.entries()].sort(([a, first], [b, second]) =>
    Array.isArray(first) && Array.isArray(second) ? first[0] - second[0] : a.localeCompare(b, 'ru')).map(([label]) => label);
  const series = profile.map((item, i) => ({ name: rangeLabel(item.group), color: ['var(--accent)', 'var(--warning)', 'var(--chart-neutral)'][i % 3],
    points: item.points.map((p) => ({ ...p, x: bands.indexOf(rangeLabel(p.range)), label: rangeLabel(p.range) })) }));
  const matrix = `<div class="table-wrap" id="heatmap-chart" data-chart-title="Матрица факторов" tabindex="0"><table class="heatmap" aria-label="Тепловая карта попарных взаимодействий">
      <thead><tr><th scope="col">Фактор</th>${keys.map((key) => `<th scope="col" class="${axesSelected.has(key) ? 'heat-axis-selected' : ''}">${label(key)}</th>`).join('')}</tr></thead>
      <tbody>${keys.map((a) => `<tr><th scope="row" class="${axesSelected.has(a) ? 'heat-axis-selected' : ''}">${label(a)}</th>${keys.map((b) => cells(a, b)).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `<div id="interactions">${h2('Совместное влияние факторов', 'Вклад одного признака в прогноз модели зависит от значения другого.')}
    <label class="field">Пара факторов<select id="pair-select" aria-label="Пара факторов">${r.interactions.map((item, i) => option(i, pairName(item), pairIndex)).join('')}</select></label>
    <details class="details interaction-matrix" open><summary>Матрица факторов</summary>
      <div class="heat-legend note"><span>Сила взаимодействия</span><i aria-hidden="true"></i><span>0 — ${fmt(max, unit)}</span>${expandChart('#heatmap-chart')}</div>${matrix}</details>
    <div id="interaction-detail"><div class="score-strip">${[['Сила в начале', selected.strengthBefore], ['Сила в конце', selected.strength], ['Изменение среднего вклада', selected.change]]
      .map(([name, amount]) => `<div class="score">${name}<strong>${fmt(amount, unit)}</strong></div>`).join('')}</div>
    <p class="note">${selected.rows} из ${selected.population} общих наблюдений. ${selected.estimated ? 'Оценка по выборке.' : 'Использованы все общие наблюдения.'}
      ${selected.stable ? 'Сила воспроизводится в повторных выборках.' : 'Устойчивость пары не подтверждена.'} Интервал ${fmt(selected.low, unit)} – ${endSentence(fmt(selected.high, unit))}</p>
    ${selected.portfolioChange === null ? '' : `<p class="note">Суммарное изменение взаимодействия по общим наблюдениям ${endSentence(delta(selected.portfolioChange, unit))}</p>`}
    ${series.length ? `<h3>Совместный вклад по наблюдаемым диапазонам</h3><p class="note">Ось X — ${label(selected.a)}. Группы — диапазоны ${label(selected.b)}.</p>
      <ul class="legend">${series.map((item) => `<li><i class="swatch" style="background:${item.color}"></i>${esc(item.name)}</li>`).join('')}</ul>
      ${lineChart(series, { unit, title: 'Совместный вклад по диапазонам', xLabel: titleOf(work, selected.a), yLabel: 'Совместный вклад' + (unit ? ' / ' + unit.trim() : ''), axes: bands.map((name, x) => ({ x, label: name })), connect: false, inspect: true })}`
      : '<p class="note">Для графика этой пары мало наблюдений в отдельных диапазонах или пара вне 12 крупнейших.</p>'}
    ${local ? `<div class="local-pair"><label class="field">Наблюдение из выборки<select id="pair-deal" aria-label="Наблюдение из выборки">${selected.local.map((row) => option(row.id, row.id, local.id)).join('')}</select></label><p class="note">Вклад в начале ${delta(local.before, unit)}, в конце ${endSentence(delta(local.after, unit))} Изменение ${endSentence(delta(local.change, unit))}</p></div>` : ''}
    <p class="note">Совместный эффект уже входит во вклады на водопаде.</p></div></div>`;
}

function qualityPanel(work, unit) {
  const r = work.report;
  const quality = `<div class="quality-status">${statusBadge(r.status)}${r.warnings.length ? `<ul class="inline-notes">${r.warnings.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}</div>`;
  if (!r.validation?.length) return `<div id="quality">${h2('Проверка качества модели', 'Для надёжной оценки пока недостаточно истории.')}${quality}</div>`;
  const thresholds = r.reliabilityThresholds;
  return `<div id="quality">${h2('Проверка качества модели', `${esc(r.model.name)} обучена по ${day(r.model.trainedThrough)}. Обе даты сравнения проверены отдельно.`)}
    ${quality}<p class="note quality-definition">MAE показывает, на сколько единиц модель в среднем отклоняется от факта. Чем меньше значение, тем точнее оценка.</p>
    ${table([['Дата'], ['Наблюдений', 'num'], ['MAE', 'num'], ['RMSE', 'num'], ['R²', 'num'], ['Смещение на сделку', 'num'], ['Ошибка суммы', 'num'], ['MAE медианы', 'num']],
      r.validation.map((item) => `<tr><th scope="row">${day(item.date)}</th><td class="num">${item.rows}</td><td class="num">${fmt(item.mae, unit)}</td>
      <td class="num">${fmt(item.rmse, unit)}</td><td class="num">${n(item.r2)}</td><td class="num">${delta(item.bias, unit)}</td>
      <td class="num">${delta(item.aggregateError, unit)}</td><td class="num">${fmt(item.median.mae, unit)}</td></tr>`), 'Ошибки модели разложения')}
    <p class="note">Ошибка изменения суммы по датам ${endSentence(delta(r.aggregateChangeError, unit))} Необъяснённый остаток по общим наблюдениям ${endSentence(gapMarkup(reportGap(r, 'residual', unit)))}</p>
    <details class="details"><summary>Выбор модели до начала сравнения</summary><p class="note">В каждой строке обучение заканчивается до проверки. Выбор сделан по средней MAE.</p>
      ${r.quality.length ? table([['Дата'], ['Обучено по'], ['Медиана', 'num'], ['Ridge', 'num'], ['Случайный лес', 'num'], ['Extra Trees', 'num']],
        r.quality.map((item) => `<tr><th scope="row">${day(item.date)}</th><td>${day(item.trainedThrough)}</td><td class="num">${fmt(item.median, unit)}</td>
        <td class="num">${fmt(item.linear, unit)}</td><td class="num">${fmt(item.forest, unit)}</td><td class="num">${fmt(item.extra, unit)}</td></tr>`), 'Сравнение кандидатов по MAE')
        : '<p class="note">Мало дат для отдельного сравнения кандидатов. Используется базовый случайный лес.</p>'}</details>
    <details class="details"><summary>Устойчивость и ограничения</summary><p class="note">${r.stability.refits} повторных обучений по подвыборкам ID. Корреляция рейтингов ${r.stability.rankCorrelations.map(n).join(' · ')}.</p>
      <p class="note">Численная невязка проверяет, сходятся ли вклады с изменением прогноза модели. Её значение ${endSentence(gapMarkup(reportGap(r, 'numericalGap', unit)))}</p>
      ${thresholds ? `<p class="note">Пороги статуса. Остаток и ошибка изменения суммы до ${n(thresholds.residualAndAggregate * 100)}%, корреляция рейтингов от ${n(thresholds.rank)}, совпадение знака от ${n(thresholds.sign * 100)}%.</p>` : ''}
      <ul class="inline-notes">${r.limitations.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details></div>`;
}

function effectPanel(state, work, unit) {
  const effects = work.report.effects;
  if (!effects.length) return h2('Как меняется связь с показателем', 'Эффекты появятся после проверки модели.');
  const effect = effects.find((item) => item.key === state.effect) ?? effects.find((item) => item.points.length) ?? effects[0];
  const numeric = effect.kind === 'numeric';
  const mode = numeric ? state.effectPlot ?? 'ale' : 'ale';
  const name = titleOf(work, effect.key);
  const xUnit = work.periods && Object.hasOwn(featureUnits, effect.key) && !name.endsWith(`, ${featureUnits[effect.key]}`)
    ? `, ${featureUnits[effect.key]}` : '';
  const plotModes = { ale: 'ALE · локальный эффект', shap: 'SHAP · наблюдаемые вклады',
    ice: 'ICE · отдельные наблюдения', pdp: 'PDP · средняя оценка' };
  const plots = effect.plots;
  const labels = { ale: 'Накопленный локальный эффект', shap: 'Значение признака и вклад SHAP',
    ice: 'Изменение предсказания для отдельных наблюдений', pdp: 'Среднее предсказание по выбранному признаку' };
  const notes = {
    ale: 'ALE усредняет изменения прогноза при небольших изменениях признака в наблюдаемом диапазоне. Ноль соответствует среднему эффекту в выборке.',
    shap: 'SHAP показывает, какую часть отклонения от базового прогноза модель относит к этому признаку. Одна точка соответствует одному наблюдению.',
    ice: 'Линия показывает изменение прогноза для одного наблюдения относительно первой точки. Остальные признаки фиксированы.',
    pdp: 'По вертикали — средний прогноз при заданном значении признака на конечной выборке. Остальные признаки сохраняются.',
  };
  const sourceLabel = numeric ? plotModes[mode] : 'Вклады по категориям';
  let chart;
  if (!numeric) chart = bars(effect.points.map((item) => ({ label: item.x, value: item.value })), { unit, label: sourceLabel });
  else if (mode === 'ice') {
    chart = plots?.ice?.length ? lineChart(plots.ice.map((points, i) => ({ name: `Наблюдение ${i + 1}`, color: i % 3 ? '#9089c3' : 'var(--accent)', points })),
      { title: labels.ice, unit, xLabel: name + xUnit, yLabel: 'Изменение прогноза' + (unit ? ' / ' + unit.trim() : ''), inspect: true }) : '';
  } else {
    const points = mode === 'ale' ? effect.points : plots?.[mode];
    chart = points?.length ? lineChart([{ name, color: 'var(--accent)', points }], { title: labels[mode], unit, connect: mode !== 'shap', xLabel: name + xUnit,
      yLabel: labels[mode] + (unit ? ' / ' + unit.trim() : ''), inspect: true }) : '';
  }
  const affected = plots?.dependencies?.map((key) => titleOf(work, key)).join(', ');
  const warning = !chart ? `<p class="status warn">${esc(plots?.reason ?? 'Для этого графика недостаточно наблюдений.')}${affected ? ' ' + esc(affected) : ''}</p>` : '';
  const records = mode === 'ale' ? effect.points : mode === 'pdp' ? plots?.pdp : [];
  const refits = effect.refitShapes?.length && mode === 'ale' ? `<p class="note">Форма при переобучении на подвыборках. ${effect.refitShapes.map((item) => esc(item.label)).join(' · ')}</p>` : '';
  const unstableShape = mode === 'ale' && effect.shape !== 'unconfirmed' && effect.refitShapes?.some((item) => item.shape !== effect.shape);
  return `<div id="effects" class="panel-head"><div><h2>Как меняется связь с показателем</h2><p class="note">${esc(sourceLabel)}</p></div>
    <div class="effect-controls"><label class="field">Признак<select id="effect-select">${effects.map((item) => option(item.key, titleOf(work, item.key), effect.key)).join('')}</select></label>
      ${numeric ? `<label class="field">Вид графика<select id="effect-plot" aria-label="Вид графика">${Object.entries(plotModes).map(([key, label]) => option(key, label, mode)).join('')}</select></label>` : ''}</div></div>
    <div id="effect-detail">${mode === 'ale' ? `<div class="effect-summary"><strong>${esc(effect.shapeLabel ?? 'Тип зависимости не подтверждён')}</strong><span>${effect.support ?? 0} наблюдений${effect.range ? ` · диапазон ${effect.range.map(n).join(' – ')}` : ''}${effect.stability != null && effect.shape !== 'unconfirmed' ? ` · форма в ${n(effect.stability * 100)}% повторных выборок` : ''}</span></div>` : ''}
    ${mode !== 'ale' && effect.range ? `<p class="note effect-range">Наблюдаемые значения ${effect.range.map(n).join('–')}${esc(xUnit ? ' ' + xUnit.slice(2) : '')}.</p>` : ''}
    ${unstableShape ? '<p class="status warn">Форма основной модели менялась при переобучении. Устойчивость этой зависимости пока не подтверждена.</p>' : ''}
    ${chart || warning}${refits}<p class="note">${numeric ? notes[mode] : 'Средний вклад SHAP по категории. Группы с менее чем тремя наблюдениями скрыты.'}</p>
    ${['ice', 'pdp'].includes(mode) && chart ? `<p class="note">Сетка ограничена центральной частью обучения и конечной даты. Опорная выборка — ${plots.predictionRows} наблюдений. График описывает реакцию модели на подстановку.</p>` : ''}
    ${records?.length ? table([['Значение'], [mode === 'pdp' ? 'Средний прогноз' : 'Эффект', 'num'], ['Наблюдений', 'num'],
      ...(mode === 'ale' && numeric ? [['Наклон на единицу признака', 'num'], ['Разброс при повторной выборке', 'num']] : [])],
      records.map((item) => `<tr><td>${typeof item.x === 'number' ? n(item.x) : esc(item.x)}</td><td class="num">${mode === 'pdp' ? fmt(item.value, unit) : delta(item.value, unit)}</td><td class="num">${item.support}</td>
        ${mode === 'ale' && numeric ? `<td class="num">${delta(item.slope, unit)}</td><td class="num">${item.low == null ? '—' : `${delta(item.low, unit)} – ${delta(item.high, unit)}`}</td>` : ''}</tr>`), 'Данные графика эффекта') : ''}</div>`;
}

export function analysisTab(state) {
  const { workspace: work, tab } = state;
  const r = work.report;
  const unit = unitOf(work);
  if (tab === 'cash') return cashFlowDetail(work, unit, state.generating);
  if (tab === 'contributions') return `<div class="research-contributions">${divergingBars(bridge(work), { unit, active: state.factor })}</div>` + contributionTable(work);
  if (r.mode === 'ml' && ['importance', 'interactions', 'effects'].includes(tab) && r.diagnosticsReady === false) {
    return h2('Углублённая аналитика', 'Дополнительный расчёт запускается по запросу.')
      + `<button type="button" data-action="diagnostics" class="button primary" ${state.generating ? 'disabled' : ''}>Рассчитать детализацию</button>`;
  }
  const factorLabel = (name) => esc(titleOf(work, name));
  if (tab === 'timeline') {
    const points = r.timeline.map((item) => ({ x: Date.parse(item.date), date: item.date, label: day(item.date).slice(0, 5), value: item.value,
      support: item.count, selected: [r.before, r.after].includes(item.date) }));
    return h2('Динамика показателя', 'Сумма метрики по всем наблюдениям на каждую дату. Заполненные точки отмечают даты текущего расчёта.')
      + lineChart([{ name: titleOf(work, r.target), color: 'var(--accent)', points }], {
        unit, title: 'История выбранного показателя', xLabel: 'Отчётная дата', yLabel: metricName(work) + (unit ? ' / ' + unit.trim() : ''),
        inspect: true, period: true, motionKey: [work.id, 'timeline', r.mode, r.target, r.scenario, ...r.timeline.map(item => item.date)].join(':'),
      });
  }
  if (tab === 'importance') {
    const stats = r.importance.filter((item) => item.value !== null);
    const unavailable = r.importance.filter((item) => item.value === null).map((item) => factorLabel(item.key));
    const shared = [...r.importance].sort((a, b) => b.meanAbsShap - a.meanAbsShap)
      .map((item) => ({ ...item, value: item.meanAbsShap, label: titleOf(work, item.key) }));
    return h2('Что важно для модели', 'Оценка по проверочным данным в единицах показателя на сделку.')
      + `<div class="grid-two"><div><h3>Важность по точности модели</h3><p class="note">Насколько растёт ошибка MAE, если перемешать значения признака на проверочной дате.</p>
        ${bars(stats.map((item) => ({ ...item, label: titleOf(work, item.key) })), { unit, label: 'Глобальная важность по росту MAE' })}</div>
        <div><h3>Средний модуль вклада SHAP</h3><p class="note">По общим сделкам на конечную дату сравнения.</p>
        ${bars(shared, { unit, label: 'Глобальная важность по среднему модулю SHAP' })}</div></div>`
      + (stats.length ? table([['Признак'], ['Средний рост MAE', 'num'], ['Минимум по датам', 'num'], ['Максимум по датам', 'num'], ['Дат', 'num']],
        stats.map((item) => `<tr><th scope="row">${factorLabel(item.key)}</th><td class="num">${delta(item.value, unit)}</td><td class="num">${delta(item.low, unit)}</td>
          <td class="num">${delta(item.high, unit)}</td><td class="num">${item.folds.length}</td></tr>`), 'Глобальная важность по датам') : '')
      + (r.groupedImportance?.length ? `<details class="details"><summary>Коррелирующие группы признаков</summary>${table([['Группа'], ['Рост MAE', 'num']], r.groupedImportance.map((item) => `<tr><th scope="row">${item.keys.map(factorLabel).join(', ')}</th><td class="num">${delta(item.value, unit)}</td></tr>`), 'Перестановка групп')}</details>` : '')
      + (r.marketImportance ? `<details class="details"><summary>Совместная важность общих признаков даты</summary><p class="note">Рост MAE ${endSentence(delta(r.marketImportance.value, unit))} Использованы ${r.marketImportance.dates.length} независимых дат и отдельная модель ${esc(r.marketImportance.model)}, обученная до ${day(r.marketImportance.trainedThrough)}.</p></details>` : '')
      + (r.stability?.importanceAcrossDates ? `<p class="note">Совпадение рейтингов перестановочной важности между двумя датами. Спирмен ${n(r.stability.importanceAcrossDates.spearman)}, признаков ${r.stability.importanceAcrossDates.features.length}.</p>` : '')
      + (unavailable.length ? `<p class="note">${unavailable.join(', ')}. Эти признаки постоянны внутри проверочных дат, поэтому внутридневная перестановка для них неинформативна.</p>` : '');
  }
  if (tab === 'interactions') return interactionPanel(state, work, unit);
  if (tab === 'effects') return effectPanel(state, work, unit);
  if (tab === 'quality') return qualityPanel(work, unit);
  return '';
}

export function assistantStatus(state) {
  const { health, answer } = state;
  const provider = health?.ai?.provider;
  let title = 'Проверенные факты';
  let tone = 'local';
  if (answer?.mode === 'llm') {
    title = answer.provider === 'deepseek' ? 'DeepSeek ответил' : 'Локальная модель ответила';
    tone = 'ready';
  } else if (answer?.status === 'forbidden' || !answer && health?.ai?.status === 'forbidden') {
    title = 'Внешний AI запрещён';
  } else if (['unavailable', 'timeout', 'authorization', 'payment', 'limited', 'model_unavailable'].includes(answer?.status)
      || !answer && health?.ai?.status === 'unavailable') {
    title = 'AI временно недоступен';
  } else if (!answer && health?.llm) {
    title = provider === 'deepseek' ? 'DeepSeek настроен' : 'Локальная модель';
    tone = 'ready';
  }
  return `<span class="assistant-status ${tone}"><i aria-hidden="true"></i>${title}</span>`;
}

const pageQuestions = {
  curves: ['Чем отличаются короткие и длинные ставки?', 'Что означают P, K и D?', 'Откуда взяты кривые?'],
  scenarios: ['Почему PV отличается от базы?', 'Какой сценарий самый неблагоприятный?', 'Какие сроки дали главный вклад?'],
  portfolio: ['Какие типы сделок в портфеле?', 'Как распределяются сроки?', 'Что показывают договорные потоки?'],
  data: ['Есть ли пропуски и выбросы?', 'Какие признаки исключены из-за утечки цели?', 'Достаточно ли истории?'],
};

export function assistantPanel(state) {
  const { workspace: work, assistantContext: context } = state;
  const analysisQuestions = work?.report?.mode === 'valuation'
    ? [metricQuestion(work), 'Как повлияла кривая ставок?', 'Как повлияли погашения?']
    : ['Какие факторы главные?', context?.analysisFocus?.kind === 'effect'
        ? 'Какая форма зависимости у выбранного признака?' : 'Какие факторы взаимодействуют?', 'Насколько надёжен результат?'];
  const questions = context?.page === 'analysis' ? analysisQuestions : pageQuestions[context?.page];
  const header = `<div class="assistant-resize" role="separator" tabindex="0" aria-label="Ширина помощника" aria-orientation="vertical" data-assistant-resize></div>
    <header class="drawer-head"><div><h2 id="assistant-title" tabindex="-1">${icon('spark')}Спектр AI</h2>
      ${context ? `<div id="assistant-status">${assistantStatus(state)}</div>` : ''}</div>
      <div class="drawer-tools"><button class="icon-button assistant-minimize" type="button" data-action="minimize-assistant" aria-label="Свернуть помощника" title="Свернуть">${icon('minus')}</button>
      <form method="dialog"><button class="icon-button" aria-label="Закрыть помощника">${icon('close')}</button></form></div></header>`;
  if (!context) return header + `<div class="drawer-body"><p class="note">${state.route === 'curves'
    ? 'Выберите готовый запуск кривых и нажмите «Спросить AI», чтобы обсудить его.' : 'Загрузите данные или откройте готовый расчёт, чтобы задать вопрос.'}</p></div>`;
  return header + `
    <div class="drawer-body assistant" id="assistant">
    <div class="assistant-context"><small>${esc(context.reportLabel || pages[context.page])}</small><p>${esc(context.title)}</p>${context.subtitle ? `<span>${esc(context.subtitle)}</span>` : ''}</div>
    <div class="question-list" aria-label="Быстрые вопросы">${questions.map((question) =>
      `<button type="button" data-action="question" data-key="${esc(question)}">${esc(question)}${icon('chevron')}</button>`).join('')}</div>
    <div id="answer" aria-live="polite" aria-busy="${state.asking}">${assistantConversation(state)}</div>
    <details class="assistant-limits"><summary>Как формируется ответ</summary>
      <p class="note">Ассистент опирается на готовые результаты. С разрешения DeepSeek получает только допустимые агрегаты и очищенный вопрос.
      Для загруженных данных облачная обработка требует отдельно настроенной политики. Источники открываются из ответа.</p></details>
    </div>
    <footer class="assistant-composer">
    <form class="ask-form" id="explain-form"><label class="sr-only" for="question">Вопрос по расчёту</label>
      <div class="ask-input"><input type="text" id="question" name="question" maxlength="300" placeholder="Задать вопрос…" value="${esc(state.question)}">
      <button class="button primary icon-button" type="submit" aria-label="Объяснить" ${state.asking ? 'disabled' : ''}>${icon('arrow')}</button></div>
      <label id="assistant-consent" class="check" ${state.health?.ai?.provider === 'deepseek' && state.health?.llm ? '' : 'hidden'}>
        <input type="checkbox" name="allowExternal" ${state.allowExternal ? 'checked' : ''}> Разрешить отправку агрегатов в DeepSeek</label>
    </form>
    <div class="assistant-actions">
      <button type="button" class="text-button" data-action="new-dialogue">Новый диалог</button>
      ${context.page === 'analysis' ? '<button type="button" class="text-button" data-action="prepare-summary">Сформировать аналитическое резюме</button>' : ''}
    </div>
    </footer>`;
}

export function assistantConversation(state) {
  const latest = state.turns.at(-1);
  const showingTurn = latest?.answer === state.answer;
  const older = showingTurn ? state.turns.slice(0, -1) : state.turns;
  const history = older.length ? `<details class="assistant-history"><summary>Предыдущие вопросы (${older.length})</summary>
    ${older.map(({ question, answer }) => `<section class="assistant-turn"><p class="user-question">${esc(question)}</p>${explanation(answer)}</section>`).join('')}</details>` : '';
  const summary = state.assistantContext?.page === 'analysis' && state.summary && state.answer !== state.summary
    ? `<details class="assistant-history"><summary>Сохранённое резюме</summary>${explanation(state.summary)}</details>` : '';
  const waiting = state.asking ? `<p class="note assistant-pending">Ожидаем ответ по текущему расчёту…</p>
    <button type="button" class="text-button" data-action="cancel-explanation">Отменить ожидание</button>` : '';
  const active = !state.asking && state.answer ? `<section class="assistant-response">${showingTurn ? `<p class="user-question">${esc(latest.question)}</p>` : ''}
    ${explanation(state.answer)}</section>` : '';
  const notice = state.assistantMessage ? `<p class="note">${esc(state.assistantMessage)}</p>` : '';
  return waiting + notice + active + history + summary;
}

export function explanation(answer) {
  if (!answer) return '';
  if (answer.error) return `<p class="status error">${esc(answer.error)}</p>`;
  const failures = { forbidden: 'Облачная обработка для этих данных отключена.', unconfigured: 'AI не настроен.',
    protected_question: 'Вопрос обработан локально.', no_verified_answer: 'Модель не нашла подтверждённого ответа.',
    authorization: 'Провайдер отклонил авторизацию.', payment: 'Провайдер отклонил запрос из-за состояния счёта.',
    limited: 'Провайдер ограничил частоту запросов.', timeout: 'Провайдер не ответил вовремя.',
    model_unavailable: 'Выбранная модель недоступна.', invalid_response: 'Не удалось проверить ответ модели.',
    response_limit: 'Ответ модели превысил лимит.', context_limit: 'Контекст превышает лимит.',
    unavailable: 'AI временно недоступен.', busy: 'AI обрабатывает другой запрос.' };
  const mode = answer.mode === 'llm'
    ? (answer.provider === 'deepseek' ? 'Объяснение DeepSeek проверено по источникам.' : 'Факты подобраны локальной моделью.')
    : (failures[answer.status] ? failures[answer.status] + ' ' : '') + 'Показаны проверенные факты расчёта.';
  if (answer.empty) return `<p class="note">${esc(answer.empty)}</p>`;
  const sections = answer.sections ?? [{ title: 'Результат', facts: answer.facts }];
  return `<p class="note checks-note">${esc(mode)}</p>${sections.map((section) => `<div class="explanation-section"><h3>${esc(section.title)}</h3>
    <ul class="facts">${section.facts.map((fact) => `<li><p>${esc(fact.text)}</p><div class="fact-links">
      ${(fact.sources?.length ? fact.sources : [fact]).map((ref) => `<button type="button" class="ghost source" data-action="fact-source"
        aria-label="Открыть источник · ${esc(ref.title)}" data-key="${esc(ref.source)}" data-detail="${esc(ref.detail ?? '')}">
        ${esc(ref.title)}</button>`).join('')}</div></li>`).join('')}</ul></div>`).join('')}`;
}

function termLabel(label) {
  const units = { d: 'д.', m: 'мес.', y: 'г.' };
  return label.replace(/(\d)([dmy])$/, (_, value, unit) => value + ' ' + units[unit]);
}

export function scenarioPage(state) {
  const { workspace: work } = state;
  const title = 'Чувствительность к ставкам';
  if (!work?.periods?.length) return heading(title, '')
    + empty('Нужен портфель с рассчитанными потоками', 'Создайте тестовый портфель или загрузите архив со снимками калькулятора.',
      `<a href="#portfolio" data-action="new-run" class="button primary">Создать тестовый портфель</a>${uploadHistoryLink('Загрузить снимки')}`);
  const dates = work.periods.map((item) => item.date);
  const item = work.periods.find((item) => item.date === state.scenarioDay) ?? work.periods.at(-1);
  const stresses = item.scenarios.filter((entry) => entry.code !== 'base');
  const worst = stresses.reduce((current, value) => current.delta <= value.delta ? current : value);
  const active = stresses.find((entry) => entry.code === state.scenarioCode) ?? worst;
  const base = item.scenarios.find((entry) => entry.code === 'base');
  const plotted = (code) => item.curves[code].map((p) => ({ x: Math.log1p(p.years), value: p.rate, label: termLabel(p.label) }));
  const curveDomain = Object.values(item.curves).flatMap((curve) => curve.map((point) => point.rate)).filter(Number.isFinite);
  const scenarioNumber = (name, value, format) => numberMarkup(`${work.id}:${item.date}:${name}`, value, ' ₽', format);
  const buckets = (item.bucketDeltas?.[active.code] ?? []).filter((entry) => Math.abs(entry.value) >= 0.01)
    .map((entry) => ({ ...entry, label: termLabel(entry.label) }));
  return heading(title, '', assistantButton) + `
    <div class="scenario-toolbar toolbar"><label class="field">Отчётная дата<select id="scenario-date">${dateOpts(dates, item.date)}</select></label>
      <span class="scope-meta">${n(item.deals)} сделок · ${esc(curveSources[item.curveSource] ?? 'Сохранённый снимок')}</span>
      <button class="button small" type="button" data-action="compare-scenario" data-key="${esc(active.code)}"
        data-date="${esc(item.date)}">Разобрать изменение сценария</button></div>
    <dl class="scenario-values" aria-label="Оценка сценария">
      <div><dt>PV базы</dt><dd title="${fmt(base.pv, ' ₽')}">${scenarioNumber('base', base.pv)}</dd></div>
      <div><dt>PV при выбранном стрессе</dt><dd title="${fmt(active.pv, ' ₽')}">${scenarioNumber('stress', active.pv)}</dd></div>
      <div><dt>ΔPV к базе</dt><dd class="${tone(active.delta)}" title="${delta(active.delta, ' ₽')}">${scenarioNumber('delta', active.delta, 'signed')}</dd></div>
    </dl>
    <div class="scenario-layout">
      <section class="rate-panel">
        <h2>Кривые ставок</h2>
        <ul class="legend"><li><i class="swatch"></i>Базовая</li><li><i class="swatch selected"></i>${esc(codes[active.code])}</li></ul>
        ${lineChart([{ name: 'Базовая', color: 'var(--accent)', points: plotted('base') },
          { name: codes[active.code], color: 'var(--muted-strong)', points: plotted(active.code), dash: '6 4', morph: true }],
          { title: 'Базовая и выбранная стрессовая кривые', unit: '%', xLabel: 'Срок (логарифмическая шкала)', yLabel: 'Доходность, % годовых', tall: true,
            domain: curveDomain, motionKey: `${work.id}:${item.date}:curves`, inspect: true })}
        <a class="text-button" href="${esc(snapshotUrl(work, item))}">Открыть использованные кривые${icon('arrow')}</a>
      </section>
      <section class="stress-picker" aria-label="Стресс для сравнения">
        <h2>Сценарии</h2>
        <div class="stress-list" role="group" aria-label="Выбор сценария">${stresses.map((entry) =>
          `<button type="button" data-action="scenario" data-key="${esc(entry.code)}" aria-pressed="${active.code === entry.code}">
            <span>${esc(codes[entry.code])}${entry === worst ? '<small>Наиболее неблагоприятный</small>' : ''}</span>
            <strong class="${tone(entry.delta)}">${delta(entry.delta, ' ₽')}</strong></button>`).join('')}</div>
      </section>
    </div>
    <details class="details technical" id="scenario-results" data-scenario-detail="results"><summary>Оценки и выгрузки для всех сценариев</summary>
      <p class="note">PV — стоимость будущих платежей на выбранную дату.</p>
      ${table([['Сценарий'], ['PV, ₽', 'num'], ['Разница с базой, ₽', 'num']], item.scenarios.map((entry) =>
        `<tr class="${entry === active ? 'is-selected' : ''}"><th scope="row">${esc(codes[entry.code] ?? entry.name)}</th>
        <td class="num">${fmt(entry.pv, ' ₽')}</td><td class="num ${tone(entry.delta)}">${delta(entry.delta, ' ₽')}</td></tr>`), 'PV всех сделок по сценариям')}
      <div class="data-actions">${link(exportUrl(work, item.date + '/discounted_deal_summary.csv'), 'PV по сделкам')}
        ${link(exportUrl(work, item.date + '/standard-result.json'), 'Снимок кривых')}</div>
    </details>
    <details class="details scenario-buckets" id="scenario-buckets" data-scenario-detail="buckets" open><summary>Вклад сроков платежей</summary>
      <p class="note">В каждом интервале сравниваются оценки платежей по двум кривым.</p>
      ${buckets.length ? expandChart('#scenario-bucket-chart') + '<div id="scenario-bucket-chart" data-chart-title="Вклад сроков платежей">' + bars(buckets, { unit: ' ₽', label: 'Вклад сроков платежей', motionKey: `${work.id}:${item.date}:buckets` }) + '</div>'
        : '<p class="note">Вклады по срокам меньше копейки или отсутствуют.</p>'}
      <p class="note">Общий эффект ${delta(active.delta, ' ₽')}. Договорные проценты за год ${fmt(item.interest12, ' ₽')}.</p>
    </details>`;
}

function input(name, label, value, limits) {
  return `<label class="field">${label}<input ${limits} name="${name}" value="${esc(value)}" required></label>`;
}

const defaultPortfolio = {
  count: 120, monthly: 16, periods: 7, valuationDate: '2026-10-30', seed: '4317', amountMin: 200000, amountMax: 1100000,
  termMin: 12, termMax: 84, rateMin: 10, rateMax: 19, liabilityShare: 0, annuity: 60, linear: 30, bullet: 10,
  fixed: 70, floating: 30, benchmark: 14, termProfile: 'uniform',
};
const termProfiles = { uniform: 'Равномерно', short: 'Больше коротких', long: 'Больше длинных' };
const sources = { api: 'Рыночные кривые через API', saved: 'Сохранённые рыночные кривые', fixture: 'Учебные кривые (офлайн)' };
const sourceNotes = {
  api: 'Кривые MOEX на каждую отчётную дату через API команды 2.',
  saved: 'Сохранённые рыночные снимки на те же даты с исходными Run ID.',
  fixture: 'Синтетические кривые для проверки расчёта без подключения к MOEX.',
};

function distribution(label, entries) {
  const complete = entries.every(([, value]) => Number.isFinite(value) && value >= 0 && value <= 100)
    && Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 100) < .00001;
  const buttons = entries.map(([name, value, field], index) => `<li>
    <button class="distribution-key" type="button" data-action="edit-portfolio" data-key="${field}" data-segment="${index}">
      <i class="series-${index}" aria-hidden="true"></i><span>${esc(name)}</span><b>${Number.isFinite(value) ? n(value) + '%' : '—'}</b>
    </button></li>`).join('');
  return `<section class="distribution"><h3>${label}</h3>
    <div class="distribution-track" aria-hidden="true">${complete ? entries.map(([, value], i) => `<i class="series-${i}" style="width:${value}%"></i>`).join('') : ''}</div>
    <ul>${buttons}</ul>${complete ? '' : '<p class="note">Допустимые доли в сумме дают 100%.</p>'}</section>`;
}

function termShares(settings) {
  const min = +settings.termMin, max = +settings.termMax;
  if (!Number.isInteger(min) || min < 1 || !Number.isInteger(max) || max > 360 || max < min) return [];
  const width = max - min + 1;
  const sections = Math.min(3, width);
  const cdf = (value) => settings.termProfile === 'short' ? Math.sqrt(value)
    : settings.termProfile === 'long' ? 1 - Math.sqrt(1 - value) : value;
  return Array.from({ length: sections }, (_, index) => {
    const low = Math.ceil(index * width / sections), high = Math.ceil((index + 1) * width / sections);
    const name = high === low + 1 ? `${min + low} мес.` : `${min + low}–${min + high - 1} мес.`;
    return [name, (cdf(high / width) - cdf(low / width)) * 100, 'termProfile'];
  });
}

export function portfolioPreview(raw) {
  const settings = { ...defaultPortfolio, ...raw };
  const values = ['count', 'monthly', 'periods'].map((key) => raw?.[key] === '' ? NaN : +settings[key]);
  const [count, monthly, periods] = values;
  const validPeriods = Number.isInteger(periods) && periods >= 4 && periods <= 12;
  const validCount = Number.isInteger(count) && count >= 20 && count <= 1500;
  const validMonthly = Number.isInteger(monthly) && monthly >= 0 && monthly <= 250;
  const planned = validCount && validMonthly && validPeriods
    ? count + monthly * (periods - 1) : null;
  const ratio = (key) => settings[key] === '' ? NaN : +settings[key];
  const terms = termShares(settings);
  const last = new Date(settings.valuationDate + 'T00:00:00Z');
  const validDate = Number.isFinite(last.getTime()) && last.toISOString().slice(0, 10) === settings.valuationDate
    && settings.valuationDate >= '2020-01-01' && settings.valuationDate <= '2099-12-31';
  const dates = validDate && validPeriods ? snapshotDates(settings.valuationDate, periods) : [];
  const dateRange = dates.length
    ? `${dates[0].slice(0, 4) === dates.at(-1).slice(0, 4) ? day(dates[0]).slice(0, 5) : day(dates[0])} — ${day(dates.at(-1))}`
    : '';
  const periodValues = [['count', 'На старте', validCount ? n(count) : '—'],
    ['monthly', 'Новых в месяц', validMonthly ? n(monthly) : '—'], ['periods', 'Отчётных дат', validPeriods ? n(periods) : '—']];
  return `<div class="portfolio-plan"><span>Запланировано уникальных сделок</span>
    <strong>${planned == null ? '—' : n(planned)}</strong>
    <p class="note">${planned > 1500 ? 'Допустимо до 1 500 сделок за весь период.'
      : 'Стартовый набор и все новые выдачи за период.'}</p>
    <div class="portfolio-preview-figures">${periodValues.map(([field, label, value]) => `<button type="button" data-action="edit-portfolio" data-key="${field}">
      <span>${label}</span><b>${value}</b></button>`).join('')}</div></div>
    <details class="details portfolio-calendar"><summary>Календарь выдач${dateRange ? `<span>${dateRange}</span>` : ''}</summary>
    <div class="portfolio-date-list">
      ${dates.length ? `<ol aria-label="Планируемые выдачи по отчётным датам">${dates.map((date, index) =>
        `<li><time datetime="${date}">${day(date)}</time><span>${index === 0 ? 'Стартовый набор' : 'Новые сделки'}</span><b>${index === 0 ? periodValues[0][2] : periodValues[1][2]}</b></li>`).join('')}</ol>`
        : '<p class="note">Проверьте конечную дату и число отчётных дат.</p>'}
      <button type="button" class="text-button" data-action="edit-portfolio" data-key="valuationDate">Изменить конечную дату${icon('arrow')}</button>
    </div></details>
    <details class="details distribution-details" open><summary>Распределения</summary><div class="distribution-list">
      ${distribution('Сторона сделки', [['Активы', 100 - ratio('liabilityShare'), 'liabilityShare'], ['Обязательства', ratio('liabilityShare'), 'liabilityShare']])}
      ${distribution('График платежей', [['Аннуитетные', ratio('annuity'), 'annuity'], ['Дифференцированные', ratio('linear'), 'linear'], ['В конце срока', ratio('bullet'), 'bullet']])}
      ${distribution('Тип ставки', [['Фиксированная', ratio('fixed'), 'fixed'], ['Плавающая', ratio('floating'), 'floating']])}
      ${terms.length ? distribution('Сроки при генерации', terms) : '<section class="distribution"><h3>Сроки при генерации</h3><p class="note">Проверьте диапазон сроков.</p></section>'}
    </div></details>`;
}

export function portfolioProgress(job) {
  if (!job) return '';
  const message = job.message ?? '';
  if (job.state === 'failed') return `<div class="status error portfolio-failure">
    <p role="alert">${esc(message)}</p>
    ${job.retrySettings ? '<button class="button small" type="button" data-action="retry-portfolio">Повторить расчёт</button>' : ''}
  </div>`;
  const total = job.total || 1;
  const stage = job.state === 'ready' ? 4 : /сверка выгрузок/i.test(message) ? 3
    : /дисконтирован|рассчитано/i.test(message) ? 2 : /калькулятор команды 1/i.test(message) ? 1
      : /подготовка кривых/i.test(message) ? 0 : -1;
  return `<section class="panel integration-progress" aria-label="Ход расчёта">
    <h2>${job.state === 'ready' ? 'Расчёт завершён' : 'Ход расчёта'}</h2>
    <ol>${['Кривые ставок', 'Денежные потоки', 'Дисконтирование', 'Факторные вклады'].map((label, i) =>
      `<li class="${i < stage ? 'done' : i === stage ? 'active' : ''}" ${i === stage ? 'aria-current="step"' : ''}><span>${i < stage ? icon('check') : i + 1}</span>${label}</li>`).join('')}</ol>
    <div class="progress-caption"><span>${esc(message)}</span>${job.state === 'ready' ? '' : `<span>Отчётных дат готово ${job.done || 0} из ${total}</span>`}</div>
    <progress aria-label="Готовность расчёта" max="${total}" value="${job.state === 'ready' ? total : (job.done || 0)}"></progress>
  </section>`;
}

export function holdingsDateNote(date) {
  return `${n(date.deals)} действующих сделок на ${day(date.date)}. Откройте ID, чтобы посмотреть платежи.`;
}

export function portfolioPage(state) {
  const work = state.workspace;
  const last = work?.periods?.at(-1);
  const settings = { ...defaultPortfolio, ...work?.settings, ...state.draft };
  const selected = last && state.portfolioTab === 'holdings' ? 'holdings' : 'builder';
  const title = heading('Портфель', '', selected === 'holdings' ? assistantButton : '');
  const navigation = last ? segments('portfolio-tab', selected, [['builder', 'Конструктор'], ['holdings', 'Состав портфеля']], 'Портфель') : '';
  const progress = `<div id="portfolio-progress" aria-live="polite">${portfolioProgress(state.portfolioJob)}</div>`;
  if (selected === 'holdings') {
    const date = work.periods.find((period) => period.date === state.portfolioDay) ?? last;
    const pin = state.curveSelection;
    const toUpdate = pin && work.periods.find((period) => period.date === pin.reportDate);
    const selection = toUpdate ? `<div class="curve-selection" aria-label="Выбранные кривые">
      <p>${toUpdate.runId === pin.runId ? 'Этот запуск уже применён' : 'Выбран новый запуск кривых'} · ${day(pin.reportDate)}</p>
      ${toUpdate.runId !== pin.runId ? `<p class="note">Текущая оценка относится к прежнему снимку. Переоценка применит выбранные коэффициенты к тем же платежам за эту дату и сохранит новую ревизию.</p>
        <button class="button" type="button" data-action="curve-revalue" ${state.generating ? 'disabled' : ''}>Переоценить портфель</button>` : ''}
      <button class="text-button" type="button" data-action="curve-clear">Снять выбор</button></div>` : '';
    return title + navigation + progress + selection + `<section class="panel holdings" id="portfolio-holdings" data-date="${date.date}"><header class="panel-head"><div><h2>Состав портфеля</h2>
      <p class="note" data-holdings-date>${holdingsDateNote(date)}</p></div>
      <div class="data-actions">${link(exportUrl(work, date.date + '/calculator_input.csv'), 'CSV для калькулятора')}
        <a class="button small" href="#analysis" data-action="overview">Открыть факторный анализ</a></div></header>
      <div id="holding-overview"></div>
      <details class="details"><summary>Результаты калькулятора</summary><div class="data-actions">
        ${link(exportUrl(work, date.date + '/deal_summary.csv'), 'Сводка по сделкам')}
        ${link(exportUrl(work, date.date + '/cashflows.csv'), 'Платежи CSV')}
        ${link(exportUrl(work, date.date + '/discounted_deal_summary.csv'), 'PV по сделкам')}
      </div></details>
      <form class="toolbar deal-search" id="deal-search"><label class="field">Дата<select id="portfolio-date">${dateOpts(work.periods.map((p) => p.date), date.date)}</select></label>
        <label class="field">ID сделки<input type="search" name="query" value="${esc(state.dealQuery ?? '')}" placeholder="Например, 120"></label>
        <button class="button primary" type="submit">Найти</button>
        <button class="button" type="button" data-action="deal-reset">Сбросить</button>
        <div class="deal-filters" aria-label="Фильтры сделок">
          ${[['side', 'Сторона сделки'], ['payment_type', 'Схема платежей'], ['rate_type', 'Тип ставки']].map(([key, label]) =>
            `<label class="field">${label}<select name="${key}" aria-label="${label}" data-deal-filter="${key}"><option value="">Все</option></select></label>`).join('')}
        </div></form>
      <p class="note" data-holdings-loading role="status" hidden></p>
      <div id="deal-table" aria-live="polite"><p class="note">Загрузка списка сделок…</p></div></section>`;
  }
  const ranges = [
    ['amountMin', 'Сумма от, ₽', 'number" min="0.01" step="0.01'], ['amountMax', 'Сумма до, ₽', 'number" min="0.01" step="0.01'],
    ['termMin', 'Срок от, мес.', 'number" min="1" max="360'], ['termMax', 'Срок до, мес.', 'number" min="1" max="360'],
    ['rateMin', 'Ставка от, %', 'number" min="0" max="100" step="0.01'], ['rateMax', 'Ставка до, %', 'number" min="0" max="100" step="0.01'],
  ];
  const curve = settings.curveSource ?? 'api';
  return title + navigation + progress + `<div class="portfolio-layout">
    <form class="panel builder" id="generate-form">
      <section><h2>Размер и период</h2>
        <div class="form-grid">
          ${input('count', 'Сделок на старте', settings.count, 'type="number" min="20" max="1500"')}
          ${input('monthly', 'Новых сделок в месяц', settings.monthly, 'type="number" min="0" max="250"')}
          ${input('periods', 'Число отчётных дат', settings.periods, 'type="number" min="4" max="12"')}
          ${input('valuationDate', 'Конечная отчётная дата', settings.valuationDate, 'type="date"')}
        </div>
        <p class="note">Предыдущие даты приходятся на последние будни месяца.</p>
      </section>
      <section><h2><label for="portfolio-curve-source">Источник кривых</label></h2>
        <div class="field curve-source"><select id="portfolio-curve-source" name="curveSource" aria-describedby="curve-note">
          ${Object.entries(sources).map(([key, title]) => option(key, title, curve)).join('')}</select></div>
        <p class="note" id="curve-note">${sourceNotes[curve] ?? sourceNotes.api}</p>
        ${state.curveSelection ? `<div id="pinned-curve" class="curve-selection" ${curve !== 'api' ? 'hidden' : ''}>
          <p class="note">Закреплён выбранный запуск на ${day(state.curveSelection.reportDate)}. Остальные даты используют собственные стандартные кривые.</p>
          <button class="text-button" type="button" data-action="curve-clear">Снять выбор</button></div>` : ''}
      </section>
      <details class="details builder-advanced"><summary>Дополнительные параметры сделок</summary>
        <fieldset><legend>Суммы и сроки</legend><div class="form-grid">
          ${ranges.slice(0, 4).map(([name, label, rule]) => input(name, label, settings[name], `type="${rule}"`)).join('')}
          <label class="field">Распределение сроков<select name="termProfile">
            ${Object.entries(termProfiles).map(([key, label]) => option(key, label, settings.termProfile)).join('')}</select></label></div></fieldset>
        <fieldset><legend>Процентные ставки</legend><div class="form-grid">
          ${ranges.slice(4).map(([name, label, rule]) => input(name, label, settings[name], `type="${rule}"`)).join('')}
          ${[['fixed', 'Фиксированная ставка, %'], ['floating', 'Плавающая ставка, %'], ['benchmark', 'Тестовый плавающий индекс, %']]
            .map(([key, label]) => input(key, label, settings[key], 'type="number" min="0" max="100" step="0.01"')).join('')}</div></fieldset>
        <fieldset><legend>Графики выплат</legend><div class="form-grid">
          ${[['annuity', 'Аннуитетных, %'], ['linear', 'Дифференцированных, %'], ['bullet', 'С телом в конце, %']]
            .map(([key, label]) => input(key, label, settings[key], 'type="number" min="0" max="100" step="0.01"')).join('')}</div></fieldset>
        <fieldset><legend>Состав и воспроизводимость</legend><div class="form-grid">
          ${input('liabilityShare', 'Доля обязательств, %', settings.liabilityShare, 'type="number" min="0" max="100" step="0.01"')}
          ${input('seed', 'Код генерации', settings.seed, 'type="text" maxlength="64"')}</div></fieldset>
        <p class="note">Доли схем платежей и типов ставки в каждой группе должны давать 100%.</p>
      </details>
      <div class="form-actions"><button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Создать тестовый портфель${icon('arrow')}</button>
        ${uploadHistoryLink('Загрузить снимки ZIP', 'text-button')}</div>
    </form>
    <aside class="panel portfolio-preview" aria-label="Параметры будущего портфеля"><div id="portfolio-preview">${portfolioPreview(settings)}</div></aside>
  </div>`;
}

export function portfolioCurveNote(source) {
  return sourceNotes[source] ?? sourceNotes.api;
}

export function holdingsOverview(overview, periods) {
  const { principal, distributions } = overview;
  const sides = distributions.side;
  const names = [['Активы', 'ASSET'], ['Обязательства', 'LIABILITY']];
  const groups = [['Тип ставок', 'rate_type'], ['Схема платежей', 'payment_type'], ['Срок до погашения', 'terms']];
  return `<dl class="holdings-metrics">${names.map(([name, type]) => `<div><dt>${name} · ${n(sides[name] ?? 0)} сделок</dt>
    <dd title="${fmt(Number(principal[type]), ' ₽')}">${compact(Number(principal[type]), ' ₽')}</dd></div>`).join('')}
    <div><dt>История</dt><dd>${dateCountLabel(periods.length)}</dd></div></dl>
    <p class="note">Остаток основного долга по действующим сделкам на выбранную дату.</p>
    <details class="details"><summary>Структура по ставкам, платежам и срокам</summary><div class="holding-distributions">
      ${groups.map(([title, code]) => `<div><h3>${title}</h3><dl>${Object.entries(distributions[code]).map(([label, count]) =>
        `<div><dt>${esc(label)}</dt><dd>${n(count)}</dd></div>`).join('')}</dl></div>`).join('')}</div></details>`;
}

export function dealTable(data) {
  if (!data.rows.length) return '<p class="note">Совпадений нет.</p>';
  const cols = [['ID'], ['Остаток', 'num'], ['Ставка, %', 'num'], ['Срок, лет', 'num'], ['График'], ['Сторона'], ['PV базы', 'num']];
  const lines = data.rows.map((row) => `<tr><th scope="row"><button class="ghost" type="button" aria-haspopup="dialog" data-action="flow" data-key="${esc(row.deal_id)}">${esc(row.deal_id)}</button></th>
    <td class="num">${exact(+row.principal, ' ₽')}</td><td class="num">${n(+row.contract_rate)}</td><td class="num">${n(+row.term_years)}</td>
    <td>${esc(row.payment_type)}</td><td>${row.side === 'LIABILITY' ? 'Обязательство' : 'Актив'}</td><td class="num">${exact(+row.npv, ' ₽')}</td></tr>`);
  const count = Math.ceil(data.size / data.pageSize);
  return table(cols, lines, 'Найденные сделки') + `<div class="pagination">
    <button class="button small" data-action="deal-page" data-key="${data.page - 1}" ${data.page ? '' : 'disabled'}>Назад</button>
    <span>${data.page + 1} из ${count} · ${data.size} сделок</span>
    <button class="button small" data-action="deal-page" data-key="${data.page + 1}" ${data.page + 1 < count ? '' : 'disabled'}>Дальше</button></div>`;
}

export function flowDialog(data, workspace) {
  const labels = { INTEREST: 'Проценты', PRINCIPAL: 'Основной долг' };
  const c = data.contract ?? {};
  const unit = c.currency_id === 'RUB' ? ' ₽' : c.currency_id ? ' ' + c.currency_id : '';
  const dateLabel = (value) => value ? day(value) : '';
  const contract = [
    ['Сторона', c.side === 'ASSET' ? 'Актив' : c.side === 'LIABILITY' ? 'Обязательство' : c.side],
    ['Валюта', c.currency_id], ['Дата выдачи', dateLabel(c.deal_dttm)], ['Дата погашения', dateLabel(c.maturity_dttm)],
    ['Остаток основного долга', c.current_principal_amt ? exact(+c.current_principal_amt, unit) : ''],
    [c.rate_type_cd === 'FLOAT' ? 'Договорная надбавка' : 'Договорная ставка', c.interest_rate ? n(+c.interest_rate * 100) + '%' : ''],
    ['Индекс плавающей ставки', c.rate_type_cd === 'FLOAT' && c.base_indicator_rate ? n(+c.base_indicator_rate * 100) + '%' : ''],
    ['Тип ставки', c.rate_type_cd === 'FIXED' ? 'Фиксированная' : c.rate_type_cd === 'FLOAT' ? 'Плавающая' : c.rate_type_cd],
    ['Схема погашения', Object.hasOwn({ ANN: 1, RGM: 1, SIMPLE: 1 }, c.discriminator) ?
      ({ ANN: 'Аннуитет', RGM: 'Равномерное', SIMPLE: 'По договорному графику' })[c.discriminator] : c.discriminator],
    ['PV базы', data.prices?.base ? exact(+data.prices.base, unit) : ''],
  ].filter(([, value]) => value);
  const rows = data.rows.map((row) => `<tr><td>${day(row.payment_date)}</td><td>${esc(Object.hasOwn(labels, row.cash_flow_type) ? labels[row.cash_flow_type] : row.cash_flow_type)}</td>
    <td class="num">${fmt(+row.amount, unit)}</td><td class="num">${row.rate_used ? n(+row.rate_used * 100) + '%' : '—'}</td></tr>`);
  const stress = Object.entries(data.prices ?? {}).filter(([key]) => Object.hasOwn(codes, key));
  const principal = data.totals?.total_principal;
  const interest = data.totals?.total_interest;
  const total = principal != null && interest != null ? `<p class="note">Основной долг ${fmt(+principal, unit)} · Проценты ${fmt(+interest, unit)}
    · Всего ${fmt(+principal + +interest, unit)}</p>` : '';
  const cashByType = new Map(Object.keys(labels).map((type) => [type, new Map()]));
  for (const row of data.rows) {
    const days = cashByType.get(row.cash_flow_type);
    const date = Date.parse(row.payment_date), amount = Number(row.amount);
    if (days && Number.isFinite(date) && Number.isFinite(amount)) days.set(date, (days.get(date) ?? 0) + amount);
  }
  const payments = [...cashByType].map(([type, days]) => ({ name: labels[type], color: type === 'PRINCIPAL' ? 'var(--accent)' : 'var(--chart-positive)',
    points: [...days].map(([x, value]) => ({ x, value, label: day(new Date(x).toISOString().slice(0, 10)) })) }));
  const paymentChart = payments.some(({ points }) => points.length) ? `<h3>График договорных платежей</h3>
    <ul class="legend"><li><i class="swatch"></i>Основной долг</li><li><i class="swatch interest"></i>Проценты</li></ul>
    ${lineChart(payments, { title: 'Договорные платежи по датам', unit, connect: false, xLabel: 'Дата платежа' })}` : '';
  return `<header class="drawer-head"><div><h2 id="inspector-title">Платежи по сделке № ${esc(data.id)}</h2><p class="note">${day(data.date)} · ${data.rows.length} строк калькулятора</p></div>
    <form method="dialog"><button class="button small">Закрыть</button></form></header>
    <div class="drawer-body"><dl class="contract-details">${contract.map(([title, value]) => `<div><dt>${title}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
    ${stress.length ? `<details class="details"><summary>PV по стрессовым сценариям</summary>${table([['Сценарий'], ['PV', 'num']],
      stress.map(([key, value]) => `<tr><th scope="row">${codes[key]}</th><td class="num">${fmt(+value, unit)}</td></tr>`), 'PV по стрессовым сценариям')}</details>` : ''}
    ${total}${paymentChart}
    ${table([['Дата'], ['Вид платежа'], ['Сумма','num'], ['Ставка','num']], rows, 'Платежи по сделке')}
    <p class="note">${link(exportUrl(workspace, data.date + '/cashflows.csv'), 'Денежные потоки всего портфеля')}</p></div>`;
}


function filePicker(name, title, accepts) {
  return `<div class="file-field"><label class="field" for="${name}">${title}</label>
    <label class="file-picker"><input class="sr-only" id="${name}" type="file" name="${name}" accept="${accepts}" aria-label="${title}" aria-describedby="${name}-selected" required>
      <span class="file-pick-label" aria-hidden="true">Выбрать файл</span><span class="file-name" id="${name}-selected">Файл не выбран</span>
    </label><p class="note negative" id="${name}-warning" data-file-warning role="alert" hidden></p></div>`;
}

export function servicesList(health) {
  if (!health) return '<li>Проверяем сервисы…</li>';
  if (health.unavailable) return '<li>Состояние неизвестно</li>';
  const provider = health.ai?.provider === 'local' ? 'Локальная модель' : 'DeepSeek';
  return Object.entries({ calculator: 'Калькулятор', curves: 'Кривые ставок', llm: provider }).map(([key, label]) => {
    const facts = key === 'llm' && health.ai?.provider === 'facts';
    const status = facts ? 'Проверенные факты' : key === 'llm' && health.ai?.status === 'configured'
      ? 'Настроен' : health[key] ? 'Подключено' : 'Недоступно';
    return `<li><span>${label}</span><span>${status}</span></li>`;
  }).join('');
}

export function uploadBox(format) {
  return format === 'csv' ? `<div class="upload-box">
      <p class="note">CSV для анализа зависимостей. Одна строка на ID и дату, до 6 МБ и 20 000 строк.</p>
      <form id="import-form" class="upload-form">${filePicker('csvfile', 'Файл истории', '.csv,.tsv,text/csv')}
      <button class="button primary" type="submit" disabled>Загрузить CSV</button></form>
      <a class="text-button" href="/api/example.csv">Скачать учебный CSV</a></div>`
      : `<div class="upload-box">
      <p class="note">Платежи, PV и кривые на совпадающие даты. От двух дат, архив до 16 МБ.</p>
      <form id="history-form" class="upload-form">${filePicker('history', 'Архив снимков', '.zip,application/zip')}
      <button class="button primary" type="submit" disabled>Загрузить ZIP</button>
      <label class="check"><input type="checkbox" name="bank"> Банковская выгрузка</label></form></div>`;
}

export function dataPage(state) {
  const work = state.workspace;
  const integrated = Boolean(work?.periods);
  const format = state.sourceFormat;
  const choice = segments('source-format', format, [['csv', 'Таблица CSV'], ['zip', 'Снимки ZIP']], 'Формат загрузки');
  const importer = `<section class="panel data-import">
    <header class="panel-head"><h2>Загрузка</h2>${choice}</header>${uploadBox(format)}
  </section>`;
  const title = heading('Данные', '', work?.profile ? assistantButton : '');
  const connections = `<details class="details technical" id="data-services"><summary>Подключения</summary>
    <ul id="services" class="service-list" aria-live="polite">${servicesList(state.health)}</ul></details>`;
  if (!work?.profile) return title + importer + connections;

  const columns = work.profile.columns ?? [];
  const opts = work.options;
  const prefs = { ...opts, ...state.mapping };
  const targets = integrated ? opts.targets : columns.filter((col) => col.kind === 'numeric' && col.missing === 0
    && ![prefs.dateColumn, prefs.idColumn].includes(col.name)).map((col) => col.name);
  const exclude = new Set([prefs.dateColumn, prefs.idColumn, prefs.target]);
  const audited = state.preview?.featureAudit ?? work.report?.featureAudit ?? [];
  const audits = new Map(audited.map((item) => [item.name, item]));
  const candidates = columns.filter((col) => !exclude.has(col.name) && col.kind !== 'date' && (!integrated || opts.candidateFeatures.includes(col.name)));
  const picked = new Set(prefs.features ?? work.report?.settings?.features ?? candidates.filter((col) => col.distinct > 1).map((col) => col.name));
  const dateFields = columns.filter((col) => col.kind === 'date' && !col.missing).map((col) => col.name);
  const dates = state.preview?.dates ?? opts.dates ?? work.profile.dates ?? [];
  const ids = state.preview?.distinctIds ?? work.profile.distinctIds ?? work.uniqueDeals;
  const bad = columns.filter((col) => col.missing > 0 || col.outliers > 0).length;
  const factorCount = state.preview?.featureCount ?? work.report?.selectedFeatures?.length;
  const ready = Boolean(prefs.dateColumn && prefs.idColumn && prefs.target);
  const field = (name, label, keys) => `<label class="field">${label}<select name="${name}" data-column="${name}" aria-label="${label}">
    ${option('', 'Выберите колонку', prefs[name])}${keys.map((key) => option(key, titleOf(work, key), prefs[name])).join('')}</select></label>`;
  const kinds = { numeric: 'Числовой', category: 'Категория', date: 'Дата' };
  const columnRows = columns.map((col) => `<tr><th scope="row">${esc(titleOf(work, col.name))}</th><td>${kinds[col.kind]}</td>
    <td class="num">${n(col.missing)}</td><td class="num">${n(col.distinct)}</td><td class="num">${n(col.outliers)}</td>
    <td class="num">${col.kind === 'numeric' ? n(col.min) + ' … ' + n(col.max) : '—'}</td></tr>`);
  const sourceNames = [...new Set(work.periods?.map((item) => curveSources[item.curveSource] ?? 'Сохранённые кривые') ?? [])];
  const evidence = integrated ? `<details class="details sources technical" id="data-sources"><summary>Источники расчёта</summary>
    <div class="panel-head"><p class="note">${esc(portfolioSources[work.portfolioSource] ?? 'Загруженные сделки')}. Источник кривых — ${esc(sourceNames.join(', '))}.</p>
    ${link(exportUrl(work, 'history.zip'), 'Скачать историю ZIP')}</div>
    ${table([['Дата'], ['Сделок', 'num'], ['Строк платежей', 'num'], ['Источник кривых'], ['Выгрузки']],
      work.periods.map((period) => `<tr><th scope="row">${day(period.date)}</th><td class="num">${n(period.deals)}</td><td class="num">${n(period.flowRows)}</td>
        <td>${esc(curveSources[period.curveSource] ?? 'Сохранённый снимок')}</td>
        <td class="table-links"><a href="${exportUrl(work, period.date + '/calculator_input.csv')}">Вход</a> <a href="${esc(snapshotUrl(work, period))}">Кривые</a>
        <a href="${exportUrl(work, period.date + '/cashflows.csv')}">Потоки</a> <a href="${exportUrl(work, period.date + '/discounted_deal_summary.csv')}">PV</a></td></tr>`), 'Источники расчёта')}
    <details class="details"><summary>Идентификаторы расчётов и контрольные суммы</summary>
      <p class="note">Workspace ID <code>${esc(work.id)}</code> · Методика ${esc(work.method)}</p>
      ${table([['Дата'], ['Run ID'], ['SHA-256'], ['P / K / D, п. п.']],
      work.periods.map((period) => `<tr><th scope="row">${day(period.date)}</th><td class="mono">${esc(period.runId)}</td>
        <td class="mono">${esc(period.sha256)}</td><td>${period.curveParameters
          ? ['p', 'k', 'd'].map((key) => n(period.curveParameters[key])).join(' / ') : 'В снимке JSON'}</td></tr>`), 'Идентификаторы исходных снимков')}</details></details>` : '';
  const preview = work.profile.preview?.length ? `<details class="details"><summary>Предпросмотр строк</summary>${table(columns.map((col) => [esc(col.name)]),
    work.profile.preview.map((row) => `<tr>${columns.map((col) => `<td>${esc(row[col.name])}</td>`).join('')}</tr>`), 'Предпросмотр таблицы')}</details>` : '';
  const metrics = [['Строк', work.profile.rows], ['Дат', dates.length], ['Уникальных ID', ids], ['Колонок с замечаниями', bad]];
  const quality = `<section class="panel data-quality" id="data-quality">
    <header class="panel-head"><div><h2>Качество исходных данных</h2><p class="note">${integrated
      ? 'Снимки прошли проверку формата калькулятора и кривых.' : esc(work.filename ?? 'Загруженная таблица')}</p></div>
      ${link(exportUrl(work, 'dataset.csv'), 'Экспорт таблицы')}</header>
    <div class="quality-grid">${metrics.map(([name, value]) => `<div><strong>${n(value)}</strong><span>${name}</span></div>`).join('')}</div>
    ${preview}<details class="details"><summary>Технический профиль колонок</summary>
      <p class="note">Замечания включают пропуски и выбросы. Выбросы отмечены по межквартильному размаху.</p>
      ${table([['Колонка'], ['Тип'], ['Пропуски', 'num'], ['Уникальных', 'num'], ['Выбросы', 'num'], ['Диапазон', 'num']], columnRows, 'Профиль колонок')}
    </details></section>`;
  const mapping = `<details class="details data-mapping technical" id="data-setup" ${!work.report || state.mapping ? 'open' : ''}>
      <summary>Настройка анализа зависимостей</summary>
      <header class="panel-head"><p class="note">${candidates.length} потенциальных факторов${factorCount != null ? `, ${factorCount} отобрано` : ''}.</p>
      <span id="mapping-verified" class="result-status verified" ${state.preview ? '' : 'hidden'}>Структура проверена</span></header>
      <form id="mapping-form">
        <div class="mapping-step"><h3>Колонки и период</h3><div class="form-grid">
          ${integrated ? '' : field('dateColumn', 'Дата', dateFields) + field('idColumn', 'ID', columns.map((col) => col.name))}
          ${field('target', 'Целевой показатель', targets)}
          ${integrated ? '' : `<label class="field">Единица измерения<input name="unit" maxlength="20" value="${esc(prefs.unit ?? '')}" placeholder="Например, рубли"></label>
            <label class="field">Агрегация<select name="aggregation">${option('sum', 'Сумма по наблюдениям', prefs.aggregation ?? 'sum')}${option('mean', 'Среднее или коэффициент', prefs.aggregation)}</select></label>`}
          <label class="field">Начальная дата<select name="before">${option('', 'Предпоследняя', prefs.before)}${dateOpts(dates, prefs.before ?? work.report?.before)}</select></label>
          <label class="field">Конечная дата<select name="after">${option('', 'Последняя', prefs.after)}${dateOpts(dates, prefs.after ?? work.report?.after)}</select></label></div>
          <p class="note">Выберите показатель, который можно суммировать по наблюдениям.</p></div>
        <div class="mapping-step"><h3>Факторы</h3>
          <p class="note">Для обучения используются прошлые даты. Исключите признаки, рассчитанные на основе целевого показателя или будущих данных.</p>
          <details class="details" ${state.preview ? 'open' : ''}><summary>Проверить или изменить факторы</summary>
            <div class="criteria feature-list" role="group" aria-label="Признаки модели">${candidates.map((col) => {
              const audit = audits.get(col.name);
              return `<label class="check"><input type="checkbox" name="feature" value="${esc(col.name)}" ${picked.has(col.name) ? 'checked' : ''}>
                <span>${esc(titleOf(work, col.name))}${audit?.reason ? `<small>${esc(audit.reason)}</small>` : ''}</span></label>`;
            }).join('')}</div></details></div>
        <div class="form-actions"><button class="button" type="button" data-action="check-mapping" ${!ready || state.generating ? 'disabled' : ''}>Проверить структуру</button>
          <button class="button primary" type="submit" ${!ready || state.generating ? 'disabled' : ''}>Рассчитать вклады</button></div>
      </form></details>`;
  return title + importer + quality + mapping + evidence + connections;
}
