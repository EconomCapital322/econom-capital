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
  const w = 920, h = 292, l = 74, r = 19, t = 28, b = 225;
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
  const step = nice(span / 5);
  const min = Math.floor((low - 0.12 * span) / step) * step;
  const max = Math.ceil((high + 0.14 * span) / step) * step;
  const y = (a) => b - ((a - min) / (max - min)) * (b - t);
  const band = (w - l - r) / values.length;
  const barWidth = Math.min(72, band * 0.66);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => {
    const value = min + i * step;
    return `<line class="grid" x1="${l}" x2="${w - r}" y1="${y(value)}" y2="${y(value)}"/><text x="${l - 9}" y="${y(value) + 4}" text-anchor="end">${esc(short(value, unit))}</text>`;
  }).join('');
  const drawings = values.map((entry, i) => {
    const x = l + (i + 0.5) * band;
    const top = y(entry.total ? Math.max(entry.value, 0) : Math.max(entry.from, entry.to));
    const bottom = y(entry.total ? Math.min(entry.value, 0) : Math.min(entry.from, entry.to));
    const state = entry.total ? 'total' : ['residual', 'reconciliation'].includes(entry.key) ? 'residual' : entry.value >= 0 ? 'up' : 'down';
    const label = wrap(entry.chartLabel ?? entry.label, Math.max(6, Math.min(15, Math.floor(band / 6.5))));
    const figure = entry.total ? short(entry.value) : (entry.value > 0 ? '+' : '') + short(entry.value);
    const tail = i < values.length - 1
      ? `<line class="connector" x1="${x + barWidth / 2}" x2="${x + band - barWidth / 2}" y1="${y(entry.total ? entry.value : entry.to)}" y2="${y(entry.total ? entry.value : entry.to)}"/>`
      : '';
    return `${tail}<g tabindex="0" role="button" aria-pressed="${active === entry.key}" data-key="${esc(entry.key)}" data-action="factor" aria-label="${esc(entry.label)} ${esc(exact(entry.value, unit))}">
      <title>${esc(entry.label)} · ${esc(entry.total ? exact(entry.value, unit) : signed(entry.value, unit))}</title>
      <rect class="bar-hit" x="${x - band / 2 + 2}" y="${t - 18}" width="${band - 4}" height="${b - t + 52}" rx="4"/>
      <rect class="bar-${state}" x="${x - barWidth / 2}" y="${top}" width="${barWidth}" height="${Math.max(1.5, bottom - top)}" rx="2"/>
      <text class="value" x="${x}" y="${Math.max(17, top - 8)}" text-anchor="middle">${esc(figure)}</text>
      <text class="group-label" x="${x}" y="${b + 20}" text-anchor="middle">${esc(label[0])}${label[1] ? `<tspan x="${x}" dy="13">${esc(label[1])}</tspan>` : ''}</text></g>`;
  }).join('');
  return `<div class="chart-scroll" tabindex="0" aria-label="Прокручиваемый график вкладов"><svg class="chart chart-waterfall" role="group" aria-label="Водопад изменения показателя. Нажмите на столбец, чтобы открыть детали" viewBox="0 0 ${w} ${h}">${ticks}${drawings}</svg></div>
    <p class="note">Итоговые столбцы начинаются от нуля. Нажмите на столбец для пояснения.</p>`;
}

