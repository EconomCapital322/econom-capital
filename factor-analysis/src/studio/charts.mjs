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
    const underCent = entry.key === 'reconciliation' && entry.value !== 0 && Math.abs(entry.value) < .01;
    const figure = underCent ? '<0,01' : entry.total ? short(entry.value) : (entry.value > 0 ? '+' : '') + short(entry.value);
    const tail = i < values.length - 1
      ? `<line class="connector" x1="${x + barWidth / 2}" x2="${x + band - barWidth / 2}" y1="${y(entry.total ? entry.value : entry.to)}" y2="${y(entry.total ? entry.value : entry.to)}"/>`
      : '';
    return `${tail}<g tabindex="0" role="button" aria-pressed="${active === entry.key}" data-key="${esc(entry.key)}" data-action="factor" aria-label="${esc(entry.label)} ${esc(exact(entry.value, unit))}">
      <title>${esc(entry.label)} · ${esc(entry.total ? exact(entry.value, unit) : signed(entry.value, unit))}</title>
      <rect class="bar-hit" x="${x - band / 2 + 2}" y="${t - 18}" width="${band - 4}" height="${b - t + 52}" rx="4"/>
      <rect class="bar-${state} waterfall-bar ${tone(entry.value)}" x="${x - barWidth / 2}" y="${top}" width="${barWidth}" height="${Math.max(1.5, bottom - top)}" rx="3" style="--entry-delay:${i * 22}ms"/>
      <text class="value" x="${x}" y="${Math.max(17, top - 8)}" text-anchor="middle">${esc(figure)}</text>
      <text class="group-label" x="${x}" y="${b + 20}" text-anchor="middle">${esc(label[0])}${label[1] ? `<tspan x="${x}" dy="13">${esc(label[1])}</tspan>` : ''}</text></g>`;
  }).join('');
  return `<div class="chart-scroll" tabindex="0" aria-label="Прокручиваемый график вкладов"><svg class="chart chart-waterfall" role="group" aria-label="Водопад изменения показателя. Нажмите на столбец, чтобы открыть детали" viewBox="0 0 ${w} ${h}">${ticks}${drawings}</svg></div>
    <p class="note">Итоговые столбцы начинаются от нуля. Нажмите на столбец для пояснения.</p>`;
}

export function bars(items, { unit = '', label = 'Вклады факторов' } = {}) {
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
    return `<div class="contribution-row ${tone(item.value)}" title="${esc(item.label)} · ${esc(signed(item.value, unit))}">
      <span class="contribution-name">${esc(item.chartLabel ?? item.label)}</span>
      <span class="contribution-track" aria-hidden="true"><i style="--start:${start}%;--width:${width}%"></i></span>
      <strong class="contribution-value">${esc((item.value > 0 ? '+' : '') + short(item.value, unit))}</strong>
    </div>`;
  }).join('');
  return `<div class="contribution-chart bar-chart" role="group" aria-label="${esc(label)}" style="--zero:${zero}%">${rows}</div>`;
}

export function divergingBars(items, { active, unit = '' } = {}) {
  const rows = items.filter((item) => Number.isFinite(item.value)).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (!rows.length) return '<p class="note">За этот период вклады не рассчитаны.</p>';
  const max = Math.max(...rows.map((item) => Math.abs(item.value))) || 1;
  return `<div class="contribution-chart" role="group" aria-label="Вклады факторов относительно нуля">
    <div class="contribution-axis" aria-hidden="true"><span>Компонент</span><span><b>−</b><b>0</b><b>+</b></span><span>Вклад</span></div>
    ${rows.map((item, index) => {
      const amount = signed(item.value, unit);
      const start = item.value < 0 ? 50 - 50 * Math.abs(item.value) / max : 50;
      const width = 50 * Math.abs(item.value) / max;
      const color = item.key === 'residual' || item.key === 'reconciliation' || !item.value ? 'neutral' : tone(item.value);
      return `<button type="button" class="contribution-row ${color}" data-action="factor" data-key="${esc(item.key)}"
        aria-pressed="${active === item.key}" title="${esc(item.label)} · ${esc(amount)}">
        <span class="contribution-name">${esc(item.chartLabel ?? item.label)}</span>
        <span class="contribution-track" aria-hidden="true"><i style="--start:${start}%;--width:${width}%;--entry-delay:${index * 28}ms"></i></span>
        <strong class="contribution-value">${esc(amount)}</strong>
      </button>`;
    }).join('')}
  </div>`;
}

export function lineChart(series, { unit = '', title = '', axes = [], connect = true, xLabel = '', yLabel = '', tall = false } = {}) {
  const points = series.flatMap((entry) => entry.points).filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.x));
  if (points.length < 2) return '<p class="note">Недостаточно точек для графика.</p>';
  const w = 736, l = 69, r = 21, t = 19, b = tall ? 251 : 190, h = b + 31;
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
    return `<line class="${Math.abs(value) < step / 10 ? 'zero' : 'grid'}" x1="${l}" x2="${w - r}" y1="${y(value)}" y2="${y(value)}"/>
      <text x="${l - 8}" y="${y(value) + 4}" text-anchor="end">${esc(short(value, yLabel ? '' : unit))}</text>`;
  }).join('');
  const axis = axes.length ? axes : [...new Map(points.map((point) => [point.x, point])).values()].sort((a, b) => a.x - b.x);
  const marks = [axis[0]];
  const end = axis.at(-1);
  for (const point of axis.slice(1, -1)) {
    if (x(point.x) - x(marks.at(-1).x) >= 77 && x(end.x) - x(point.x) >= 77) marks.push(point);
  }
  if (end !== axis[0]) marks.push(end);
  const ticks = marks.map((p, i) => {
    const name = String(p.label ?? n(p.x));
    const text = name.length > 13 ? name.slice(0, 12) + '…' : name;
    return `<text x="${x(p.x)}" y="${b + 21}" text-anchor="${i === 0 ? 'start' : i === marks.length - 1 ? 'end' : 'middle'}"><title>${esc(name)}</title>${esc(text)}</text>`;
  }).join('');
  const traces = series.map((entry) => `<g stroke="${entry.color}" aria-label="${esc(entry.name)}">
    ${connect ? `<polyline fill="none" stroke-width="2.6" stroke-linejoin="round" stroke-dasharray="${entry.dash ?? 'none'}"
      points="${entry.points.map((p) => x(p.x) + ',' + y(p.value)).join(' ')}"/>` : ''}
    ${entry.points.map((p) => `<circle cx="${x(p.x)}" cy="${y(p.value)}" r="${p.selected ? 5 : 3}" fill="${p.selected || !connect ? entry.color : '#fff'}" stroke-width="${connect ? 1.8 : 0}">
      <title>${esc(p.label ?? n(p.x))} · ${esc(exact(p.value, unit))}${p.support ? ' · ' + p.support + ' строк' : ''}</title></circle>`).join('')}</g>`).join('');
  const svg = `<svg class="chart line-chart" role="img" aria-label="${esc(title)}" viewBox="0 0 ${w} ${h}">${grid}${ticks}${traces}</svg>`;
  return `<figure class="line-figure">${yLabel ? `<figcaption>${esc(yLabel)}</figcaption>` : ''}
    <div class="chart-scroll" tabindex="0" aria-label="${esc(title)}">${svg}</div>${xLabel ? `<p class="axis-caption">${esc(xLabel)}</p>` : ''}</figure>`;
}
