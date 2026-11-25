const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const exactFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const scaleFormat = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const smallFormat = new Intl.NumberFormat('ru-RU', { notation: 'scientific', maximumFractionDigits: 2 });
const unsignedZero = (value) => value === 0 ? 0 : value;

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export const n = (value) => Number.isFinite(value) ? numberFormat.format(unsignedZero(value)) : '—';
export const exact = (value, unit = '') => Number.isFinite(value)
  ? (Math.abs(value) > 0 && Math.abs(value) < .005 ? smallFormat : exactFormat).format(unsignedZero(value)) + unit : '—';
export const short = (value, unit = '') => Number.isFinite(value)
  ? (Math.abs(value) > 0 && Math.abs(value) < .05 ? smallFormat : scaleFormat).format(unsignedZero(value)) + unit : '—';
export const signed = (value, unit = '') => (value > 0 ? '+' : '') + exact(value, unit);
export const tone = (value) => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
export const day = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? iso.split('-').reverse().join('.') : '';
export function displayNumber(value, unit, format) {
  if (unit === ' ₽') unit = '\u00a0₽';
  if (format === 'signed') return signed(value, unit);
  if (format === 'change') return (value > 0 ? '+' : '') + short(value, unit);
  return short(value, unit);
}

export function numberMarkup(key, value, unit, format = 'compact') {
  const amount = Number.isFinite(value) ? value : '';
  return `<span class="motion-number" data-number-key="${esc(key)}" data-number-value="${amount}">${esc(displayNumber(value, unit, format))}</span>`;
}
const wrap = (text, maxLength = 14) => {
  const str = String(text);
  if (str.length <= maxLength) return [str];
  const at = str.lastIndexOf(' ', maxLength);
  return at > 0 ? [str.slice(0, at), str.slice(at + 1, at + maxLength) + (str.length - at > maxLength ? '…' : '')]
    : [str.slice(0, maxLength - 1) + '…'];
};

function nice(value, floor = 0.01) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(floor, Math.abs(value)))));
  return ([1, 2, 2.5, 5, 10].find((t) => t * magnitude >= value) ?? 10) * magnitude;
}

