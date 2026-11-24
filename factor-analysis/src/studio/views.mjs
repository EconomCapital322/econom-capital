import { bars, lineChart, waterfall, day, esc, exact, n, short, signed, tone } from './charts.mjs';

export const pages = { analysis: 'Факторный анализ', scenarios: 'Сценарии ставок', portfolio: 'Портфель', data: 'Данные' };
export const tabs = { timeline: 'История метрики', importance: 'Важность факторов', interactions: 'Взаимодействия', effects: 'Нелинейные эффекты', quality: 'Проверка модели', explanation: 'Объяснение' };
export const codes = { parallel_up: 'Параллельный вверх', parallel_down: 'Параллельный вниз', steepener: 'Увеличение наклона',
  flattener: 'Уменьшение наклона', short_rate_up: 'Короткие ставки вверх', short_rate_down: 'Короткие ставки вниз' };
const help = {
  principal: 'Остаток основного долга, который заёмщики ещё должны вернуть.',
  contract_rate: 'Годовая договорная ставка в процентах. У плавающих сделок это тестовый индекс плюс надбавка.',
  term_years: 'Срок от отчётной даты до погашения. Меняет горизонт будущих платежей.',
  age_years: 'Время от выдачи до отчётной даты в годах.',
  payment_type: 'Схема возврата тела долга. Она влияет на распределение платежей по датам.',
  rate_type: 'Тип договорной ставки: фиксированная или плавающая.',
  market_1y: 'Ставка базовой кривой в бакете до года. Она общая для всех сделок на одну дату.',
  market_5y: 'Ставка базовой кривой в бакете до пяти лет. Она общая для всех сделок на одну дату.',
};
const chartLabels = {
  principal: 'Остаток долга', contract_rate: 'Ставка сделки', term_years: 'Срок сделки',
  age_years: 'Возраст', payment_type: 'Схема выплат', rate_type: 'Тип ставки',
  market_1y: 'Кривая 1 год', market_5y: 'Кривая 5 лет',
};
const exportUrl = (workspace, path) => '/api/export/' + workspace.id + '/' + path;
export const titleOf = (work, key) => {
  if (key === 'stress_delta' && (work.report?.scenario || work.scenario)) return 'ΔPV · ' + codes[work.report?.scenario || work.scenario];
  return Object.hasOwn(work.options?.labels ?? {}, key) ? work.options.labels[key] : key;
};
const unitOf = (work) => work.report?.unit ? ' ' + work.report.unit : work.periods ? ' ₽' : '';
const fmt = (value, unit) => esc(exact(value, unit));
const delta = (value, unit) => esc(signed(value, unit));
const compact = (value, unit) => esc(short(value, unit));
const statuses = { verified: 'Сверено с калькулятором', stable: 'Модельное объяснение устойчиво',
  caution: 'Требуется осторожность', insufficient: 'Недостаточно данных', unavailable: 'Анализ недоступен' };
export const reportTabs = (work) => work?.report?.mode === 'valuation'
  ? { timeline: 'История метрики', calculation: 'Детали расчёта', explanation: 'Объяснение' } : tabs;
const reportUrl = (work, filename) => exportUrl(work, 'reports/' + work.report.analysisId + '/' + filename);
const stressOptions = (value) => Object.entries(codes).map(([key, label]) => option(key, label, value)).join('');
export const dateOpts = (dates, selected) => dates.map((value) => option(value, day(value), selected)).join('');
export const option = (key, label, selected) => `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`;
const heading = (title, note, action = '') => `<div class="page-heading"><div><h1>${title}</h1><p class="sub">${note}</p></div>${action}</div>`;
const h2 = (title, note) => `<div class="panel-head"><div><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}</div></div>`;
const link = (url, text) => `<a class="button small" href="${esc(url)}">${esc(text)}</a>`;
const empty = (title, body, actions = '') => `<section class="panel empty"><h2>${title}</h2><p class="sub">${body}</p>${actions ? `<div class="form-actions">${actions}</div>` : ''}</section>`;
const card = (label, amount, note, kind = '', tooltip = '') => `<article class="metric ${kind}">
  <em>${label}</em><strong title="${esc(tooltip)}">${amount}</strong><small>${note}</small></article>`;
