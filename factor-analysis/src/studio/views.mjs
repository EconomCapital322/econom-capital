import { bars, lineChart, waterfall, day, esc, exact, n, short, signed, tone } from './charts.mjs';

export const pages = { analysis: 'Факторный анализ', scenarios: 'Сценарии ставок', portfolio: 'Портфель', data: 'Данные' };
export const tabs = { timeline: 'История метрики', importance: 'Важность факторов', interactions: 'Взаимодействия', effects: 'Нелинейные эффекты', quality: 'Проверка модели', explanation: 'Объяснение' };
const codes = { parallel_up: 'Параллельный вверх', parallel_down: 'Параллельный вниз', steepener: 'Увеличение наклона',
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
  if (key === 'stress_delta' && work.scenario) return 'ΔPV · ' + codes[work.scenario];
  return Object.hasOwn(work.options?.labels ?? {}, key) ? work.options.labels[key] : key;
};
const unitOf = (work) => work.source === 'integrated' ? ' ₽' : '';
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
  if (r.removed) rows.push({ key: 'removed', label: 'Выбывшие сделки', value: r.exclusions, description: `${r.removed} сделок есть только на начальную дату.` });
  for (const factor of r.factors.slice(0, 4)) rows.push({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
    chartLabel: work.source === 'integrated' ? chartLabels[factor.key] : null,
  });
  const rest = r.factors.slice(4);
  if (rest.length) rows.push({
    key: 'other', label: 'Остальные факторы', value: rest.reduce((total, item) => total + item.value, 0),
    description: 'Сумма вкладов остальных признаков по сделкам, присутствующим на обе даты.',
  });
  rows.push({ key: 'residual', label: 'Остаток', value: r.residual,
    description: 'Часть наблюдаемого изменения по общим сделкам, которую модель не объяснила.' });
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
  if (modelFactor) {
    const show = (facts) => facts.kind === 'numeric'
      ? n(facts.mean)
      : Object.entries(facts.levels).slice(0, 3).map(([level, count]) => `${esc(level)} · ${count}`).join('<br>');
    detail = `<p class="note">${esc((work.source === 'integrated' ? help[modelFactor.key] : null) ?? 'Вклад рассчитан по значениям признака в загруженной истории.')}</p>
      <dl><dt>${day(r.before)}</dt><dd>${show(modelFactor.before)}</dd><dt>${day(r.after)}</dt><dd>${show(modelFactor.after)}</dd></dl>
      <p class="note">Диапазон при повторной выборке общих сделок</p>
      <p class="note numeral">${signed(modelFactor.low, unit)} … ${signed(modelFactor.high, unit)}</p>`;
  } else if (key === 'other') {
    detail += `<dl>${r.factors.slice(4).map((factor) => `<dt>${esc(titleOf(work, factor.key))}</dt><dd>${signed(factor.value, unit)}</dd>`).join('')}</dl>`;
  }
  const opts = [...extras.slice(0, 1), ...bars, ...r.factors.slice(4).map((factor) => ({
    ...factor, key: 'factor:' + factor.key, label: titleOf(work, factor.key),
  })), extras[1]];
  return `<label class="field factor-menu"><span class="sr-only">Фактор на графике</span><select id="factor-select">${opts.map((entry) => option(entry.key, entry.label, item.key)).join('')}</select></label>
    <div class="factor-content"><h3>${esc(item.label)}</h3><p class="figure-value ${extras.includes(item) ? '' : tone(item.value)}">${extras.includes(item) ? exact(item.value, unit) : signed(item.value, unit)}</p>${detail}</div>`;
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
  return heading('Факторный анализ', 'Проследите изменение стоимости портфеля от исходной оценки до результата.',
    link(exportUrl(work, 'workspace.json'), 'Скачать расчёт')) + `
    <form class="toolbar" id="compare-form">
      <label class="field">Показатель<select id="metric" name="target">${work.options.targets.map((key) => option(key, titleOf(work, key), r.target)).join('')}</select></label>
      <label class="field">Начальная дата<select id="from" name="before">${dateOpts(r.profile.dates, r.before)}</select></label>
      <label class="field">Конечная дата<select id="to" name="after">${dateOpts(r.profile.dates, r.after)}</select></label>
      <button class="button primary" type="submit">Разложить изменение</button>
    </form>
    <section class="metrics" aria-label="Изменение выбранного показателя">
      ${card('Начальная оценка', short(r.start, unit), day(r.before), '', exact(r.start, unit))}
      ${card('Конечная оценка', short(r.end, unit), day(r.after), '', exact(r.end, unit))}
      ${card('Изменение', (r.change > 0 ? '+' : '') + short(r.change, unit), 'Конец минус начало', r.change < 0 ? 'delta-down' : 'delta-up', signed(r.change, unit))}
      ${card('Необъяснённый остаток', short(r.residual, unit), 'Ошибка разложения наблюдаемой разницы', '', signed(r.residual, unit))}
    </section>
    ${warnings}
    <section class="panel waterfall-panel" id="waterfall">
      <div class="panel-head"><div><h2>Что изменило показатель</h2>
        <p class="note">${r.matched} общих сделок <span aria-hidden="true">·</span> ${r.added} новых <span aria-hidden="true">·</span> ${r.removed} выбывших</p></div>
        <ul class="legend"><li><i class="swatch up"></i>Рост</li><li><i class="swatch down"></i>Снижение</li><li><i class="swatch residual"></i>Остаток</li></ul>
      </div>
      <div class="analysis-main"><div id="bridge-chart">${waterfall({ start: r.start, end: r.end, bars: bridge(work), active, unit })}</div>
        <div class="divider" id="factor-details" aria-live="polite">${factorDetails(work, active)}</div></div>
    </section>
    <section class="panel flush" id="analysis-tabs">
      <div class="tabs" role="group" aria-label="Детали факторного анализа">
        ${Object.entries(tabs).map(([key, label]) => `<button data-action="tab" data-key="${key}" aria-pressed="${tab === key}">${label}</button>`).join('')}
      </div>
      <div class="tab-body" id="tab-body">${analysisTab(state)}</div>
    </section>`;
}

