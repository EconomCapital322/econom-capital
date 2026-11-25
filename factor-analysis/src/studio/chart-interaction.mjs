import { motionAllowed, openPanel } from './motion.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const plotCache = new WeakMap();
const curveSettlers = new WeakMap();
const chartViews = new WeakMap();
const scopedViews = new Map();

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
    Number.parseFloat(element.dataset.numberValue)]);
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
    const { numberKey, numberValue } = element.dataset;
    const from = previous.numbers.get(numberKey), to = Number.parseFloat(numberValue);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    element.animate?.([{ transform: 'translateY(2px)', opacity: .74 }, { transform: 'none', opacity: 1 }],
      { duration: 195, easing: 'cubic-bezier(.22,1,.36,1)' });
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
      if (previous.hadCurves) svg.animate?.([{ opacity: .82 }, { opacity: 1 }], { duration: 160 });
      continue;
    }
    if (from.coordinates.every(([, y], index) => y === to.coordinates[index][1])) continue;
    const exact = to.line.getAttribute('points');
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      to.line.setAttribute('points', exact);
      to.dots.forEach((dot, index) => dot.setAttribute('cy', to.coordinates[index][1]));
      curveSettlers.delete(svg);
      delete svg.dataset.morphing;
      svg.dispatchEvent(new Event('spectrum-chart-settled', { bubbles: true }));
    };
    curveSettlers.set(svg, finish);
    svg.dataset.morphing = '';
    tasks.push({ active: () => !settled && svg.isConnected, finish, step(progress) {
      if (settled) return;
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
      if (task.active() && continueMotion) task.step(progress);
      else task.finish();
    }
    if (continueMotion && tasks.some((task) => task.active())) requestAnimationFrame(frame);
  }
  frame(start);
}

