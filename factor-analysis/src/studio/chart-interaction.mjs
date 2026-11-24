import { displayNumber } from './charts.mjs';
import { animateContent, motionAllowed } from './motion.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const plotCache = new WeakMap();
const renderedNumbers = new WeakMap();

function barsIn(scope) {
  return [...scope.querySelectorAll('[data-morph-key]')].map((element) => {
    const chart = element.closest('[data-chart-scope]');
    const shape = element.closest('[data-chart-shape]')?.dataset.chartShape ?? 'rows';
    const group = `${chart?.dataset.chartScope}/${shape}`;
    return { key: `${group}/${element.dataset.morphKey}`, group, chart, element };
  }).filter(({ chart, element }) => chart && element.getBoundingClientRect().height > 0);
}

function curveGeometry(svg) {
  const group = svg.querySelector('[data-morph-line]');
  if (!group) return null;
  const segments = [...group.querySelectorAll('polyline')];
  if (segments.length !== 1) return null;
  const dots = [...group.querySelectorAll('[data-point]')];
  return { line: segments[0], dots, key: dots.map((dot) => dot.dataset.point).join(','),
    coordinates: dots.map((dot) => [+dot.getAttribute('cx'), +dot.getAttribute('cy')]) };
}

export function captureCharts(scope) {
  const numbers = [...scope.querySelectorAll('[data-number-key]')].map((element) => [element.dataset.numberKey,
    renderedNumbers.get(element) ?? Number.parseFloat(element.dataset.numberValue)]);
  const bars = barsIn(scope).map(({ key, group, element }) => {
    const style = getComputedStyle(element);
    return [key, { group, rect: element.getBoundingClientRect(), color: element.ownerSVGElement ? style.fill : style.backgroundColor }];
  });
  const curves = [...scope.querySelectorAll('svg[data-chart-scope]')].map((svg) => [svg.dataset.chartScope, curveGeometry(svg)]);
  return { numbers: new Map(numbers), bars: new Map(bars), curves: new Map(curves), hadCurves: curves.length > 0 };
}

const mix = (before, after, progress) => before + (after - before) * progress;
const chartTempo = 370;