export function bars(items, { unit = '', action, active, label, left = 195, narrow = false } = {}) {
  const values = items.filter((item) => Number.isFinite(item.value));
  if (!values.length) return '<p class="note">Недостаточно наблюдений для графика.</p>';
  const width = narrow ? 610 : 740, right = 68, top = 18, row = 33;
  left = narrow ? Math.min(left, 155) : left;
  const end = width - right, plot = end - left;
  const maximum = Math.max(0, ...values.map((item) => item.value));
  const minimum = Math.min(0, ...values.map((item) => item.value));
  const span = maximum - minimum || 1;
  const x = (value) => left + (value - minimum) / span * plot;
  const zero = x(0);
  const rows = values.map((item, i) => {
    const y = top + i * row;
    const xEnd = x(item.value);
    const act = action ? `data-action="${action}" data-key="${esc(item.key)}" role="button" tabindex="0" aria-pressed="${active === item.key}"` : '';
    const type = item.value >= 0 ? 'up' : 'down';
    return `<g ${act} aria-label="${esc(item.label)} ${esc(signed(item.value, unit))}">
      <title>${esc(item.label)} · ${esc(signed(item.value, unit))}</title>
      ${action ? `<rect class="bar-hit" x="2" y="${y - 6}" width="${width - 5}" height="${row - 2}" rx="4"/>` : ''}
      <text class="group-label" x="6" y="${y + 12}">${esc(wrap(item.label, narrow ? 25 : 31).join(' ').slice(0, narrow ? 26 : 33))}</text>
      <rect class="bar-${type}" x="${Math.min(zero, xEnd)}" y="${y}" width="${Math.max(1.5, Math.abs(zero - xEnd))}" height="16" rx="3"/>
      <text class="value" text-anchor="end" x="${width - 6}" y="${y + 12}">${esc((item.value > 0 ? '+' : '') + short(item.value, unit))}</text></g>`;
  }).join('');
  return `<svg class="chart" role="group" aria-label="${esc(label ?? 'Вклады факторов')}" viewBox="0 0 ${width} ${top + row * values.length + 1}">
    <line class="zero" x1="${zero}" x2="${zero}" y1="6" y2="${top + row * values.length - 4}"/>${rows}</svg>`;
}

export function lineChart(series, { unit = '', title = '', axes = [], connect = true } = {}) {
  const points = series.flatMap((entry) => entry.points).filter((entry) => Number.isFinite(entry.value));
  if (points.length < 2) return '<p class="note">Недостаточно точек для графика.</p>';
  const w = 730, h = 239, l = 67, r = 17, t = 17, b = 197;
  const xMin = Math.min(...points.map((p) => p.x)), xMax = Math.max(...points.map((p) => p.x));
  const yMin = Math.min(...points.map((p) => p.value)), yMax = Math.max(...points.map((p) => p.value));
  const span = yMax - yMin || Math.max(1, Math.abs(yMax) * 0.08);
  const step = nice(span / 4, 0.00001);
  const low = Math.floor((yMin - 0.08 * span) / step) * step;
  const high = Math.ceil((yMax + 0.08 * span) / step) * step;
  const x = (value) => l + (value - xMin) / (xMax - xMin || 1) * (w - l - r);
  const y = (value) => b - (value - low) / (high - low) * (b - t);
  const grid = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, i) => {
    const value = low + step * i;
    return `<line class="${Math.abs(value) < step / 10 ? 'zero' : 'grid'}" x1="${l}" x2="${w - r}" y1="${y(value)}" y2="${y(value)}"/><text x="${l - 8}" y="${y(value) + 4}" text-anchor="end">${esc(short(value, unit))}</text>`;
  }).join('');
  const axisPoints = axes.length ? axes : series[0].points;
  const marks = axisPoints.filter((p, i, a) => i === 0 || i === a.length - 1 ||
    (i % Math.ceil(a.length / 7) === 0 && x(p.x) - l > 35 && w - r - x(p.x) > 36))
    .map((p, i, a) => `<text x="${x(p.x)}" y="${b + 18}" text-anchor="${i === 0 ? 'start' : i === a.length - 1 ? 'end' : 'middle'}">${esc(p.label ?? n(p.x))}</text>`).join('');
  const traces = series.map((entry) => `<g stroke="${entry.color}" aria-label="${esc(entry.name)}">
    ${connect ? `<polyline fill="none" stroke-width="2.7" stroke-linejoin="round" points="${entry.points.map((p) => x(p.x) + ',' + y(p.value)).join(' ')}"/>` : ''}
    ${entry.points.map((p) => `<circle cx="${x(p.x)}" cy="${y(p.value)}" r="${p.selected ? 5.5 : 3.4}" fill="${p.selected ? entry.color : '#fff'}" stroke-width="2">
      <title>${esc(p.label ?? n(p.x))} · ${esc(exact(p.value, unit))}${p.support ? ' · ' + p.support + ' строк' : ''}</title></circle>`).join('')}</g>`).join('');
  return `<svg class="chart" role="img" aria-label="${esc(title)}" viewBox="0 0 ${w} ${h}">${grid}${marks}${traces}</svg>`;
}