export function analysisTab(state) {
  const { workspace: work, tab } = state;
  const r = work.report;
  const unit = unitOf(work);
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
        stats.map((item) => `<tr><th scope="row">${factorLabel(item.key)}</th><td class="num">${signed(item.value, unit)}</td><td class="num">${signed(item.low, unit)}</td>
          <td class="num">${signed(item.high, unit)}</td><td class="num">${item.folds.length}</td></tr>`), 'Глобальная важность по датам') : '')
      + (unavailable.length ? `<p class="note">${unavailable.join(', ')}. Эти признаки постоянны внутри проверочных дат, поэтому внутридневная перестановка для них неинформативна.</p>` : '');
  }
  if (tab === 'interactions') {
    if (!r.interactions.length) return h2('Взаимодействия', 'Для оценки пары нужны как минимум два изменчивых признака и общие сделки на обе даты.');
    const names = Object.fromEntries(r.factors.map((item) => [item.key, titleOf(work, item.key)]));
    const keys = r.factors.slice(0, 9).map((item) => item.key);
    const max = r.interactions[0].strength || 1;
    const cells = (a, b) => {
      const pair = r.interactions.find((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a));
      return pair ? `<td title="${esc(names[a])} × ${esc(names[b])} · ${exact(pair.strength, unit)}"
        style="background:rgba(74,145,131,${(0.07 + 0.51 * Math.sqrt(pair.strength / max)).toFixed(3)})">${short(pair.strength)}</td>`
        : '<td aria-label="Один признак">·</td>';
    };
    return h2('Взаимодействия факторов', 'Средний абсолютный совместный вклад пары на сделку на конечную дату. Темнее означает сильнее.')
      + `<div class="table-wrap" id="interactions" tabindex="0"><table class="heatmap" aria-label="Тепловая карта попарных взаимодействий">
      <thead><tr><th scope="col">Фактор</th>${keys.map((key) => `<th scope="col">${factorLabel(key)}</th>`).join('')}</tr></thead>
      <tbody>${keys.map((a) => `<tr><th scope="row">${factorLabel(a)}</th>${keys.map((b) => cells(a, b)).join('')}</tr>`).join('')}</tbody></table></div>
      ${table([['Пара факторов'], ['Средний модуль в конце', 'num'], ['Изменение вклада на сделку', 'num']],
        r.interactions.slice(0, 5).map((item) => `<tr><th scope="row">${factorLabel(item.a)} × ${factorLabel(item.b)}</th>
          <td class="num">${exact(item.strength, unit)}</td><td class="num ${tone(item.change)}">${signed(item.change, unit)}</td></tr>`),
        'Самые сильные взаимодействия')}
      <p class="note">Совместные эффекты уже входят во вклады Шепли.</p>`;
  }
  if (tab === 'effects') {
    if (!r.effects.length) return h2('Нелинейные эффекты', 'Эффекты появятся после проверки модели.');
    const populated = r.effects.find((item) => item.key === state.effect) ?? r.effects.find((item) => item.points.length) ?? r.effects[0];
    const chart = populated.kind === 'numeric'
      ? lineChart([{ name: titleOf(work, populated.key), color: '#286e65', points: populated.points }], { title: 'Накопленный локальный эффект', unit })
      : bars(populated.points.map((item) => ({ label: item.x, value: item.value })), { unit, label: 'Средний вклад по категориям' });
    return `<div class="panel-head"><div><h2>Как меняется эффект</h2><p class="note">Числовые признаки показаны через накопленный локальный эффект (ALE).</p></div>
      <label class="field">Признак<select id="effect-select">${r.effects.map((item) => option(item.key, titleOf(work, item.key), populated.key)).join('')}</select></label></div>
      ${chart}<p class="note">${populated.kind === 'numeric'
        ? 'Значения центрированы относительно выборки. Изгиб показывает, что эффект зависит от диапазона признака.'
        : 'Для категорий показан средний вклад SHAP по группе. Группы менее трёх наблюдений скрыты.'}</p>
      ${populated.points.length ? table([['Уровень / значение'], ['Эффект', 'num'], ['Наблюдений', 'num']],
        populated.points.map((item) => `<tr><td>${typeof item.x === 'number' ? n(item.x) : esc(item.x)}</td><td class="num">${signed(item.value, unit)}</td><td class="num">${item.support}</td></tr>`),
        'Данные графика эффекта') : ''}`;
  }
  if (tab === 'quality') {
    if (!r.quality.length) return h2('Проверка модели', 'Проверочные даты и ошибки появятся, когда истории будет достаточно.');
    const ave = (name) => short(r.quality.reduce((total, row) => total + row[name], 0) / r.quality.length, unit);
    return h2('Проверка на более поздних датах', 'В каждом прогоне обучение заканчивается до даты проверки. MAE показывает среднюю абсолютную ошибку на сделку.')
      + `<div class="score-strip" id="quality">${[['Случайный лес', 'forest'], ['Линейная модель', 'linear'], ['Медиана обучающей выборки', 'median']]
        .map(([name, key]) => `<div class="score">${name}<strong>${ave(key)}</strong></div>`).join('')}</div>`
      + table([['Проверочная дата'], ['Обучено по'], ['Сделок', 'num'], ['Лес', 'num'], ['Линейная', 'num'], ['Медиана', 'num']],
        r.quality.map((item) => `<tr><th scope="row">${day(item.date)}</th><td>${day(item.trainedThrough)}</td><td class="num">${item.testRows}</td>
          <td class="num">${exact(item.forest, unit)}</td><td class="num">${exact(item.linear, unit)}</td><td class="num">${exact(item.median, unit)}</td></tr>`), 'Проверка MAE')
      + `<p class="note checks-note">Модель разложения обучена на ${n(r.trainingRows)} строках до ${day(r.before)}. Временная проверка использует расширяющееся окно. Проверяется перенос на новые даты на том же портфеле.</p>`;
  }
  return h2('Вопросы к расчёту', 'Объяснение составляется из чисел, полученных на выбранном периоде.')
    + `<form class="ask-form" id="explain-form"><label class="field"><span class="sr-only">Вопрос по расчёту</span><input type="search" name="question" maxlength="300" placeholder="Что сильнее всего повлияло на NPV?"></label>
      <button class="button primary" type="submit">Объяснить</button></form><div id="answer" aria-live="polite">${explanation(state.answer)}</div>`;
}