export function animateCharts(scope, previous) {
  if (!motionAllowed()) return;
  const tasks = [];
  for (const element of scope.querySelectorAll('[data-number-key]')) {
    const { numberKey, numberValue, numberUnit, numberFormat } = element.dataset;
    const from = previous.numbers.get(numberKey), to = Number.parseFloat(numberValue);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    const visual = element.querySelector('[data-number-visual]');
    const overlay = document.createElement('span');
    overlay.className = 'tween-number';
    overlay.setAttribute('aria-hidden', 'true');
    element.append(overlay);
    visual.classList.add('during-tween');
    const finish = () => {
      visual.classList.remove('during-tween');
      overlay.remove();
      renderedNumbers.delete(element);
    };
    tasks.push({ element, finish, step(progress) {
      const value = mix(from, to, progress);
      renderedNumbers.set(element, value);
      overlay.textContent = displayNumber(value, numberUnit, numberFormat);
    } });
  }
  const currentBars = barsIn(scope);
  const groups = new Map(currentBars.map(({ group, chart }) => [group, chart]));
  const keys = new Set(currentBars.map(({ key }) => key));
  for (const { key, element } of currentBars) {
    if (!element.animate || !previous.bars.size) continue;
    const from = previous.bars.get(key)?.rect;
    const to = element.getBoundingClientRect();
    if (!to.width || !to.height) continue;
    const span = element.ownerSVGElement?.getScreenCTM();
    const x = from ? (from.left - to.left) / (span?.a || 1) : 0;
    const y = from ? (from.top - to.top) / (span?.d || 1) : 0;
    const sx = from ? Math.max(.01, from.width / to.width) : 1;
    const sy = from ? Math.max(.01, from.height / to.height) : .15;
    if (Math.abs(x) < .1 && Math.abs(y) < .1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) continue;
    element.animate([{ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`, opacity: from ? 1 : .1 },
      { transform: 'none', opacity: 1 }], { duration: chartTempo, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
  for (const [key, { group, rect, color }] of previous.bars) {
    const chart = groups.get(group);
    if (keys.has(key) || !chart?.animate || !rect.width || !rect.height) continue;
    const bounds = chart.getBoundingClientRect();
    const ghost = document.createElement('i');
    ghost.className = 'departing-bar';
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, background: color });
    chart.append(ghost);
    const transition = ghost.animate([{ opacity: 1 }, { opacity: 0, transform: 'scaleX(.18)' }], { duration: 160, easing: 'ease-out' });
    transition.finished.then(() => ghost.remove(), () => ghost.remove());
  }
  for (const svg of scope.querySelectorAll('svg[data-chart-scope]')) {
    const from = previous.curves.get(svg.dataset.chartScope);
    const to = curveGeometry(svg);
    if (!from || !to || from.key !== to.key || from.coordinates.some(([x], index) => Math.abs(x - to.coordinates[index][0]) > .01)) {
      if (previous.hadCurves) animateContent(svg);
      continue;
    }
    if (from.coordinates.every(([, y], index) => y === to.coordinates[index][1])) continue;
    const exact = to.line.getAttribute('points');
    tasks.push({ element: svg, finish() {
      to.line.setAttribute('points', exact);
      to.dots.forEach((dot, index) => dot.setAttribute('cy', to.coordinates[index][1]));
    }, step(progress) {
      const coordinates = to.coordinates.map(([x, y], index) => {
        const next = mix(from.coordinates[index][1], y, progress);
        to.dots[index].setAttribute('cy', next);
        return `${x},${next}`;
      });
      to.line.setAttribute('points', coordinates.join(' '));
    } });
  }
  if (!tasks.length) return;
  const start = performance.now();
  function frame(now) {
    const time = Math.max(0, Math.min(1, (now - start) / chartTempo));
    const continueMotion = time < 1 && motionAllowed();
    const progress = 1 - (1 - time) ** 3;
    for (const task of tasks) {
      if (task.element.isConnected && continueMotion) task.step(progress);
      else task.finish();
    }
    if (continueMotion && tasks.some((task) => task.element.isConnected)) requestAnimationFrame(frame);
  }
  frame(start);
}

function plotPoints(svg) {
  if (plotCache.has(svg)) return plotCache.get(svg);
  const ticks = new Map();
  for (const dot of svg.querySelectorAll('[data-point]')) {
    const x = Number(dot.dataset.point);
    if (!ticks.has(x)) ticks.set(x, { x: +dot.getAttribute('cx'), label: dot.dataset.label, dots: [] });
    ticks.get(x).dots.push(dot);
  }
  const points = [...ticks.values()].sort((a, b) => a.x - b.x);
  plotCache.set(svg, points);
  return points;
}

function nearest(points, x) {
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (x > (points[mid].x + points[mid + 1].x) / 2) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function installChartInteraction(scope) {
  const tooltip = document.createElement('div');
  tooltip.setAttribute('aria-hidden', 'true');
  tooltip.className = 'chart-tooltip';
  tooltip.dataset.glass = 'dense';
  tooltip.hidden = true;
  let active, index = -1, linked = [], pending, frame = 0;

  function hide() {
    active?.querySelector('.chart-cursor')?.classList.remove('is-visible');
    for (const item of linked) item.classList.remove('is-linked');
    linked = [];
    active = null;
    index = -1;
    tooltip.hidden = true;
    pending = null;
  }

  function show(target, title, lines, left, top) {
    const container = target.closest('dialog[open]') ?? document.body;
    if (tooltip.parentNode !== container) container.append(tooltip);
    const heading = document.createElement('strong');
    heading.textContent = title;
    const values = lines.map((value) => {
      const line = document.createElement('span');
      line.textContent = value;
      return line;
    });
    tooltip.replaceChildren(heading, ...values);
    tooltip.hidden = false;
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, left + 10))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top - height - 12))}px`;
  }

  function selectPoint(svg, next, announce = false) {
    const point = plotPoints(svg)[next];
    if (!point || active === svg && index === next && !announce) return;
    if (active !== svg) hide();
    const guide = svg.querySelector('.chart-cursor');
    guide.style.transform = `translateX(${point.x}px)`;
    guide.querySelectorAll('circle').forEach((dot) => dot.remove());
    const values = point.dots.slice(0, 8).map((dot) => {
      const marker = document.createElementNS(svgNamespace, 'circle');
      marker.setAttribute('cy', dot.getAttribute('cy'));
      marker.setAttribute('r', '4.5');
      marker.style.stroke = dot.parentElement.getAttribute('stroke');
      guide.append(marker);
      return `${dot.parentElement.dataset.series} · ${dot.dataset.value}`;
    });
    if (point.dots.length > 8) values.push(`Ещё точек: ${point.dots.length - 8}`);
    guide.classList.add('is-visible');
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const anchor = new DOMPoint(point.x, Math.min(...point.dots.map((dot) => +dot.getAttribute('cy')))).matrixTransform(matrix);
    show(svg, point.label, values, anchor.x, anchor.y);
    active = svg;
    index = next;
    if (announce) svg.parentElement.querySelector('[data-chart-announcement]').textContent = [point.label, ...values].join('. ');
  }

  function selectFactor(control, x, y) {
    if (active === control) return;
    hide();
    const key = control.dataset.key;
    linked = [...scope.querySelectorAll('[data-action="factor"], [data-link-key]')]
      .filter((candidate) => (candidate.dataset.linkKey ?? candidate.dataset.key) === key);
    for (const item of linked) item.classList.add('is-linked');
    if (control.dataset.tipTitle) show(control, control.dataset.tipTitle, [control.dataset.tipValue], x, y);
    active = control;
  }

  scope.addEventListener('pointermove', (event) => {
    const chart = event.target.closest('[data-crosshair]');
    const factor = event.target.closest('[data-action="factor"]');
    if (!chart && !factor) {
      if (active || pending) hide();
      return;
    }
    pending = { chart, factor, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      const { chart, factor, x, y } = pending;
      if (chart) {
        const matrix = chart.getScreenCTM();
        if (matrix) selectPoint(chart, nearest(plotPoints(chart), new DOMPoint(x, y).matrixTransform(matrix.inverse()).x));
        return;
      }
      selectFactor(factor, x, y);
    });
  }, { passive: true });
  scope.addEventListener('pointerleave', hide);
  scope.addEventListener('focusout', hide);
  scope.addEventListener('focusin', (event) => {
    const control = event.target.closest('[data-tip-title]');
    if (!control || !event.target.matches(':focus-visible')) return;
    const rect = control.getBoundingClientRect();
    selectFactor(control, rect.left + rect.width / 2, rect.top);
  });
  scope.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { hide(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const svg = event.target.querySelector?.('[data-crosshair]');
    if (!svg || !event.target.matches('.chart-scroll')) return;
    event.preventDefault();
    const last = plotPoints(svg).length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0,
      Math.min(last, (active === svg ? index : -1) + (event.key === 'ArrowLeft' ? -1 : 1)));
    selectPoint(svg, next, true);
    const scroll = event.target;
    const target = svg.getBoundingClientRect().width * plotPoints(svg)[next].x / svg.viewBox.baseVal.width;
    if (target < scroll.scrollLeft || target > scroll.scrollLeft + scroll.clientWidth) {
      scroll.scrollLeft = target - scroll.clientWidth / 2;
      index = -1;
      selectPoint(svg, next, true);
    }
  });
  document.addEventListener('scroll', (event) => {
    if (active?.matches('[data-crosshair]') && event.target === active.parentElement && document.activeElement === event.target) {
      const current = index;
      index = -1;
      selectPoint(active, current);
    } else hide();
  }, { capture: true, passive: true });
  return hide;
}