export function waterfall({ start, end, bars, active, unit }) {
  const w = 920, h = 260, l = 74, r = 19, t = 24, b = 220;
  const values = [{ key: 'start', label: 'Начало', value: start, total: true }];
  let current = start;
  for (const bar of bars) {
    values.push({ ...bar, from: current, to: current + bar.value });
    current += bar.value;
  }
  values.push({ key: 'end', label: 'Конец', value: end, total: true });
  const extrema = [0, start, end, ...values.filter((v) => !v.total).flatMap((v) => [v.from, v.to])];
  const low = Math.min(...extrema), high = Math.max(...extrema);
  const span = high - low || Math.max(1, Math.abs(high) * 0.03);
  const step = nice(span / 5, 1e-12);
  const min = low === 0 ? 0 : Math.floor((low - 0.07 * span) / step) * step;
  const max = high === 0 ? (min === 0 ? step : 0) : Math.ceil((high + 0.06 * span) / step) * step;
  const y = (a) => b - ((a - min) / (max - min)) * (b - t);
  const band = (w - l - r) / values.length;
  const barWidth = Math.min(72, band * 0.66);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => {
    const value = min + i * step;
    return `<line class="${Math.abs(value) < step / 10 ? 'zero' : 'grid'}" x1="${l}" x2="${w - r}" y1="${y(value)}" y2="${y(value)}"/><text x="${l - 9}" y="${y(value) + 4}" text-anchor="end">${esc(short(value, unit))}</text>`;
  }).join('');
  const barState = (entry) => entry.total ? 'total' : entry.value === 0 || ['residual', 'reconciliation'].includes(entry.key) ? 'residual' : entry.value > 0 ? 'up' : 'down';
  const figureText = (entry) => entry.key === 'reconciliation' && entry.value !== 0 && Math.abs(entry.value) < .01
    ? '<0,01' : entry.total ? short(entry.value) : displayNumber(entry.value, '', 'change');
  const barControl = (entry) => {
    const figure = entry.total ? exact(entry.value, unit) : signed(entry.value, unit);
    return `<g tabindex="0" role="button" aria-pressed="${active === entry.key}" data-key="${esc(entry.key)}" data-action="factor"
      data-tip-title="${esc(entry.label)}" data-tip-value="${esc(figure)}" aria-label="${esc(entry.label)} ${esc(exact(entry.value, unit))}">`;
  };
  const drawings = values.map((entry, i) => {
    const x = l + (i + 0.5) * band;
    const top = y(entry.total ? Math.max(entry.value, 0) : Math.max(entry.from, entry.to));
    const bottom = y(entry.total ? Math.min(entry.value, 0) : Math.min(entry.from, entry.to));
    const label = wrap(entry.chartLabel ?? entry.label, Math.max(6, Math.min(15, Math.floor(band / 6.5))));
    const tail = i < values.length - 1
      ? `<line class="connector" x1="${x + barWidth / 2}" x2="${x + band - barWidth / 2}" y1="${y(entry.total ? entry.value : entry.to)}" y2="${y(entry.total ? entry.value : entry.to)}"/>`
      : '';
    return `${tail}${barControl(entry)}
      <rect class="bar-hit" x="${x - band / 2 + 2}" y="${t - 18}" width="${band - 4}" height="${b - t + 52}" rx="4"/>
      <rect class="bar-${barState(entry)} waterfall-bar" data-morph-key="${esc(entry.key)}" x="${x - barWidth / 2}" y="${top}" width="${barWidth}" height="${Math.max(1.5, bottom - top)}" rx="3"/>
      <text class="value" x="${x}" y="${Math.max(17, top - 8)}" text-anchor="middle">${esc(figureText(entry))}</text>
      <text class="group-label" x="${x}" y="${b + 20}" text-anchor="middle">${esc(label[0])}${label[1] ? `<tspan x="${x}" dy="13">${esc(label[1])}</tspan>` : ''}</text></g>`;
  }).join('');
  const mobileWidth = 380, left = 130, right = 305, top = 27, rowHeight = 34;
  const plotEnd = top + values.length * rowHeight;
  const xAt = (value) => left + (value - min) / (max - min) * (right - left);
  const zero = xAt(0);
  const compactTicks = [[min, 'start'], [max, 'end']];
  if (zero - left > 56 && right - zero > 56) compactTicks.push([0, 'middle']);
  const compactAxis = compactTicks.map(([value, anchor]) =>
    `<text class="waterfall-axis-label" x="${xAt(value)}" y="${plotEnd + 2}" text-anchor="${anchor}">${esc(short(value, unit))}</text>`).join('');
  const mobile = values.map((entry, index) => {
    const y = top + index * rowHeight;
    const x1 = xAt(entry.total ? 0 : entry.from), x2 = xAt(entry.total ? entry.value : entry.to);
    const label = wrap(entry.chartLabel ?? entry.label, 17);
    return `${index === values.length - 1 ? '' : `<line class="connector" x1="${x2}" x2="${x2}" y1="${y + 6}" y2="${y + rowHeight - 6}"/>`}
      ${barControl(entry)}<rect class="bar-hit" x="1" y="${y - 16}" width="378" height="32" rx="4"/>
      <text class="group-label" x="5" y="${label[1] ? y - 3 : y + 4}">${esc(label[0])}${label[1] ? `<tspan x="5" dy="12">${esc(label[1])}</tspan>` : ''}</text>
      <rect class="bar-${barState(entry)} waterfall-bar" data-morph-key="${esc(entry.key)}" x="${Math.min(x1, x2)}" y="${y - 6}" width="${Math.max(1.5, Math.abs(x1 - x2))}" height="12" rx="3"/>
      <text class="value" x="375" y="${y + 4}" text-anchor="end">${esc(figureText(entry))}</text></g>`;
  }).join('');
  const aria = 'Водопад изменения показателя. Выберите вклад, чтобы открыть детали';
  return `<div class="waterfall-frame"><svg class="chart chart-waterfall" data-chart-shape="wide" role="group" aria-label="${aria}" viewBox="0 0 ${w} ${h}">${ticks}${drawings}</svg>
    <svg class="chart chart-waterfall-compact" data-chart-shape="compact" role="group" aria-label="${aria}" viewBox="0 0 ${mobileWidth} ${plotEnd + 7}">
      <line class="zero" x1="${zero}" x2="${zero}" y1="10" y2="${plotEnd - 13}"/>
      ${compactAxis}${mobile}</svg></div>
    <p class="note waterfall-note">Итоги от нуля. Выберите вклад для пояснения.</p>`;
}