export function explanation(answer) {
  if (!answer) return '';
  if (answer.error) return `<p class="status error">${esc(answer.error)}</p>`;
  return `<p class="note checks-note">${answer.mode === 'llm' ? 'Ответ сформирован локальной LLM по результатам расчёта.' : 'Показаны проверяемые факты расчёта.'}</p>
    ${answer.empty ? `<p class="note">${esc(answer.empty)}</p>` : ''}
    <ul class="facts">${answer.facts.map((fact) => `<li><p>${esc(fact.text)}</p>
      <button class="ghost source" data-action="fact-source" data-key="${esc(fact.source)}">Открыть источник</button></li>`).join('')}</ul>`;
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
  return heading('Сценарии ставок', 'Калькулятор применяет готовые дисконт-факторы команды 2 к денежным потокам.',
    '') + `<div class="toolbar"><label class="field">Отчётная дата<select id="scenario-date">${dateOpts(dates, item.date)}</select></label>
      <strong class="status-count">Весь портфель · ${item.deals} сделок</strong><div class="data-actions">${exports}</div></div>
    <section class="metrics" aria-label="Основные показатели сценариев">
      ${card('PV базы', short(base.pv, ' ₽'), 'Стоимость по базовой кривой', '', exact(base.pv, ' ₽'))}
      ${card('Минимальная ΔPV', short(worst.delta, ' ₽'), esc(worst.name), 'delta-down', exact(worst.delta, ' ₽'))}
      ${card('Платежи за 12 месяцев', short(item.cash12, ' ₽'), 'Тело и проценты без дисконтирования', '', exact(item.cash12, ' ₽'))}
      ${card('Срок по взвешенной PV', n(item.duration) + ' г.', 'Средний срок выплат по базовой PV')}
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
    annuity: 60, linear: 30, bullet: 10, fixed: 70, floating: 30, benchmark: 14, termProfile: 'uniform',
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
      ${input('seed', 'Код генерации', settings.seed, 'type="text" maxlength="64"')}
      <label class="field">Стресс для анализа ΔPV<select name="scenario">${Object.entries(codes).map(([key, text]) => option(key, text, state.draft?.scenario ?? work?.scenario ?? 'parallel_up')).join('')}</select></label>
    </div>
    <details class="details"><summary>Параметры сделок и распределения</summary>
      <div class="form-grid">${ranges.map(([name, label, rule]) => input(name, label, settings[name], `type="${rule}"`)).join('')}
        <label class="field">Распределение сроков<select name="termProfile">
          ${Object.entries({ uniform: 'Равномерно', short: 'Больше коротких', long: 'Больше длинных' }).map(([key, value]) => option(key, value, settings.termProfile)).join('')}</select></label>
        ${[['annuity', 'Аннуитетных, %'], ['linear', 'Дифференцированных, %'], ['bullet', 'С телом в конце, %'],
          ['fixed', 'Фиксированная ставка, %'], ['floating', 'Плавающая ставка, %'], ['benchmark', 'Тестовый плавающий индекс, %']]
          .map(([key, label]) => input(key, label, settings[key], 'type="number" min="0" max="100" step="0.01"')).join('')}</div>
      <p class="note">Доли каждого вида распределения должны давать 100%. Предыдущие даты берутся по будним дням на конец месяцев.</p>
    </details>
    <label class="check"><input type="checkbox" name="useSavedCurves" ${state.draft?.useSavedCurves ? 'checked' : ''}> Использовать сохранённые рыночные кривые</label>
    <div class="form-actions"><button class="button primary" type="submit" ${state.generating ? 'disabled' : ''}>Рассчитать портфель</button>
      <p class="note">Подготовка кривых · денежные потоки · сценарии · факторный анализ</p></div>
    </form></section>`;
  if (!last) return title + generator;
  const date = work.periods.find((p) => p.date === state.portfolioDay)?.date ?? last.date;
  const head = `<div class="panel-head"><div><h2>Состав портфеля</h2><p class="note">${work.uniqueDeals} уникальных сделок за период. Нажмите на ID для просмотра платежей.</p></div>
    ${link(exportUrl(work, date + '/calculator_input.csv'), 'CSV для калькулятора')}</div>`;
  return title + generator + `<section class="panel">${head}<form class="toolbar" id="deal-search">
    <label class="field">Дата<select id="portfolio-date">${dateOpts(work.periods.map((p) => p.date), date)}</select></label>
    <label class="field">ID сделки<input type="search" name="query" value="${esc(state.dealQuery ?? '')}" placeholder="Например, 120"></label><button class="button" type="submit">Найти</button>
    </form><div id="deal-table" aria-live="polite"><p class="note">Загрузка списка сделок…</p></div></section>`;
}