function plotPoints(svg) {
  if (plotCache.has(svg)) return plotCache.get(svg);
  const ticks = new Map();
  for (const dot of svg.querySelectorAll('[data-point]')) {
    const x = Number(dot.dataset.point);
    if (!ticks.has(x)) ticks.set(x, { key: x, x: +dot.getAttribute('cx'), label: dot.dataset.label, date: dot.dataset.date, dots: [] });
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

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function viewport(svg) {
  const figure = svg.closest('[data-chart-figure]');
  const plot = svg.querySelector('[data-plot]');
  if (!figure || !plot) return null;
  if (!chartViews.has(figure)) {
    const key = svg.dataset.chartScope;
    const view = scopedViews.get(key) ?? { zoom: 1, offset: 0, pinned: null, rangeOpen: false, dateRange: null, anchor: null };
    chartViews.set(figure, view);
    if (key) {
      scopedViews.delete(key);
      scopedViews.set(key, view);
      if (scopedViews.size > 18) scopedViews.delete(scopedViews.keys().next().value);
    }
  }
  const view = chartViews.get(figure);
  return { view, figure, plot, left: Number(plot.dataset.left), right: Number(plot.dataset.right) };
}

function toView(x, area) {
  return area ? area.left + (x - area.left - area.view.offset) * area.view.zoom : x;
}

function fromView(x, area) {
  return area ? area.left + area.view.offset + (x - area.left) / area.view.zoom : x;
}

function paintPeriod(svg, area) {
  const mark = svg.querySelector('[data-period-mark]');
  if (!mark) return;
  const selected = area.view.dateRange ?? [];
  const positions = plotPoints(svg).filter(point => selected.includes(point.date)).map(point => toView(point.x, area));
  const start = positions[0], end = positions.at(-1);
  const visible = area.view.rangeOpen && start <= area.right && end >= area.left;
  mark.setAttribute('visibility', visible ? 'visible' : 'hidden');
  if (!visible) return;
  const rect = mark.firstElementChild;
  const left = clamp(start, area.left, area.right);
  const right = clamp(end, area.left, area.right);
  rect.setAttribute('x', left);
  rect.setAttribute('width', right - left);
  const y = rect.getAttribute('y');
  const bottom = Number(y) + Number(rect.getAttribute('height'));
  mark.lastElementChild.setAttribute('d', [...new Set(positions)].filter(x => x >= area.left && x <= area.right)
    .map(x => 'M' + x + ' ' + y + 'V' + bottom).join(' '));
}

function setPeriod(svg, dates) {
  const area = viewport(svg);
  const before = area.figure.querySelector('[data-chart-before]');
  const after = area.figure.querySelector('[data-chart-after]');
  before.value = dates[0];
  after.value = dates[1];
  area.view.dateRange = [before.value, after.value];
  area.figure.querySelector('[data-chart-range-note]').hidden = true;
  paintPeriod(svg, area);
}

function showPeriod(svg, open) {
  const { view, figure } = viewport(svg);
  const range = figure.querySelector('.chart-range');
  const plot = svg.parentElement;
  view.rangeOpen = open;
  range.hidden = !open;
  figure.classList.toggle('is-selecting-period', open);
  figure.querySelector('[data-chart-command="period"]').setAttribute('aria-expanded', String(open));
  if (open) {
    plot.setAttribute('aria-describedby', range.id + '-help');
    setPeriod(svg, view.dateRange ?? [range.querySelector('[data-chart-before]').value, range.querySelector('[data-chart-after]').value]);
  } else plot.removeAttribute('aria-describedby');
  paintPeriod(svg, viewport(svg));
}

function updateViewport(svg) {
  const area = viewport(svg);
  if (!area) return;
  const { view, figure, plot, left, right } = area;
  const { zoom, offset } = view;
  plot.setAttribute('transform', 'translate(' + (left - (left + offset) * zoom) + ',0) scale(' + zoom + ',1)');
  plot.style.setProperty('--chart-inverse-scale', 1 / zoom);
  figure.classList.toggle('is-zoomed', zoom > 1);
  for (const control of figure.querySelectorAll('[data-chart-command]')) {
    if (control.dataset.chartCommand === 'out') control.disabled = zoom === 1;
    if (control.dataset.chartCommand === 'in') control.disabled = zoom >= 8;
    if (control.dataset.chartCommand === 'reset') control.disabled = zoom === 1 && view.pinned === null;
  }
  const candidates = [...svg.querySelectorAll('[data-axis-x]')].map(node => ({ node, x: toView(Number(node.dataset.axisX), area) }));
  const last = candidates.findLast(item => item.x <= right + .01 && item.x >= left - .01);
  let previous = -Infinity;
  for (const { node, x } of candidates) {
    const show = x >= left - .01 && x <= right + .01 && (node === last?.node || x - previous >= 67 && last.x - x >= 67);
    node.setAttribute('visibility', show ? 'visible' : 'hidden');
    if (!show) continue;
    node.setAttribute('x', x);
    node.setAttribute('text-anchor', x - left < 16 ? 'start' : right - x < 16 ? 'end' : 'middle');
    previous = x;
  }
  paintPeriod(svg, area);
}

export function updateChartPlot(figure, next, compatible) {
  const existing = figure.querySelector('svg[data-crosshair]');
  const incoming = next.querySelector('svg[data-crosshair]');
  const stress = existing.querySelector('[data-morph-line]');
  const nextStress = incoming.querySelector('[data-morph-line]');
  if (compatible && stress && nextStress) {
    curveSettlers.get(existing)?.();
    stress.replaceWith(nextStress);
    plotCache.delete(existing);
  } else {
    if (!compatible) chartViews.delete(figure);
    existing.replaceWith(incoming);
  }
  updateViewport(figure.querySelector('svg[data-crosshair]'));
}

export function installChartInteraction(scope) {
  const tooltip = document.createElement('div');
  tooltip.setAttribute('aria-hidden', 'true');
  tooltip.className = 'chart-tooltip';
  tooltip.dataset.glass = 'dense';
  tooltip.hidden = true;
  const focusDialog = document.querySelector('#chart-focus');
  const focusBody = document.querySelector('#chart-focus-body');
  let active, index = -1, linked = [], pending, frame = 0;
  let fullscreen, drag, dragged = false, dragFrame = 0, awaitingPin;
  const pinResize = new ResizeObserver(() => { if (activePin(active)) updateGuide(active); });

  function hide() {
    awaitingPin = null;
    pinResize.disconnect();
    active?.querySelector('.chart-cursor')?.classList.remove('is-visible');
    for (const item of linked) item.classList.remove('is-linked');
    linked = [];
    active = null;
    index = -1;
    tooltip.hidden = true;
    pending = null;
  }

  function show(target, title, lines, left, top) {
    const container = target.closest('dialog:modal') ?? document.body;
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
    const panel = container === document.body ? null : container.getBoundingClientRect();
    const sx = panel ? panel.width / container.offsetWidth : 1;
    const sy = panel ? panel.height / container.offsetHeight : 1;
    const localX = (left - (panel?.left ?? 0)) / sx;
    const localY = (top - (panel?.top ?? 0)) / sy;
    const plotTop = target.matches('[data-crosshair]') ? (target.getBoundingClientRect().top - (panel?.top ?? 0)) / sy : 8;
    const above = localY - height - 12;
    const tooltipTop = above < plotTop ? localY + 12 : above;
    tooltip.style.position = panel ? 'absolute' : 'fixed';
    tooltip.style.left = clamp(localX + 10, 8, (panel ? container.clientWidth : innerWidth) - width - 8) + 'px';
    tooltip.style.top = clamp(tooltipTop, 8, (panel ? container.clientHeight : innerHeight) - height - 8) + 'px';
  }

  function selectPoint(svg, next, announce = false) {
    const point = plotPoints(svg)[next];
    if (!point || active === svg && index === next && !announce) return;
    if (active !== svg) hide();
    const area = viewport(svg);
    const x = toView(point.x, area);
    if (area && (x < area.left - 1 || x > area.right + 1)) {
      hide();
      return;
    }
    curveSettlers.get(svg)?.();
    const guide = svg.querySelector('.chart-cursor');
    guide.style.transform = 'translateX(' + x + 'px)';
    guide.querySelectorAll('circle').forEach((dot) => dot.remove());
    const values = point.dots.slice(0, 8).map((dot) => {
      const marker = document.createElementNS(svgNamespace, 'circle');
      marker.setAttribute('cy', dot.getAttribute('cy'));
      marker.setAttribute('r', '4.5');
      marker.style.stroke = dot.parentElement.getAttribute('stroke');
      guide.append(marker);
      return dot.parentElement.dataset.series + ' · ' + dot.dataset.value;
    });
    if (point.dots.length > 8) values.push('Ещё точек: ' + (point.dots.length - 8));
    if (area) {
      linked.forEach(item => item.classList.remove('is-linked'));
      linked = [...area.figure.closest('.workspace')?.querySelectorAll('[data-plot-match]') ?? []]
        .filter(item => item.dataset.plotMatch === point.label);
      linked.forEach(item => item.classList.add('is-linked'));
      if (area.view.pinned === point.key) values.push('Закреплено · Esc для сброса');
    }
    guide.classList.add('is-visible');
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const anchor = new DOMPoint(x, Math.min(...point.dots.map((dot) => +dot.getAttribute('cy')))).matrixTransform(matrix);
    show(svg, point.label, values, anchor.x, anchor.y);
    active = svg;
    index = next;
    if (area?.view.pinned != null) pinResize.observe(svg);
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

  function selectHeat(control) {
    if (active === control) return;
    hide();
    const cell = control.closest('td');
    const table = cell.closest('table');
    linked = [...table.rows].flatMap((row) => row === cell.parentElement
      ? [...row.cells] : [row.cells[cell.cellIndex]].filter(Boolean));
    linked.forEach(item => item.classList.add('is-linked'));
    active = control;
  }

  function showBucket(control) {
    const panel = control.closest('.workspace');
    const svg = panel?.querySelector('.rate-panel svg[data-crosshair]');
    if (!svg) return;
    const area = viewport(svg);
    if (area?.view.pinned !== null) return;
    const point = plotPoints(svg).findIndex(item => item.label === control.dataset.plotMatch);
    if (point >= 0) selectPoint(svg, point);
  }

  function activePin(svg) {
    const area = svg?.matches('[data-crosshair]') ? viewport(svg) : null;
    return area ? area.view.pinned !== null : false;
  }

  function resetHover() {
    if (!activePin(active)) hide();
    else pending = null;
  }

  function pointerIndex(svg, clientX, clientY) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return -1;
    const x = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()).x;
    return nearest(plotPoints(svg), fromView(x, viewport(svg)));
  }

  scope.addEventListener('pointermove', (event) => {
    if (drag) return;
    const chart = event.target.closest('[data-crosshair]');
    const factor = event.target.closest('[data-action="factor"]');
    const heat = event.target.closest('.heat-cell');
    const bucket = event.target.closest('[data-plot-match]');
    if (!chart && !factor && !heat && !bucket) {
      if (active || pending) resetHover();
      return;
    }
    pending = { chart, factor, heat, bucket, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      const { chart, factor, heat, bucket, x, y } = pending;
      if (chart?.isConnected) {
        const view = viewport(chart)?.view;
        const pin = view?.rangeOpen ? null : view?.pinned;
        const next = pin != null ? plotPoints(chart).findIndex(point => point.key === pin) : pointerIndex(chart, x, y);
        selectPoint(chart, next);
      } else if (factor?.isConnected) selectFactor(factor, x, y);
      else if (heat?.isConnected) selectHeat(heat);
      else if (bucket?.isConnected) showBucket(bucket);
    });
  }, { passive: true });
  scope.addEventListener('pointerleave', resetHover);
  scope.addEventListener('focusout', resetHover);
  scope.addEventListener('focusin', (event) => {
    if (!event.target.matches(':focus-visible')) return;
    const factor = event.target.closest('[data-tip-title]');
    const heat = event.target.closest('.heat-cell');
    if (factor) {
      const rect = factor.getBoundingClientRect();
      selectFactor(factor, rect.left + rect.width / 2, rect.top);
    }
    if (heat) selectHeat(heat);
  });

  function updateGuide(svg) {
    const pin = viewport(svg)?.view.pinned;
    const current = pin != null ? plotPoints(svg).findIndex(point => point.key === pin) : active === svg ? index : -1;
    if (current < 0) return;
    index = -1;
    selectPoint(svg, current);
  }

  function restore(container) {
    for (const svg of container.querySelectorAll('[data-crosshair][data-chart-scope]')) {
      if (!scopedViews.has(svg.dataset.chartScope)) continue;
      const { view } = viewport(svg);
      updateViewport(svg);
      if (view.rangeOpen) showPeriod(svg, true);
      const rect = svg.getBoundingClientRect();
      if (view.pinned == null || rect.bottom <= 0 || rect.top >= innerHeight) continue;
      if (svg.hasAttribute('data-morphing')) awaitingPin = svg;
      else updateGuide(svg);
    }
  }

  scope.addEventListener('spectrum-chart-settled', (event) => {
    if (awaitingPin !== event.target) return;
    awaitingPin = null;
    updateGuide(event.target);
  });

  function shift(svg, next) {
    const area = viewport(svg);
    const span = area.right - area.left;
    area.view.offset = clamp(next, 0, span * (1 - 1 / area.view.zoom));
    updateViewport(svg);
    updateGuide(svg);
  }

  function zoom(svg, next) {
    const area = viewport(svg);
    const center = area.left + area.view.offset + (area.right - area.left) / (2 * area.view.zoom);
    area.view.zoom = clamp(next, 1, 8);
    shift(svg, center - area.left - (area.right - area.left) / (2 * area.view.zoom));
  }

  function pin(svg, next) {
    const area = viewport(svg);
    const point = plotPoints(svg)[next];
    if (!area || !point) return;
    area.view.pinned = area.view.pinned === point.key ? null : point.key;
    updateViewport(svg);
    selectPoint(svg, next, true);
  }

  function dateAt(svg, index) {
    return plotPoints(svg)[index]?.date;
  }

  function chooseDate(svg, date) {
    if (!date) return;
    const { view } = viewport(svg);
    const start = view.anchor ?? date;
    view.anchor = view.anchor ? null : date;
    setPeriod(svg, [start, date].sort());
    const message = view.anchor ? 'Начальная точка выбрана. Выберите вторую.' : 'Диапазон выбран.';
    svg.parentElement.querySelector('[data-chart-announcement]').textContent = message;
  }

  scope.addEventListener('pointerdown', (event) => {
    dragged = false;
    const svg = event.target.closest('[data-crosshair]');
    if (!svg || event.button !== 0) return;
    const area = viewport(svg);
    if (area?.view.rangeOpen) {
      const plot = svg.querySelector('[data-plot-hit]').getBoundingClientRect();
      if (event.clientX < plot.left - 2 || event.clientX > plot.right + 2 || event.clientY < plot.top || event.clientY > plot.bottom) return;
      const date = dateAt(svg, pointerIndex(svg, event.clientX, event.clientY));
      if (!date) return;
      event.preventDefault();
      hide();
      svg.setPointerCapture(event.pointerId);
      drag = { svg, pointer: event.pointerId, date, start: event.clientX, original: area.view.dateRange };
      return;
    }
    const matrix = svg.getScreenCTM();
    if (!area || !matrix || area.view.zoom === 1) return;
    drag = { svg, pointer: event.pointerId, start: event.clientX, offset: area.view.offset, scale: matrix.a * area.view.zoom };
  });
  scope.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const distance = event.clientX - drag.start;
    if (!dragged && Math.abs(distance) < 5) return;
    if (!dragged) {
      dragged = true;
      if (!drag.date) {
        drag.svg.setPointerCapture(event.pointerId);
        drag.svg.closest('figure').classList.add('is-panning');
        if (!activePin(drag.svg)) hide();
      }
    }
    drag.pending = { x: event.clientX, y: event.clientY };
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (drag?.svg.isConnected) moveDrag(drag);
    });
  }, { passive: true });

  function moveDrag(gesture) {
    const { svg, pending, date } = gesture;
    if (date) {
      const last = dateAt(svg, pointerIndex(svg, pending.x, pending.y));
      if (last) setPeriod(svg, [date, last].sort());
    } else shift(svg, gesture.offset - (pending.x - gesture.start) / gesture.scale);
  }

  function stopDrag(event) {
    if (drag?.pointer !== event.pointerId) return;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    drag.svg.closest('figure')?.classList.remove('is-panning');
    if (drag.svg.isConnected && event.type === 'pointerup') {
      if (dragged) {
        drag.pending = { x: event.clientX, y: event.clientY };
        moveDrag(drag);
        viewport(drag.svg).view.anchor = null;
      } else if (drag.date) chooseDate(drag.svg, drag.date);
    } else if (drag.date && drag.original && drag.svg.isConnected) setPeriod(drag.svg, drag.original);
    drag = null;
  }
  scope.addEventListener('pointerup', stopDrag);
  scope.addEventListener('pointercancel', stopDrag);
  scope.addEventListener('lostpointercapture', stopDrag);

  function fullscreenChart(button, item) {
    if (!item || fullscreen) return;
    const marker = document.createComment('chart-place');
    const origin = button.getBoundingClientRect();
    const title = item.dataset.chartTitle ?? item.querySelector('svg[aria-label]')?.getAttribute('aria-label') ?? 'График';
    focusDialog.querySelector('h2').textContent = title;
    item.before(marker);
    focusBody.append(item);
    fullscreen = { marker, item, button };
    hide();
    openPanel(focusDialog, origin);
    restore(focusBody);
  }

  focusDialog.addEventListener('close', () => {
    if (!fullscreen || focusDialog.open) return;
    const { marker, item, button } = fullscreen;
    fullscreen = null;
    hide();
    if (marker.isConnected) marker.replaceWith(item);
    focusBody.replaceChildren();
    if (item.isConnected) restore(item);
    if (button.isConnected && !document.querySelector('dialog:modal') && document.activeElement === document.body) {
      button.focus({ preventScroll: true });
    }
  });

  scope.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chart-command]');
    if (button) {
      const command = button.dataset.chartCommand;
      const figure = button.closest('[data-chart-figure]');
      const svg = figure?.querySelector('[data-crosshair]');
      if (command === 'expand') {
        fullscreenChart(button, button.dataset.chartTarget ? document.querySelector(button.dataset.chartTarget) : figure);
      } else if (command === 'in' || command === 'out') {
        zoom(svg, viewport(svg).view.zoom * (command === 'in' ? 1.5 : 1 / 1.5));
      } else if (command === 'reset') {
        viewport(svg).view.pinned = null;
        zoom(svg, 1);
        hide();
      } else if (command === 'period') {
        const view = viewport(svg).view;
        view.anchor = null;
        showPeriod(svg, !view.rangeOpen);
        if (view.rangeOpen) svg.parentElement.focus({ preventScroll: true });
      } else if (command === 'apply-period') {
        const before = figure.querySelector('[data-chart-before]').value;
        const after = figure.querySelector('[data-chart-after]').value;
        const note = figure.querySelector('[data-chart-range-note]');
        note.hidden = before < after;
        if (!note.hidden) {
          note.textContent = 'Начало должно быть раньше конца.';
          return;
        }
        const origin = button.getBoundingClientRect();
        if (focusDialog.open) focusDialog.close();
        document.dispatchEvent(new CustomEvent('spectrum-chart-period', { detail: { before, after, origin } }));
      }
      return;
    }
    const svg = event.target.closest('[data-crosshair]');
    if (svg && !dragged && !viewport(svg)?.view.rangeOpen) pin(svg, pointerIndex(svg, event.clientX, event.clientY));
    dragged = false;
  });

  scope.addEventListener('change', (event) => {
    if (!event.target.matches('[data-chart-before], [data-chart-after]')) return;
    const figure = event.target.closest('[data-chart-figure]');
    const svg = figure.querySelector('[data-crosshair]');
    viewport(svg).view.anchor = null;
    setPeriod(svg, [figure.querySelector('[data-chart-before]').value, figure.querySelector('[data-chart-after]').value]);
  });

  scope.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const svg = event.target.closest('[data-chart-figure]')?.querySelector('[data-crosshair]');
      if (svg && viewport(svg)?.view.rangeOpen) {
        showPeriod(svg, false);
        svg.closest('figure').querySelector('[data-chart-command="period"]').focus({ preventScroll: true });
        event.preventDefault();
      } else if (activePin(svg)) {
        const area = viewport(svg);
        area.view.pinned = null;
        updateViewport(svg);
        event.preventDefault();
      }
      hide();
      return;
    }
    const heat = event.target.closest('.heat-cell');
    const directions = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (heat && directions[event.key]) {
      const [row, column] = directions[event.key];
      const cell = heat.closest('td');
      const rows = cell.closest('tbody').rows;
      const i = cell.parentElement.sectionRowIndex;
      const j = cell.cellIndex;
      for (let distance = 1; distance < rows.length; distance++) {
        const next = rows[i + row * distance]?.cells[j + column * distance]?.querySelector('button');
        if (next) { event.preventDefault(); next.focus(); break; }
      }
      return;
    }
    if (!event.target.matches('.chart-scroll')) return;
    const svg = event.target.querySelector('[data-crosshair]');
    if (!svg) return;
    const area = viewport(svg);
    if (area && ['+', '=', '-', '0', 'Enter'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Enter' && area.view.rangeOpen) chooseDate(svg, dateAt(svg, active === svg ? index : 0));
      else if (event.key === 'Enter') pin(svg, active === svg ? index : 0);
      else zoom(svg, event.key === '0' ? 1 : area.view.zoom * (event.key === '-' ? 1 / 1.5 : 1.5));
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const points = plotPoints(svg);
    if (!points.length) return;
    event.preventDefault();
    const last = points.length - 1;
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const current = active === svg ? index : area?.view.pinned != null
      ? points.findIndex(item => item.key === area.view.pinned) : direction < 0 ? points.length : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : clamp(current + direction, 0, last);
    if (area?.view.pinned != null && !area.view.rangeOpen) area.view.pinned = points[next].key;
    if (area && area.view.zoom > 1) {
      const x = toView(points[next].x, area);
      if (x < area.left || x > area.right) shift(svg, points[next].x - area.left - (area.right - area.left) / (2 * area.view.zoom));
    }
    const scroll = event.target;
    const target = svg.getBoundingClientRect().width * toView(points[next].x, area) / svg.viewBox.baseVal.width;
    if (target < scroll.scrollLeft || target > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = target - scroll.clientWidth / 2;
    selectPoint(svg, next, true);
  });

  document.addEventListener('scroll', (event) => {
    if (active?.matches('[data-crosshair]') && event.target === active.parentElement && document.activeElement === event.target) {
      updateGuide(active);
    } else if (activePin(active) && active.isConnected) {
      const rect = active.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < innerHeight) updateGuide(active);
      else hide();
    } else hide();
  }, { capture: true, passive: true });
  return { hide, restore };
}