export function bars(items, { unit = '', label = 'Вклады факторов', motionKey = '' } = {}) {
  const values = items.filter((item) => Number.isFinite(item.value));
  if (!values.length) return '<p class="note">Недостаточно наблюдений для графика.</p>';
  const maximum = Math.max(0, ...values.map((item) => item.value));
  const minimum = Math.min(0, ...values.map((item) => item.value));
  const span = maximum - minimum || 1;
  const x = (value) => 100 * (value - minimum) / span;
  const zero = minimum === maximum ? 50 : x(0);
  const rows = values.map((item) => {
    const start = x(Math.min(0, item.value));
    const width = 100 * Math.abs(item.value) / span;
    return `<div class="contribution-row ${tone(item.value)}"${motionKey ? ` data-plot-match="${esc(item.label)}"` : ''} title="${esc(item.label)} · ${esc(signed(item.value, unit))}">
      <span class="contribution-name">${esc(item.chartLabel ?? item.label)}</span>
      <span class="contribution-track" aria-hidden="true"><i ${motionKey ? `data-morph-key="${esc(item.label)}"` : ''} style="--start:${start}%;--width:${width}%"></i></span>
      <strong class="contribution-value">${esc((item.value > 0 ? '+' : '') + short(item.value, unit))}</strong>
    </div>`;
  }).join('');
  return `<div class="contribution-chart bar-chart"${motionKey ? ` data-chart-scope="${esc(motionKey)}"` : ''} role="group" aria-label="${esc(label)}" style="--zero:${zero}%">${rows}</div>`;
}

export function divergingBars(items, { active, unit = '' } = {}) {
  const rows = items.filter((item) => Number.isFinite(item.value)).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (!rows.length) return '<p class="note">За этот период вклады не рассчитаны.</p>';
  const max = Math.max(...rows.map((item) => Math.abs(item.value))) || 1;
  return `<div class="contribution-chart" role="group" aria-label="Вклады факторов относительно нуля">
    <div class="contribution-axis" aria-hidden="true"><span>Компонент</span><span><b>−</b><b>0</b><b>+</b></span><span>Вклад</span></div>
    ${rows.map((item) => {
      const amount = signed(item.value, unit);
      const start = item.value < 0 ? 50 - 50 * Math.abs(item.value) / max : 50;
      const width = 50 * Math.abs(item.value) / max;
      const color = item.key === 'residual' || item.key === 'reconciliation' || !item.value ? 'neutral' : tone(item.value);
      return `<button type="button" class="contribution-row ${color}" data-action="factor" data-key="${esc(item.key)}"
        aria-pressed="${active === item.key}" data-tip-title="${esc(item.label)}" data-tip-value="${esc(amount)}">
        <span class="contribution-name">${esc(item.chartLabel ?? item.label)}</span>
        <span class="contribution-track" aria-hidden="true"><i data-morph-key="${esc(item.key)}" style="--start:${start}%;--width:${width}%"></i></span>
        <strong class="contribution-value">${esc(amount)}</strong>
      </button>`;
    }).join('')}
  </div>`;
}