const table = (heads, rows, label) => `<div class="table-wrap" tabindex="0" aria-label="${esc(label)}"><table class="datagrid" aria-label="${esc(label)}">
  <thead><tr>${heads.map((head) => `<th scope="col" class="${head[1] ?? ''}">${head[0]}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('')}</tbody></table></div>`;

export function bridge(work) {
  const { report: r } = work;
  const rows = [{ key: 'added', label: 'Новые сделки', value: r.additions, description: `${r.added} сделок появились к конечной дате.` }];
  rows.push({ key: 'removed', label: 'Выбывшие сделки', value: r.exclusions, description: `${r.removed} сделок есть только на начальную дату.` });
  for (const factor of r.factors.slice(0, 4)) rows.push({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
    chartLabel: work.source === 'integrated' ? chartLabels[factor.key] : null,
  });
  const rest = r.factors.slice(4);
  if (rest.length) rows.push({
    key: 'other', label: 'Остальные факторы', value: rest.reduce((total, item) => total + item.value, 0),
    description: 'Сумма вкладов остальных признаков по сделкам, присутствующим на обе даты.',
  });
  rows.push(r.mode === 'valuation'
    ? { key: 'reconciliation', label: 'Невязка', value: r.reconciliation, description: 'Разница с фактическими итогами калькулятора. Проверяет арифметику в пределах контракта.' }
    : { key: 'residual', label: 'Остаток', value: r.residual, description: 'Наблюдаемое изменение по общим сделкам за вычетом изменения, предсказанного моделью.' });
  return rows;
}

export function factorDetails(work, key) {
  const { report: r } = work;
  const unit = unitOf(work);
  const bars = bridge(work);
  const extras = [{ key: 'start', label: 'Начало', value: r.start, description: `Сумма целевой метрики на ${day(r.before)}.` },
    { key: 'end', label: 'Конец', value: r.end, description: `Сумма целевой метрики на ${day(r.after)}.` }];
  const modelFactor = r.factors.find((item) => 'factor:' + item.key === key);
  const item = [...bars, ...extras].find((item) => item.key === key)
    ?? (modelFactor ? { ...modelFactor, key, label: titleOf(work, modelFactor.key) } : bars[0]);
  let detail = item.description ? `<p class="note">${esc(item.description)}</p>` : '';
  if (modelFactor && r.mode === 'valuation') {
    const cash = modelFactor.key === 'cash_effect';
    const before = cash ? r.states.v10 - r.states.v00 : r.states.v01 - r.states.v00;
    const after = cash ? r.states.v11 - r.states.v01 : r.states.v11 - r.states.v10;
    detail = `<p class="note">${cash ? 'Объединяет погашения, договорные изменения и перенос платежей по срокам.' : 'Изменение готовых весов на сопоставимых сроках.'}</p>
      <dl><dt>На начальном состоянии</dt><dd>${delta(before, unit)}</dd><dt>На конечном состоянии</dt><dd>${delta(after, unit)}</dd></dl>
      <details><summary>Как рассчитано</summary><p class="note">Среднее эффекта в двух порядках подстановки. По срокам и видам платежей смотрите «Детали расчёта».</p></details>`;
  } else if (modelFactor) {
    const show = (facts) => facts.kind === 'numeric'
      ? n(facts.mean)
      : Object.entries(facts.levels).slice(0, 3).map(([level, count]) => `${esc(level)} · ${count}`).join('<br>');
    detail = `<p class="note">${esc((work.source === 'integrated' ? help[modelFactor.key] : null) ?? 'Вклад рассчитан по значениям признака в загруженной истории.')}</p>
      <dl><dt>${day(r.before)}</dt><dd>${show(modelFactor.before)}</dd><dt>${day(r.after)}</dt><dd>${show(modelFactor.after)}</dd></dl>
      <p class="note">Диапазон при повторной выборке общих сделок</p>
      <p class="note numeral">${delta(modelFactor.low, unit)} … ${delta(modelFactor.high, unit)}</p>
      <details><summary>Как рассчитано</summary><p class="note">${esc(r.model?.name ?? '')}. Вклад по общим наблюдениям, разность между датами.</p>
      ${modelFactor.refits?.length ? `<p class="note">Вклады при повторном обучении<br>${modelFactor.refits.map((value) => delta(value, unit)).join(' · ')}</p>` : ''}</details>`;
  } else if (key === 'other') {
    detail += `<dl>${r.factors.slice(4).map((factor) => `<dt>${esc(titleOf(work, factor.key))}</dt><dd>${delta(factor.value, unit)}</dd>`).join('')}</dl>`;
  }
  const opts = [...extras.slice(0, 1), ...bars, ...r.factors.slice(4).map((factor) => ({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
  })), extras[1]];
  return `<label class="field factor-menu"><span class="sr-only">Фактор на графике</span><select id="factor-select">${opts.map((entry) => option(entry.key, entry.label, item.key)).join('')}</select></label>
    <div class="factor-content"><h3>${esc(item.label)}</h3><p class="figure-value ${extras.includes(item) ? '' : tone(item.value)}">${extras.includes(item) ? fmt(item.value, unit) : delta(item.value, unit)}</p>${detail}</div>`;
}

export function analysisPage(state) {
  const { workspace: work, tab, factor } = state;
  if (!work?.report) {
    return heading('Факторный анализ', 'Разложение изменения показателя между двумя датами.')
      + empty(work ? 'Настройте колонки исходной таблицы' : 'Подготовьте историю портфеля',
        work ? esc(work.setupError || 'Укажите колонку отчётной даты, идентификатор сделки и целевой показатель.')
          : 'Создайте синтетический портфель и запустите калькулятор на нескольких датах. Можно загрузить свою историю сделок в CSV.',
        link('#portfolio', 'Открыть генератор') + link('#data', 'Загрузить историю'));
  }
  const r = work.report;
  const unit = unitOf(work);
  const active = factor ?? bridge(work)[0].key;
  const warnings = r.warnings.length ? `<aside class="status warn" aria-label="Ограничения расчёта">${r.warnings.map((item) => `<p>${esc(item)}</p>`).join('')}</aside>` : '';
  const method = r.mode === 'valuation' ? 'Расчёт по денежным потокам и кривым' : 'Статистическая модель';
  const draft = state.comparison ?? {};
  const mode = draft.mode ?? r.mode ?? 'ml';
  const availableTargets = mode === 'valuation' ? ['npv', 'stress_delta'] : work.options.targets;
  const chosen = draft.target ?? r.target;
  const selected = availableTargets.includes(chosen) ? chosen : availableTargets[0];
  const scenario = draft.scenario || (r.scenario !== 'base' && r.scenario) || work.scenario || 'parallel_up';
  const relative = r.start > Math.max(.01, Math.abs(r.end) * 1e-9) && r.end >= 0 ? ` · ${esc(signed(100 * (r.change / r.start), '%'))}` : '';
  const largest = r.factors[0];
  const best = largest && r.factors.reduce((a, b) => Math.abs(a.value) >= Math.abs(b.value) ? a : b);
  const output = r.analysisId ? `<details class="export"><summary class="button small">Экспорт</summary><div>${link(reportUrl(work, 'analysis.json'), 'Отчёт JSON')}${link(reportUrl(work, 'factors.csv'), 'Вклады CSV')}${r.diagnosticsReady === false ? '' : link(reportUrl(work, 'interactions.csv'), 'Взаимодействия CSV')}${r.mode === 'ml' ? link(reportUrl(work, 'quality.csv'), 'Качество CSV') : ''}</div></details>` : '';
  const change = (r.change > 0 ? '+' : '') + compact(r.change, unit);
  const tabsForMode = reportTabs(work);
  return heading('Факторный анализ', `${esc(titleOf(work, r.target))} · ${method}`, output) + `
    <form class="toolbar compare-toolbar" id="compare-form">
      ${work.periods ? `<label class="field">Режим<select name="mode" id="analysis-mode" aria-label="Режим">${option('valuation', 'Расчётный', mode)}${option('ml', 'Универсальный ML', mode)}</select></label>` : ''}
      <label class="field">Показатель<select id="metric" name="target" aria-label="Показатель">${availableTargets.map((key) => option(key, key === 'stress_delta' ? 'ΔPV стресса к базе' : titleOf(work, key), selected)).join('')}</select></label>
      ${selected === 'stress_delta' && work.periods ? `<label class="field">Стресс<select name="scenario" id="analysis-scenario">${stressOptions(scenario)}</select></label>` : ''}
      <label class="field">Начальная дата<select id="from" name="before">${dateOpts(r.profile.dates, draft.before ?? r.before)}</select></label>
      <label class="field">Конечная дата<select id="to" name="after">${dateOpts(r.profile.dates, draft.after ?? r.after)}</select></label>
      <button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Разложить изменение</button>
    </form>
    <div class="analysis-context"><span>${day(r.before)} — ${day(r.after)}</span><span class="result-status ${esc(r.status || 'caution')}">${statuses[r.status] ?? 'Требуется осторожность'}</span></div>
    <section class="metrics" aria-label="Изменение выбранного показателя">
      ${card('Начальная оценка', compact(r.start, unit), day(r.before), '', exact(r.start, unit))}
      ${card('Конечная оценка', compact(r.end, unit), day(r.after), '', exact(r.end, unit))}
      ${card('Изменение', change, 'Конец минус начало' + relative, r.change < 0 ? 'delta-down' : 'delta-up', signed(r.change, unit))}
      ${r.mode === 'valuation' ? card('Расчётная невязка', r.reconciliation ? '&lt; 0,01' + esc(unit) : compact(0, unit), 'Модуль разницы с фактическими PV', '', r.decimal?.reconciliation ?? '')
        : card('Необъяснённый остаток', compact(r.residual, unit), 'Часть вне модели', '', signed(r.residual, unit))}
    </section>
    ${warnings}
    <section class="panel waterfall-panel" id="waterfall">
      <div class="panel-head"><div><h2>Что изменило показатель</h2>
        <p class="note">${r.matched} общих наблюдений · ${r.added} новых · ${r.removed} выбывших</p></div>
        <ul class="legend"><li><i class="swatch up"></i>Положительный вклад</li><li><i class="swatch down"></i>Отрицательный вклад</li><li><i class="swatch residual"></i>${r.mode === 'valuation' ? 'Невязка' : 'Остаток'}</li></ul>
      </div>
      <div class="analysis-main"><div id="bridge-chart">${waterfall({ start: r.start, end: r.end, bars: bridge(work), active, unit })}</div>
        <div class="divider" id="factor-details" aria-live="polite">${factorDetails(work, active)}</div></div>
      <p class="result-note">${best ? `По общим наблюдениям наибольший вклад по модулю дали <strong>${esc(titleOf(work, best.key))}</strong> (${delta(best.value, unit)}).` : 'Доступно фактическое изменение и изменение состава.'}
      ${r.mode === 'ml' && r.model ? ` Изменение по модели ${delta(r.modelChange, unit)}. Расчётная невязка ${delta(r.numericalGap, unit)}.` : ''}</p>
      <details class="details"><summary>Полное разложение в таблице</summary>
        ${table([['Компонент'], ['Значение', 'num']], [
          ['Начало', r.start], ['Новые сделки', r.additions], ['Выбывшие сделки', r.exclusions],
          ...r.factors.map((item) => [titleOf(work, item.key), item.value]),
          [r.mode === 'valuation' ? 'Расчётная невязка' : 'Необъяснённый остаток', r.mode === 'valuation' ? r.reconciliation : r.residual], ['Конец', r.end],
        ].map(([label, value]) => `<tr><th scope="row">${esc(label)}</th><td class="num">${fmt(value, unit)}</td></tr>`), 'Полное разложение')}
      </details>
    </section>
    <section class="panel flush" id="analysis-tabs">
      <div class="tabs" role="group" aria-label="Детали факторного анализа">
        ${Object.entries(tabsForMode).map(([key, label]) => `<button data-action="tab" data-key="${key}" aria-pressed="${tab === key}">${label}</button>`).join('')}
      </div>
      <div class="tab-body" id="tab-body">${analysisTab(state)}</div>
    </section>`;
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
  if (!r.interactions.length) return h2('Взаимодействия', r.model && ['linear', 'median'].includes(r.model.key)
    ? 'Выбранная модель аддитивна по признакам. Парные эффекты в ней равны нулю.' : 'Для оценки пары нужны два изменчивых признака и общие сделки.');
  const keys = r.factors.slice(0, 9).map((item) => item.key);
  const label = (key) => esc(titleOf(work, key));
  const pairIndex = Number.isInteger(state.pair) && r.interactions[state.pair] ? state.pair : 0;
  const selected = r.interactions[pairIndex];
  const max = r.interactions[0].strength || 1;
  const pairName = (item) => `${titleOf(work, item.a)} × ${titleOf(work, item.b)}`;
  const cells = (a, b) => {
    const index = r.interactions.findIndex((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a));
    if (index < 0) return '<td aria-label="Один признак">·</td>';
    const item = r.interactions[index];
    return `<td style="background:rgba(74,145,131,${(.07 + .45 * Math.sqrt(item.strength / max)).toFixed(3)})"><button class="heat-cell"
      type="button" data-action="pair" data-key="${index}" aria-pressed="${index === pairIndex}"
      title="${esc(pairName(item))} · ${fmt(item.strength, unit)}">${short(item.strength)}</button></td>`;
  };
  const rangeLabel = (range) => Array.isArray(range) ? range.map(n).join(' – ') : String(range);
  const profile = selected.profile ?? [];
  const local = selected.local?.find((item) => item.id === state.pairDeal) ?? selected.local?.[0];
  const ranks = new Map(profile.flatMap((series) => series.points).map((point) => [rangeLabel(point.range), point.range]));
  const bands = [...ranks.entries()].sort(([a, first], [b, second]) =>
    Array.isArray(first) && Array.isArray(second) ? first[0] - second[0] : a.localeCompare(b, 'ru')).map(([label]) => label);
  const series = profile.map((item, i) => ({ name: rangeLabel(item.group), color: ['#2d5880', '#94642d', '#286e65'][i],
    points: item.points.map((p) => ({ ...p, x: bands.indexOf(rangeLabel(p.range)), label: rangeLabel(p.range) })) }));
  return `<div id="interactions">${h2('Взаимодействия факторов', 'Сила пары — средний модуль совместного вклада на наблюдение. Темнее означает сильнее.')}
    <label class="field">Пара факторов<select id="pair-select" aria-label="Пара факторов">${r.interactions.map((item, i) => option(i, pairName(item), pairIndex)).join('')}</select></label>
    <div class="score-strip">${[['Сила в начале', selected.strengthBefore], ['Сила в конце', selected.strength], ['Изменение среднего вклада', selected.change]]
      .map(([name, amount]) => `<div class="score">${name}<strong>${fmt(amount, unit)}</strong></div>`).join('')}</div>
    <p class="note">${selected.rows} из ${selected.population} общих наблюдений. ${selected.estimated ? 'Оценка по выборке.' : 'Использованы все общие наблюдения.'}
      ${selected.stable ? 'Сила воспроизводится в повторных выборках.' : 'Устойчивость пары не подтверждена.'} Интервал ${fmt(selected.low, unit)} – ${fmt(selected.high, unit)}.</p>
    ${selected.portfolioChange === null ? '' : `<p class="note">Суммарное изменение взаимодействия по общим наблюдениям ${delta(selected.portfolioChange, unit)}.</p>`}
    ${series.length ? `<h3>Совместный вклад по наблюдаемым диапазонам</h3><p class="note">Ось X — ${label(selected.a)}. Группы — диапазоны ${label(selected.b)}.</p>
      <ul class="legend">${series.map((item) => `<li><i class="swatch" style="background:${item.color}"></i>${esc(item.name)}</li>`).join('')}</ul>
      ${lineChart(series, { unit, title: 'Совместный вклад по диапазонам', axes: bands.map((name, x) => ({ x, label: name })), connect: false })}`
      : '<p class="note">Для графика этой пары мало наблюдений в отдельных диапазонах или пара вне 12 крупнейших.</p>'}
    ${local ? `<div class="local-pair"><label class="field">Наблюдение из выборки<select id="pair-deal" aria-label="Наблюдение из выборки">${selected.local.map((row) => option(row.id, row.id, local.id)).join('')}</select></label><p class="note">Вклад в начале ${delta(local.before, unit)}, в конце ${delta(local.after, unit)}. Изменение ${delta(local.change, unit)}.</p></div>` : ''}
    <details class="details"><summary>Тепловая карта</summary><div class="table-wrap" tabindex="0"><table class="heatmap" aria-label="Тепловая карта попарных взаимодействий">
      <thead><tr><th scope="col">Фактор</th>${keys.map((key) => `<th scope="col">${label(key)}</th>`).join('')}</tr></thead>
      <tbody>${keys.map((a) => `<tr><th scope="row">${label(a)}</th>${keys.map((b) => cells(a, b)).join('')}</tr>`).join('')}</tbody></table></div></details>
    <p class="note">Совместный эффект уже входит во вклады на водопаде.</p></div>`;
}

function qualityPanel(work, unit) {
  const r = work.report;
  if (!r.validation?.length) return h2('Проверка модели', 'Для надёжной оценки пока недостаточно истории.');
  return `<div id="quality">${h2('Проверка модели разложения', `${esc(r.model.name)} обучена по ${day(r.model.trainedThrough)}. Обе даты сравнения проверяются без переобучения.`)}
    ${table([['Дата'], ['Наблюдений', 'num'], ['MAE', 'num'], ['RMSE', 'num'], ['R²', 'num'], ['Смещение на сделку', 'num'], ['Ошибка суммы', 'num'], ['MAE медианы', 'num']],
      r.validation.map((item) => `<tr><th scope="row">${day(item.date)}</th><td class="num">${item.rows}</td><td class="num">${fmt(item.mae, unit)}</td>
      <td class="num">${fmt(item.rmse, unit)}</td><td class="num">${n(item.r2)}</td><td class="num">${delta(item.bias, unit)}</td>
      <td class="num">${delta(item.aggregateError, unit)}</td><td class="num">${fmt(item.median.mae, unit)}</td></tr>`), 'Ошибки модели разложения')}
    <p class="note">Ошибка изменения суммы по датам ${delta(r.aggregateChangeError, unit)}. Необъяснённый остаток по общим наблюдениям ${delta(r.residual, unit)}.</p>
    <details class="details"><summary>Выбор модели до начала сравнения</summary><p class="note">В каждой строке обучение заканчивается до проверки. Выбор сделан по средней MAE.</p>
      ${r.quality.length ? table([['Дата'], ['Обучено по'], ['Медиана', 'num'], ['Ridge', 'num'], ['Случайный лес', 'num'], ['Extra Trees', 'num']],
        r.quality.map((item) => `<tr><th scope="row">${day(item.date)}</th><td>${day(item.trainedThrough)}</td><td class="num">${fmt(item.median, unit)}</td>
        <td class="num">${fmt(item.linear, unit)}</td><td class="num">${fmt(item.forest, unit)}</td><td class="num">${fmt(item.extra, unit)}</td></tr>`), 'Сравнение кандидатов по MAE')
        : '<p class="note">Мало дат для отдельного сравнения кандидатов. Используется базовый случайный лес.</p>'}</details>
    <details class="details"><summary>Устойчивость и ограничения</summary><p class="note">${r.stability.refits} повторных обучений по подвыборкам ID. Корреляция рейтингов ${r.stability.rankCorrelations.map(n).join(' · ')}.</p>
      <ul class="inline-notes">${[...r.limitations, ...r.warnings].map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details></div>`;
}

export function analysisTab(state) {
  const { workspace: work, tab } = state;
  const r = work.report;
  const unit = unitOf(work);
  if (tab === 'calculation') return valuationDetail(work);
  if (r.mode === 'ml' && ['importance', 'interactions', 'effects'].includes(tab) && r.diagnosticsReady === false) {
    return h2('Углублённая аналитика', 'Дополнительный расчёт запускается по запросу.')
      + `<button type="button" data-action="diagnostics" class="button primary" ${state.generating ? 'disabled' : ''}>Рассчитать детализацию</button>`;
  }
  const factorLabel = (name) => esc(titleOf(work, name));
  if (tab === 'timeline') {
    const points = r.timeline.map((item) => ({ x: Date.parse(item.date), label: day(item.date).slice(0, 5), value: item.value,
      support: item.count, selected: [r.before, r.after].includes(item.date) }));
    return h2('История показателя', 'Сумма метрики по всем наблюдениям на каждую дату. Заливкой отмечены даты сравнения.')
      + lineChart([{ name: titleOf(work, r.target), color: '#366795', points }], { unit, title: 'История выбранного показателя' });
  }
  if (tab === 'importance') {
    const stats = r.importance.filter((item) => item.value !== null);
    const unavailable = r.importance.filter((item) => item.value === null).map((item) => factorLabel(item.key));
    const shared = [...r.importance].sort((a, b) => b.meanAbsShap - a.meanAbsShap)
      .map((item) => ({ ...item, value: item.meanAbsShap, label: titleOf(work, item.key) }));
    return h2('Глобальная важность', 'Важность оценивается по проверочным данным в единицах метрики на сделку.')
      + `<div class="grid-two"><div><h3>Рост ошибки при перестановке</h3><p class="note">Перемешивание значений внутри проверочной даты.</p>
        ${bars(stats.map((item) => ({ ...item, label: titleOf(work, item.key) })), { unit, label: 'Глобальная важность по росту MAE', narrow: true })}</div>
        <div><h3>Средний модуль вклада SHAP</h3><p class="note">По общим сделкам на конечную дату сравнения.</p>
        ${bars(shared, { unit, label: 'Глобальная важность по среднему модулю SHAP', narrow: true })}</div></div>`
      + (stats.length ? table([['Признак'], ['Средний рост MAE', 'num'], ['Минимум по датам', 'num'], ['Максимум по датам', 'num'], ['Дат', 'num']],
        stats.map((item) => `<tr><th scope="row">${factorLabel(item.key)}</th><td class="num">${delta(item.value, unit)}</td><td class="num">${delta(item.low, unit)}</td>
          <td class="num">${delta(item.high, unit)}</td><td class="num">${item.folds.length}</td></tr>`), 'Глобальная важность по датам') : '')
      + (r.groupedImportance?.length ? `<details class="details"><summary>Коррелирующие группы признаков</summary>${table([['Группа'], ['Рост MAE', 'num']], r.groupedImportance.map((item) => `<tr><th scope="row">${item.keys.map(factorLabel).join(', ')}</th><td class="num">${delta(item.value, unit)}</td></tr>`), 'Перестановка групп')}</details>` : '')
      + (r.marketImportance ? `<details class="details"><summary>Совместная важность общих признаков даты</summary><p class="note">Рост MAE ${delta(r.marketImportance.value, unit)}. Использованы ${r.marketImportance.dates.length} независимых дат и отдельная модель ${esc(r.marketImportance.model)}, обученная до ${day(r.marketImportance.trainedThrough)}.</p></details>` : '')
      + (unavailable.length ? `<p class="note">${unavailable.join(', ')}. Эти признаки постоянны внутри проверочных дат, поэтому внутридневная перестановка для них неинформативна.</p>` : '');
  }
  if (tab === 'interactions') return interactionPanel(state, work, unit);
  if (tab === 'effects') {
    if (!r.effects.length) return h2('Нелинейные эффекты', 'Эффекты появятся после проверки модели.');
    const populated = r.effects.find((item) => item.key === state.effect) ?? r.effects.find((item) => item.points.length) ?? r.effects[0];
    const chart = populated.kind === 'numeric'
      ? lineChart([{ name: titleOf(work, populated.key), color: '#286e65', points: populated.points }], { title: 'Накопленный локальный эффект', unit })
      : bars(populated.points.map((item) => ({ label: item.x, value: item.value })), { unit, label: 'Средний вклад по категориям' });
    return `<div id="effects" class="panel-head"><div><h2>Как меняется эффект</h2><p class="note">Числовые признаки показаны через накопленный локальный эффект (ALE).</p></div>
      <label class="field">Признак<select id="effect-select">${r.effects.map((item) => option(item.key, titleOf(work, item.key), populated.key)).join('')}</select></label></div>
      <div class="effect-summary"><strong>${esc(populated.shapeLabel ?? 'Тип зависимости не подтверждён')}</strong><span>${populated.support ?? 0} наблюдений${populated.range ? ` · диапазон ${populated.range.map(n).join(' – ')}` : ''}${populated.stability != null && populated.shape !== 'unconfirmed' ? ` · форма в ${n(populated.stability * 100)}% повторных выборок` : ''}</span></div>
      ${chart}<p class="note">${populated.kind === 'numeric'
        ? 'Значения центрированы относительно выборки. Изгиб показывает, что эффект зависит от диапазона признака.'
        : 'Для категорий показан средний вклад SHAP по группе. Группы менее трёх наблюдений скрыты.'}</p>
      ${populated.points.length ? table([['Уровень / значение'], ['Эффект', 'num'], ['Наблюдений', 'num'], ['Разброс при пересэмплировании', 'num']],
        populated.points.map((item) => `<tr><td>${typeof item.x === 'number' ? n(item.x) : esc(item.x)}</td><td class="num">${delta(item.value, unit)}</td><td class="num">${item.support}</td><td class="num">${item.low == null ? '—' : `${delta(item.low, unit)} – ${delta(item.high, unit)}`}</td></tr>`),
        'Данные графика эффекта') : ''}`;
  }
  if (tab === 'quality') return qualityPanel(work, unit);
  const questions = r.mode === 'valuation' ? ['Почему изменился NPV?', 'Как повлияло изменение кривой?', 'Чем отличаются методы?']
    : ['Какие факторы главные?', 'Какие факторы взаимодействуют?', 'Как читать нелинейный эффект?', 'Насколько надёжен результат?'];
  const consent = state.health?.ai?.provider === 'deepseek' && work.source !== 'integrated'
    ? '<label class="check"><input type="checkbox" name="allowExternal"> Разрешить DeepSeek обработать обезличенную структуру этого ответа</label>' : '';
  return h2('Вопросы к расчёту', 'Ответ строится по проверенным результатам выбранных дат.')
    + `<form class="ask-form" id="explain-form"><label class="field">Вопрос по расчёту<input type="search" name="question" maxlength="300" placeholder="Почему изменился показатель?"></label>
      <button class="button primary" type="submit">Объяснить</button>${consent}</form>
      <div class="question-list">${questions.map((question) => `<button type="button" class="button small" data-action="question" data-key="${esc(question)}">${esc(question)}</button>`).join('')}</div>
      <div id="answer" aria-live="polite">${explanation(state.answer)}</div>`;
}

export function explanation(answer) {
  if (!answer) return '';
  if (answer.error) return `<p class="status error">${esc(answer.error)}</p>`;
  const failures = { forbidden: 'Облачная обработка для этих данных отключена.', unconfigured: 'AI не настроен.',
    authorization: 'Провайдер отклонил авторизацию.', payment: 'Провайдер отклонил запрос из-за состояния счёта.',
    limited: 'Провайдер ограничил частоту запросов.', timeout: 'Провайдер не ответил вовремя.',
    model_unavailable: 'Выбранная модель недоступна.', invalid_response: 'Не удалось проверить ответ модели.',
    response_limit: 'Ответ модели превысил лимит.', unavailable: 'AI временно недоступен.', busy: 'AI обрабатывает другой запрос.' };
  const mode = answer.mode === 'llm' ? (answer.provider === 'deepseek' ? 'DeepSeek' : 'Локальная модель') + ' сформировал порядок проверенных фактов.'
    : (failures[answer.status] ? failures[answer.status] + ' ' : '') + 'Показаны проверенные факты расчёта.';
  if (answer.empty) return `<p class="note">${esc(answer.empty)}</p>`;
  const sections = answer.sections ?? [{ title: 'Результат', facts: answer.facts }];
  return `<p class="note checks-note">${esc(mode)}</p>${sections.map((section) => `<div class="explanation-section"><h3>${esc(section.title)}</h3>
    <ul class="facts">${section.facts.map((fact) => `<li><p>${esc(fact.text)}</p><button type="button" class="ghost source" data-action="fact-source" data-key="${esc(fact.source)}" data-detail="${esc(fact.detail ?? '')}">Открыть источник</button></li>`).join('')}</ul></div>`).join('')}`;
}

export function scenarioPage(state) {
  const work = state.workspace;
  if (!work?.periods?.length) return heading('Сценарии ставок', 'Сравнение PV одного и того же графика платежей по семи кривым.')
    + empty('Нужен портфель с рассчитанными потоками', 'Сценарии появятся после прогона калькулятора и API кривых.', link('#portfolio', 'Открыть генератор'));
  const dates = work.periods.map((item) => item.date);
  const item = work.periods.find((item) => item.date === state.scenarioDay) ?? work.periods.at(-1);
  const losses = item.scenarios.filter((item) => item.code !== 'base');
  const worst = losses.reduce((current, value) => current.delta < value.delta ? current : value);
  const active = losses.find((entry) => entry.code === state.scenarioCode) ?? worst;
  const base = item.scenarios.find((entry) => entry.code === 'base');
  const rows = item.scenarios.map((entry) => `<tr class="${entry === active ? 'is-selected' : ''}"><th scope="row">${esc(entry.name)}</th>
    <td class="num">${exact(entry.pv, ' ₽')}</td><td class="num ${tone(entry.delta)}">${signed(entry.delta, ' ₽')}</td></tr>`);
  const plotted = (code) => item.curves[code].map((p) => ({ x: Math.log1p(p.years), value: p.rate, label: p.label }));
  const buckets = (item.bucketDeltas?.[active.code] ?? []).filter((entry) => Math.abs(entry.value) >= 0.01);
  const exports = link(exportUrl(work, item.date + '/discounted_deal_summary.csv'), 'PV по сделкам')
    + link(exportUrl(work, item.date + '/standard-result.json'), 'Снимок кривых');
  return heading('Сценарии ставок', 'Готовые коэффициенты дисконтирования применяются к договорным потокам.',
    `<button class="button small" type="button" data-action="compare-scenario" data-key="${esc(active.code)}" data-date="${esc(item.date)}">Объяснить изменение сценария</button>`) + `<div class="toolbar"><label class="field">Отчётная дата<select id="scenario-date">${dateOpts(dates, item.date)}</select></label>
      <strong class="status-count">Весь портфель · ${item.deals} сделок</strong><div class="data-actions">${exports}</div></div>
    <section class="metrics" aria-label="Основные показатели сценариев">
      ${card('PV базы', short(base.pv, ' ₽'), 'Стоимость по базовой кривой', '', exact(base.pv, ' ₽'))}
      ${card('Минимальная ΔPV', short(worst.delta, ' ₽'), esc(worst.name), 'delta-down', exact(worst.delta, ' ₽'))}
      ${card('PV выбранного стресса', short(active.pv, ' ₽'), esc(active.name), '', exact(active.pv, ' ₽'))}
      ${card('ΔPV выбранного стресса', short(active.delta, ' ₽'), 'Отклонение от базы', '', signed(active.delta, ' ₽'))}
    </section>
    <div class="section-pair">
      <section class="panel" id="scenario-chart"><div class="panel-head"><div><h2>Как стресс меняет стоимость</h2>
        <p class="note">В базе ΔPV равна нулю. Нажмите на сценарий для сравнения кривых.</p></div></div>
        ${bars(losses.map((entry) => ({ key: entry.code, label: entry.name, value: entry.delta })), { unit: ' ₽', action: 'scenario', active: active.code, label: 'Отклонение PV по стрессам', narrow: true })}
      </section>
      <section class="panel"><label class="field">Стресс для сравнения<select id="scenario-code">${losses.map((entry) => option(entry.code, entry.name, active.code)).join('')}</select></label>
        <ul class="legend"><li><i class="swatch"></i>Базовая</li><li><i class="swatch selected"></i>${esc(active.name)}</li></ul>
        ${lineChart([{ name: 'Базовая', color: '#2d5880', points: plotted('base') }, { name: active.name, color: '#b95648', points: plotted(active.code) }],
          { title: 'Базовая и выбранная стрессовая кривые', unit: '%' })}
        <p class="note">Ось сроков использует логарифмический масштаб. Доходности в % годовых.</p></section>
    </div>
    <div class="grid-two">
      <section class="panel">${h2('PV по сценариям', 'Договорные платежи одинаковы в семи сценариях.')}
        ${table([['Сценарий'], ['PV, ₽','num'], ['Δ к базе, ₽','num']], rows, 'PV всех сделок по сценариям')}</section>
      <section class="panel">${h2('Из каких сроков складывается ΔPV', esc(active.name) + ' · вклад по бакетам платежей')}
        ${bars(buckets.map((entry) => ({ ...entry, label: entry.label })), { unit: ' ₽', narrow: true, left: 63, label: 'Вклад бакетов платежей' })}
        <p class="note">Сумма по срокам даёт ${signed(active.delta, ' ₽')}. Процентные потоки за год ${exact(item.interest12, ' ₽')}.</p></section>
    </div>`;
}

function input(name, label, value, limits) {
  return `<label class="field">${label}<input ${limits} name="${name}" value="${esc(value)}" required></label>`;
}

export function portfolioPage(state) {
  const work = state.workspace;
  const last = work?.periods?.at(-1);
  const settings = { count: 120, monthly: 16, periods: 7, valuationDate: '2026-10-30', seed: '4317',
    amountMin: 200000, amountMax: 1100000, termMin: 12, termMax: 84, rateMin: 10, rateMax: 19,
    liabilityShare: 0, annuity: 60, linear: 30, bullet: 10, fixed: 70, floating: 30, benchmark: 14, termProfile: 'uniform',
    ...work?.settings, ...state.draft };
  const ranges = [
    ['amountMin', 'Сумма от, ₽', 'number" min="1" step="0.01'], ['amountMax', 'Сумма до, ₽', 'number" min="1" step="0.01'],
    ['termMin', 'Срок от, мес.', 'number" min="1" max="360'], ['termMax', 'Срок до, мес.', 'number" min="1" max="360'],
    ['rateMin', 'Ставка от, %', 'number" min="0" max="100" step="0.01'], ['rateMax', 'Ставка до, %', 'number" min="0" max="100" step="0.01'],
  ];
  const title = heading('Портфель', 'Сгенерируйте историю сделок и пройдите весь расчёт через калькулятор и API кривых.');
  const generator = `<section class="panel" id="generator">${h2('Генератор синтетики', 'Остаток долга пересчитывается по графику калькулятора. Новые сделки добавляются на очередную отчётную дату.')}
    <form id="generate-form"><div class="form-grid">
      ${input('count', 'Сделок на старте', settings.count, 'type="number" min="20" max="1500"')}
      ${input('monthly', 'Новых сделок в месяц', settings.monthly, 'type="number" min="0" max="250"')}
      ${input('periods', 'Число отчётных дат', settings.periods, 'type="number" min="4" max="12"')}
      ${input('valuationDate', 'Конечная отчётная дата', settings.valuationDate, 'type="date"')}
    </div>
    <details class="details"><summary>Параметры сделок и распределения</summary>
      <div class="form-grid">${input('seed', 'Код генерации', settings.seed, 'type="text" maxlength="64"')}
        ${input('liabilityShare', 'Доля обязательств, %', settings.liabilityShare, 'type="number" min="0" max="100" step="0.01"')}
        ${ranges.map(([name, label, rule]) => input(name, label, settings[name], `type="${rule}"`)).join('')}
        <label class="field">Распределение сроков<select name="termProfile">
          ${Object.entries({ uniform: 'Равномерно', short: 'Больше коротких', long: 'Больше длинных' }).map(([key, value]) => option(key, value, settings.termProfile)).join('')}</select></label>
        ${[['annuity', 'Аннуитетных, %'], ['linear', 'Дифференцированных, %'], ['bullet', 'С телом в конце, %'],
          ['fixed', 'Фиксированная ставка, %'], ['floating', 'Плавающая ставка, %'], ['benchmark', 'Тестовый плавающий индекс, %']]
          .map(([key, label]) => input(key, label, settings[key], 'type="number" min="0" max="100" step="0.01"')).join('')}</div>
      <p class="note">Доли каждого вида распределения должны давать 100%. Предыдущие даты берутся по будним дням на конец месяцев.</p>
    </details>
    <label class="field curve-source">Источник кривых<select name="curveSource">${Object.entries({api: 'Рыночные кривые через API', saved: 'Сохранённые рыночные кривые', fixture: 'Учебные кривые (офлайн)'}).map(([key, title]) => option(key, title, state.draft?.curveSource ?? 'api')).join('')}</select></label>
    <div class="form-actions"><button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Рассчитать портфель</button>
      <p class="note">Подготовка кривых · денежные потоки · сценарии · факторный анализ</p></div>
    </form></section>`;
  const archive = `<p class="note section-link">Есть история от калькулятора и сервиса кривых? <a href="#data">Загрузите снимки ZIP в «Данных»</a>.</p>`;
  if (!last) return title + generator + archive;
  const date = work.periods.find((p) => p.date === state.portfolioDay)?.date ?? last.date;
  const head = `<div class="panel-head"><div><h2>Состав портфеля</h2><p class="note">${work.uniqueDeals} уникальных сделок за период. Нажмите на ID для просмотра платежей.</p></div>
    ${link(exportUrl(work, date + '/calculator_input.csv'), 'CSV для калькулятора')}</div>`;
  return title + generator + archive + `<section class="panel">${head}<form class="toolbar" id="deal-search">
    <label class="field">Дата<select id="portfolio-date">${dateOpts(work.periods.map((p) => p.date), date)}</select></label>
    <label class="field">ID сделки<input type="search" name="query" value="${esc(state.dealQuery ?? '')}" placeholder="Например, 120"></label><button class="button" type="submit">Найти</button>
    </form><div id="deal-table" aria-live="polite"><p class="note">Загрузка списка сделок…</p></div></section>`;
}

export function dealTable(data) {
  if (!data.rows.length) return '<p class="note">Совпадений нет.</p>';
  const cols = [['ID'], ['Остаток', 'num'], ['Ставка, %', 'num'], ['Срок, лет', 'num'], ['График'], ['Сторона'], ['PV базы', 'num']];
  const lines = data.rows.map((row) => `<tr><th scope="row"><button class="ghost" data-action="flow" data-key="${esc(row.deal_id)}">${esc(row.deal_id)}</button></th>
    <td class="num">${exact(+row.principal, ' ₽')}</td><td class="num">${n(+row.contract_rate)}</td><td class="num">${n(+row.term_years)}</td>
    <td>${esc(row.payment_type)}</td><td>${row.side === 'LIABILITY' ? 'Обязательство' : 'Актив'}</td><td class="num">${exact(+row.npv, ' ₽')}</td></tr>`);
  const count = Math.ceil(data.size / data.pageSize);
  return table(cols, lines, 'Найденные сделки') + `<div class="pagination">
    <button class="button small" data-action="deal-page" data-key="${data.page - 1}" ${data.page ? '' : 'disabled'}>Назад</button>
    <span>${data.page + 1} из ${count} · ${data.size} сделок</span>
    <button class="button small" data-action="deal-page" data-key="${data.page + 1}" ${data.page + 1 < count ? '' : 'disabled'}>Дальше</button></div>`;
}

export function flowDialog(data, workspace) {
  const rows = data.rows.slice(0, 32).map((row) => `<tr><td>${day(row.payment_date)}</td><td>${row.cash_flow_type === 'INTEREST' ? 'Проценты' : 'Основной долг'}</td>
    <td class="num">${exact(+row.amount, ' ₽')}</td><td class="num">${n(+row.rate_used * 100)}%</td></tr>`);
  return `<div class="panel-head"><div><h2 id="inspector-title">Платежи по сделке № ${esc(data.id)}</h2><p class="note">${day(data.date)} · ${data.rows.length} строк калькулятора</p></div>
    <form method="dialog"><button class="button small">Закрыть</button></form></div>
    ${table([['Дата'], ['Вид платежа'], ['Сумма','num'], ['Ставка','num']], rows, 'Платежи по сделке')}
    ${data.rows.length > 32 ? `<p class="note">Первые 32 записи. Полный график доступен в выгрузке. ${link(exportUrl(workspace, data.date + '/cashflows.csv'), 'Денежные потоки')}</p>` : ''}`;
}


export function dataPage(state) {
  const work = state.workspace;
  const integrated = Boolean(work?.periods);
  const importForms = `<div class="grid-two"><section class="panel">${h2('Загрузить таблицу CSV', 'Для ML-анализа. Одна строка на наблюдение и дату.')}
    <form id="import-form" class="toolbar"><label class="field">Файл истории<input type="file" name="csvfile" accept=".csv,.tsv,text/csv" required></label>
    <button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Загрузить CSV</button></form>
    <p class="note">UTF-8, до 6 МБ и 20 000 строк. <a href="/api/example.csv">Скачать учебный CSV</a></p></section>
    <section class="panel">${h2('Загрузить снимки ZIP', 'Для расчётного режима. Нужны потоки, PV и кривые на одинаковые даты.')}
    <form id="history-form" class="toolbar"><label class="field">Архив снимков<input type="file" name="history" accept=".zip,application/zip" required></label>
    <label class="check"><input type="checkbox" name="bank"> Банковская выгрузка</label>
    <button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Загрузить ZIP</button></form>
    <p class="note">От двух дат, архив до 16 МБ.</p></section></div>`;
  if (!work?.profile) return heading('Данные', 'Выберите историю для анализа или запустите генератор.') + importForms;
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
  const field = (name, title, keys) => `<label class="field">${title}
    <select name="${name}" data-column="${name}" aria-label="${title}">
    ${option('', 'Выберите колонку', prefs[name])}${keys.map((key) => option(key, titleOf(work, key), prefs[name])).join('')}</select></label>`;
  const kinds = { numeric: 'Числовой', category: 'Категория', date: 'Дата' };
  const columnRows = columns.map((col) => `<tr><th scope="row">${esc(titleOf(work, col.name))}</th><td>${kinds[col.kind]}</td>
    <td class="num">${n(col.missing)}</td><td class="num">${n(col.distinct)}</td><td class="num">${n(col.outliers)}</td>
    <td class="num">${col.kind === 'numeric' ? n(col.min) + ' … ' + n(col.max) : '—'}</td></tr>`);
  const evidence = integrated ? `<section class="panel sources">${h2('Источники расчёта', 'Для каждой даты сохранены кривые, вход калькулятора и результаты.')}
    ${table([['Дата'], ['Сделок', 'num'], ['Строк CF', 'num'], ['Источник кривых'], ['Выгрузки']],
      work.periods.map((p) => `<tr><th scope="row">${day(p.date)}</th><td class="num">${p.deals}</td><td class="num">${n(p.flowRows)}</td>
        <td title="SHA-256 ${esc(p.sha256)}">${({ api: 'MOEX через API', saved: 'Сохранённый ответ MOEX', imported: 'Загруженный снимок MOEX', fixture: 'Учебные кривые' })[p.curveSource] ?? 'Сохранённый снимок'} · ${esc(p.runId.slice(0, 8))}</td>
        <td><a href="${exportUrl(work, p.date + '/calculator_input.csv')}">Вход</a> · <a href="${exportUrl(work, p.date + '/standard-result.json')}">Кривые</a> ·
        <a href="${exportUrl(work, p.date + '/cashflows.csv')}">Потоки</a> · <a href="${exportUrl(work, p.date + '/discounted_deal_summary.csv')}">PV</a></td></tr>`), 'Источники расчёта')}
    <div class="data-actions">${link(exportUrl(work, 'history.zip'), 'Скачать историю ZIP')}</div></section>` : '';
  const preview = work.profile.preview?.length ? `<details class="details"><summary>Предпросмотр строк</summary>${table(columns.map((col) => [esc(col.name)]),
    work.profile.preview.map((row) => `<tr>${columns.map((col) => `<td>${esc(row[col.name])}</td>`).join('')}</tr>`), 'Предпросмотр таблицы')}</details>` : '';
  const ready = Boolean(prefs.dateColumn && prefs.idColumn && prefs.target);
  return heading('Данные', 'Настройте входную таблицу, проверьте качество и источники.', link(exportUrl(work, 'dataset.csv'), 'Скачать CSV'))
    + importForms + `<section class="panel">${h2('Настройка ML-анализа', `${n(work.profile.rows)} строк · ${dates.length} дат${work.profile.distinctIds ? ` · ${n(work.profile.distinctIds)} уникальных ID` : ''} · ${candidates.length} потенциальных факторов`)}
      <form id="mapping-form"><div class="form-grid">${integrated ? '' : field('dateColumn', 'Дата', dateFields) + field('idColumn', 'ID', columns.map((col) => col.name))}
        ${field('target', 'Целевая метрика', targets)}${integrated ? '' : `<label class="field">Единица измерения<input name="unit" maxlength="20" value="${esc(prefs.unit ?? '')}" placeholder="Например, ₽ или шт."></label>
        <label class="field">Агрегация<select name="aggregation">${option('sum', 'Сумма по наблюдениям', prefs.aggregation ?? 'sum')}${option('mean', 'Среднее или коэффициент', prefs.aggregation)}</select></label>`}
        <label class="field">Начальная дата<select name="before">${option('', 'Предпоследняя', prefs.before)}${dateOpts(dates, prefs.before ?? work.report?.before)}</select></label>
        <label class="field">Конечная дата<select name="after">${option('', 'Последняя', prefs.after)}${dateOpts(dates, prefs.after ?? work.report?.after)}</select></label></div>
        <p class="note">Поддерживаются суммируемые метрики. Исключите признаки, рассчитанные после отчётной даты или на основе цели.</p>
        <details class="details" ${state.preview ? 'open' : ''}><summary>Проверить или изменить факторы</summary><p class="note">До 16 факторов попадают в модель. Отбор выполняется по данным до начала сравнения.</p>
          <div class="criteria feature-list" role="group" aria-label="Признаки модели">${candidates.map((col) => {
            const audit = audits.get(col.name);
            return `<label class="check"><input type="checkbox" name="feature" value="${esc(col.name)}" ${picked.has(col.name) ? 'checked' : ''}>
              <span>${esc(titleOf(work, col.name))}${audit?.reason ? `<small>${esc(audit.reason)}</small>` : ''}</span></label>`;
          }).join('')}</div></details>
        <div class="form-actions"><button class="button" type="button" data-action="check-mapping" ${!ready || state.generating ? 'disabled' : ''}>Проверить колонки</button>
          <button class="button primary" type="submit" ${!ready || state.generating ? 'disabled' : ''}>Рассчитать ML-вклады</button></div>
      </form>${preview}</section>${evidence}
      <section class="panel"><details class="details"><summary>Профиль таблицы</summary>
      <p class="note">Выбросы отмечены по межквартильному размаху. Решения об отборе принимаются на обучающем периоде.</p>
      ${table([['Колонка'], ['Тип'], ['Пропуски', 'num'], ['Различных', 'num'], ['Выбросы', 'num'], ['Диапазон', 'num']], columnRows, 'Профиль колонок')}
      </details></section>`;
}