export function dealTable(data) {
  if (!data.rows.length) return '<p class="note">Совпадений нет.</p>';
  const cols = [['ID'], ['Остаток', 'num'], ['Ставка, %', 'num'], ['Срок, лет', 'num'], ['График'], ['PV базы', 'num']];
  const lines = data.rows.map((row) => `<tr><th scope="row"><button class="ghost" data-action="flow" data-key="${esc(row.deal_id)}">${esc(row.deal_id)}</button></th>
    <td class="num">${exact(+row.principal, ' ₽')}</td><td class="num">${n(+row.contract_rate)}</td><td class="num">${n(+row.term_years)}</td>
    <td>${esc(row.payment_type)}</td><td class="num">${exact(+row.npv, ' ₽')}</td></tr>`);
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
  const integrated = work?.source === 'integrated';
  const importForm = `<section class="panel">${h2('Загрузить историю CSV', 'Одна строка на сделку и дату. Нужны ID, отчётная дата, числовая метрика и признаки.') }
    <form id="import-form" class="toolbar"><label class="field">Файл истории<input type="file" name="csvfile" accept=".csv,.tsv,text/csv" required></label>
    <button class="button primary" type="submit">Загрузить</button></form>
    <p class="note">Кодировка UTF-8 до 6 МБ и 20 000 строк. Поддерживаются запятая, точка с запятой и табуляция.</p></section>`;
  if (!work?.profile) return heading('Данные', 'Проверьте происхождение показателей и настройте поля анализа.') + importForm;
  const columns = work.profile.columns;
  const opts = work.options;
  const prefs = state.mapping ?? opts;
  const targets = integrated ? opts.targets : columns.filter((col) => col.kind === 'numeric' && col.missing === 0
    && ![prefs.dateColumn, prefs.idColumn].includes(col.name)).map((col) => col.name);
  const excluded = new Set([prefs.dateColumn, prefs.idColumn, prefs.target]);
  const candidate = integrated ? opts.candidateFeatures : columns.filter((col) => !excluded.has(col.name) && col.kind !== 'date'
    && col.distinct > 1 && col.missing <= work.profile.rows / 2 && (col.kind !== 'category' || col.distinct <= 30)
    && !/(?:^|[_\s-])(?:id|код|номер|идентификатор)(?:$|[_\s-])/iu.test(col.name)).map((col) => col.name).slice(0, 16);
  const picked = new Set(state.mapping ? candidate : work.report?.selectedFeatures ?? candidate);
  const dateFields = columns.filter((col) => col.kind === 'date' && !col.missing).map((col) => col.name);
  const field = (name, title, keys) => `<label class="field"><span id="mapping-label-${name}">${title}</span>
    <select name="${name}" data-column="${name}" aria-labelledby="mapping-label-${name}">
    ${option('', 'Выберите колонку', prefs[name])}${keys.map((key) => option(key, titleOf(work, key), prefs[name])).join('')}</select></label>`;
  const kinds = { numeric: 'Числовой', category: 'Категория', date: 'Дата' };
  const columnRows = columns.map((col) => `<tr><th scope="row">${esc(titleOf(work, col.name))}</th><td>${kinds[col.kind]}</td>
    <td class="num">${n(col.missing)}</td><td class="num">${n(col.distinct)}</td><td class="num">${n(col.outliers)}</td>
    <td class="num">${col.kind === 'numeric' ? n(col.min) + ' … ' + n(col.max) : '—'}</td></tr>`);
  const evidence = integrated ? `<section class="panel sources">${h2('Источники расчёта', 'Для каждой даты сохранён ответ API, вход калькулятора и результаты.')}
    ${table([['Дата'], ['Сделок', 'num'], ['Строк CF', 'num'], ['API кривых'], ['Выгрузки']],
      work.periods.map((p) => `<tr><th scope="row">${day(p.date)}</th><td class="num">${p.deals}</td><td class="num">${n(p.flowRows)}</td>
        <td class="mono" title="SHA-256 ${esc(p.sha256)}">${p.curveSource === 'api' ? 'MOEX через API' : 'Сохранённый ответ'} · ${esc(p.runId.slice(0, 8))}</td>
        <td><a href="${exportUrl(work, p.date + '/standard-result.json')}">Кривые</a> ·
        <a href="${exportUrl(work, p.date + '/cashflows.csv')}">Потоки</a> ·
        <a href="${exportUrl(work, p.date + '/deal_summary.csv')}">Сводка</a></td></tr>`), 'Доказательства интеграции')}
    <p class="note checks-note">${esc(work.method)}. PV рассчитана по готовым DF из ответа кривых команды 2.</p></section>` : '';
  return heading('Данные', 'Здесь видны исходные данные, состав модели и результаты команд по датам.',
    link(exportUrl(work, 'dataset.csv'), 'Скачать набор CSV')) + `<div class="grid-two">${importForm}
      <section class="panel">${h2('Настройка модели', `${n(work.profile.rows)} строк · ${integrated ? 'синтетические сделки и рыночные кривые' : esc(work.filename)}`)}
        <form id="mapping-form"><div class="form-grid">${integrated ? '' : field('dateColumn', 'Дата', dateFields) + field('idColumn', 'ID', columns.map((col) => col.name))}
          ${field('target', 'Метрика для анализа', targets)}</div>
          <div class="criteria" role="group" aria-label="Признаки модели">${candidate.map((key) => `<label class="check">
            <input type="checkbox" name="feature" value="${esc(key)}" ${picked.has(key) ? 'checked' : ''}>${esc(titleOf(work, key))}</label>`).join('')}</div>
          <div class="form-actions"><button class="button primary" type="submit">Пересчитать</button></div>
          <p class="note checks-note">Исключите производные от целевой метрики. Источник, пропуски и типы видны в профиле.</p>
        </form></section></div>${evidence}
    <section class="panel">${h2('Профиль таблицы', 'Выбросы отмечаются по правилу 1,5 межквартильного размаха. Строки остаются в данных.')}
      ${table([['Колонка'], ['Тип'], ['Пропуски','num'], ['Различных','num'], ['Выбросы','num'], ['Диапазон','num']], columnRows, 'Профиль колонок')}</section>`;
}