let nextPlot = 0;
const chartIcon = (id) => `<svg class="icon" aria-hidden="true"><use href="#icon-${id}"/></svg>`;
export const expandChart = (target = '') => `<button type="button" class="icon-button chart-expand" data-chart-command="expand"
  ${target ? `data-chart-target="${target}"` : ''} aria-label="Развернуть график" title="Развернуть график">${chartIcon('expand')}</button>`;

export function lineChart(series, { unit = '', title = '', axes = [], connect = true, xLabel = '', yLabel = '', tall = false,
  domain = [], motionKey = '', inspect = false, period = false } = {}) {
  const valid = (point) => Number.isFinite(point?.value) && Number.isFinite(point.x);
  const points = series.flatMap((entry) => entry.points).filter(valid);
  if (points.length < 2) return '<p class="note">Недостаточно точек для графика.</p>';
  const w = 736, l = 69, r = 21, t = 19, b = tall ? 251 : 190, h = b + 31;
  const clipId = 'chart-clip-' + ++nextPlot;
  const xMin = Math.min(...points.map((p) => p.x)), xMax = Math.max(...points.map((p) => p.x));
  const yMin = Math.min(...domain, ...points.map((p) => p.value)), yMax = Math.max(...domain, ...points.map((p) => p.value));
  const span = yMax - yMin || Math.max(1, Math.abs(yMax) * 0.08);
  const step = nice(span / 4, 0.00001);
  const low = Math.floor((yMin - 0.08 * span) / step) * step;
  const high = Math.ceil((yMax + 0.08 * span) / step) * step;
  const x = (value) => l + (value - xMin) / (xMax - xMin || 1) * (w - l - r);
  const y = (value) => b - (value - low) / (high - low) * (b - t);
  const grid = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, i) => {
    const value = low + step * i;
    return `<line class="${Math.abs(value) < step / 10 ? 'zero' : 'grid'}" x1="${l}" x2="${w - r}" y1="${y(value)}" y2="${y(value)}"/>
      <text x="${l - 8}" y="${y(value) + 4}" text-anchor="end">${esc(short(value, yLabel ? '' : unit))}</text>`;
  }).join('');
  const explicitAxis = axes.filter((point) => Number.isFinite(point.x));
  const axis = (explicitAxis.length ? explicitAxis : [...new Map(points.map((point) => [point.x, point])).values()]).sort((a, b) => a.x - b.x);
  const marks = [axis[0]];
  const end = axis.at(-1);
  for (const point of axis.slice(1, -1)) {
    if (x(point.x) - x(marks.at(-1).x) >= 77 && x(end.x) - x(point.x) >= 77) marks.push(point);
  }
  if (end !== axis[0]) marks.push(end);
  const ticks = (inspect ? axis : marks).map((p) => {
    const name = String(p.label ?? n(p.x));
    const text = name.length > 13 ? name.slice(0, 12) + '…' : name;
    return `<text x="${x(p.x)}" y="${b + 21}" text-anchor="${p === axis[0] ? 'start' : p === end ? 'end' : 'middle'}"
      ${inspect ? `data-axis-x="${x(p.x)}"${marks.includes(p) ? '' : ' visibility="hidden"'}` : ''}><title>${esc(name)}</title>${esc(text)}</text>`;
  }).join('');
  const traces = series.map((entry) => {
    const runs = [[]];
    for (const point of entry.points) {
      if (valid(point)) runs.at(-1).push(`${x(point.x)},${y(point.value)}`);
      else if (runs.at(-1).length) runs.push([]);
    }
    return `<g stroke="${entry.color}" data-series="${esc(entry.name)}"${entry.morph ? ' data-morph-line' : ''}>
      ${connect ? runs.filter((run) => run.length > 1).map((run) => `<polyline fill="none" stroke-width="2.4" stroke-linejoin="round" stroke-dasharray="${entry.dash ?? 'none'}" points="${run.join(' ')}"/>`).join('') : ''}
      ${entry.points.filter(valid).map((p) => `<circle cx="${x(p.x)}" cy="${y(p.value)}" r="${p.selected ? 5 : connect ? 2.75 : 3}" fill="${p.selected || !connect ? entry.color : 'var(--surface)'}" stroke-width="${connect ? 1.55 : 0}"
        data-point="${p.x}" data-label="${esc(p.date ? day(p.date) : p.label ?? n(p.x))}"${p.date ? ` data-date="${esc(p.date)}"` : ''} data-value="${esc(exact(p.value, unit) + (p.support ? ' · ' + n(p.support) + ' строк' : ''))}"/>`).join('')}</g>`;
  }).join('');
  const svg = `<svg class="chart line-chart" role="img" aria-label="${esc(title)}" data-crosshair${motionKey ? ` data-chart-scope="${esc(motionKey)}"` : ''} viewBox="0 0 ${w} ${h}">
    ${grid}${ticks}${inspect ? `<defs><clipPath id="${clipId}"><rect x="${l - 6}" y="${t - 6}" width="${w - l - r + 12}" height="${b - t + 12}"/></clipPath></defs>
      <g clip-path="url(#${clipId})"><rect x="${l}" y="${t}" width="${w - l - r}" height="${b - t}" fill="transparent"/>
      <g data-plot data-left="${l}" data-right="${w - r}">${traces}</g></g>` : traces}
    <g class="chart-cursor" aria-hidden="true"><line x1="0" x2="0" y1="${t}" y2="${b}"/></g></svg>`;
  const dates = period ? [...new Map(points.filter((p) => day(p.date)).map((p) => [p.date, p])).values()] : [];
  const rangeOptions = (selected) => dates.map((p) => `<option value="${p.date}"${p.date === selected ? ' selected' : ''}>${day(p.date)}</option>`).join('');
  const tools = inspect ? `<div class="chart-tools" role="group" aria-label="Инструменты графика">
    ${dates.length > 1 ? '<button type="button" class="button small" data-chart-command="period" aria-expanded="false">Период</button>' : ''}
    <button type="button" class="icon-button" data-chart-command="out" aria-label="Уменьшить масштаб" title="Уменьшить масштаб" disabled>−</button>
    <button type="button" class="icon-button" data-chart-command="in" aria-label="Увеличить масштаб" title="Увеличить масштаб">+</button>
    <button type="button" class="button small chart-reset" data-chart-command="reset" disabled>Сбросить</button>
    ${expandChart()}</div>` : '';
  const range = dates.length > 1 ? `<div class="chart-range" hidden>
      <label class="field">Начало<select data-chart-before>${rangeOptions(dates.find((p) => p.selected)?.date ?? dates[0].date)}</select></label>
      <label class="field">Конец<select data-chart-after>${rangeOptions(dates.findLast((p) => p.selected)?.date ?? dates.at(-1).date)}</select></label>
      <button type="button" class="button small" data-chart-command="apply-period">К параметрам расчёта</button>
      <p class="note" data-chart-range-note role="status" hidden></p></div>` : '';
  return `<figure class="line-figure"${inspect ? ' data-chart-figure' : ''}><div class="line-heading">
    ${yLabel ? `<p class="line-caption">${esc(yLabel)}</p>` : '<span></span>'}${tools}</div>${range}
    <div class="chart-scroll" tabindex="0" aria-label="${esc(title)}. Стрелки влево и вправо показывают значения${inspect ? ', Enter закрепляет подсказку' : ''}">${svg}<span class="sr-only" data-chart-announcement aria-live="polite"></span></div>${xLabel ? `<p class="axis-caption">${esc(xLabel)}</p>` : ''}</figure>`;
}
