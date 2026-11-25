const root = document.documentElement;
const animations = new WeakMap();
const trajectories = new WeakMap();
const origins = new WeakMap();
const closing = new WeakMap();

export const motionAllowed = () => root.dataset.motion !== 'reduced' && !document.hidden;

const settings = {
  indicator: { duration: 290, damping: .78, frequency: 10.4 },
  panel: { duration: 340, damping: .9, frequency: 9.2 },
  dismissal: { duration: 185, damping: .92, frequency: 8.3 },
  content: { duration: 215, damping: .96, frequency: 9.6 },
};

function response(time, { damping, frequency }) {
  const rate = frequency * Math.sqrt(1 - damping ** 2);
  return 1 - Math.exp(-damping * frequency * time) *
    (Math.cos(rate * time) + damping * frequency / rate * Math.sin(rate * time));
}

function play(element, frames, options) {
  animations.get(element)?.cancel();
  if (!motionAllowed() || !element.animate) return null;
  const animation = element.animate(frames, options);
  animations.set(element, animation);
  const forget = () => { if (animations.get(element) === animation) animations.delete(element); };
  animation.finished.then(forget, forget);
  return animation;
}

function spring(element, kind, frame) {
  if (!motionAllowed() || !element.animate) return null;
  const profile = settings[kind];
  const end = response(1, profile);
  const frames = Array.from({ length: 25 }, (_, index) => {
    const time = index / 24;
    const progress = response(time, profile) / end;
    return { ...frame(progress, time), offset: time };
  });
  return play(element, frames, { duration: profile.duration });
}

function velocityOf(element) {
  const path = trajectories.get(element);
  if (!path || animations.get(element) !== path.animation || !Number.isFinite(path.animation.currentTime)) return {};
  const time = path.animation.currentTime;
  const first = Math.max(0, time - 4);
  const last = Math.min(path.duration, time + 4);
  if (last <= first) return {};
  const before = path.sample(first / path.duration);
  const after = path.sample(last / path.duration);
  return Object.fromEntries(Object.keys(before).map(key => [key, (after[key] - before[key]) / (last - first)]));
}

function move(element, kind, from, to, render, velocity = velocityOf(element)) {
  const { duration, damping, frequency } = settings[kind];
  const decay = damping * frequency;
  const rate = frequency * Math.sqrt(1 - damping ** 2);
  const axes = Object.keys(from).map(key => {
    const distance = from[key] - to[key];
    const momentum = (velocity[key] ?? 0) * duration;
    return { key, distance, oscillation: (momentum + decay * distance) / rate };
  });
  const sample = time => {
    const cap = Math.max(0, (time - .82) / .18);
    const finish = 1 - cap * cap * (3 - 2 * cap);
    const amplitude = Math.exp(-decay * time) * finish;
    const cos = Math.cos(rate * time), sin = Math.sin(rate * time);
    return Object.fromEntries(axes.map(({ key, distance, oscillation }) =>
      [key, to[key] + amplitude * (distance * cos + oscillation * sin)]));
  };
  const frames = Array.from({ length: 25 }, (_, step) => render(step === 24 ? to : sample(step / 24)));
  const animation = play(element, frames, { duration, fill: kind === 'dismissal' ? 'forwards' : 'none' });
  if (animation) trajectories.set(element, { animation, duration, sample });
  return animation;
}

const activeSelector = ':is([aria-current="page"], [aria-pressed="true"])';

export function captureIndicators(scope) {
  return new Map([...scope.querySelectorAll('[data-motion-track][data-indicator-ready]')]
    .map((track) => {
      const pill = track.firstElementChild;
      return [track.dataset.motionTrack, { rect: pill.getBoundingClientRect(), velocity: velocityOf(pill) }];
    }));
}

export function syncIndicators(scope, previous = new Map(), animate = true) {
  for (const track of scope.querySelectorAll('[data-motion-track]')) {
    const active = track.querySelector(activeSelector);
    if (!active || !active.offsetWidth) continue;
    const pill = track.firstElementChild;
    const snapshot = previous.get(track.dataset.motionTrack);
    const from = snapshot?.rect ??
      (track.hasAttribute('data-indicator-ready') ? pill.getBoundingClientRect() : null);
    const width = active.offsetWidth;
    const height = active.offsetHeight;
    const x = active.offsetLeft;
    const y = active.offsetTop;
    const transform = `translate(${x}px, ${y}px)`;
    const geometry = `${x}:${y}:${width}:${height}`;
    if (pill.dataset.geometry === geometry && !previous.has(track.dataset.motionTrack)) continue;
    const velocity = snapshot?.velocity ?? velocityOf(pill);
    animations.get(pill)?.cancel();
    Object.assign(pill.style, { width: `${width}px`, height: `${height}px`, transform });
    track.dataset.indicatorReady = '';
    pill.dataset.geometry = geometry;
    if (!animate || !from || !from.width || !motionAllowed()) continue;
    const to = pill.getBoundingClientRect();
    const dx = (from.left - to.left) * width / (to.width || width);
    const dy = (from.top - to.top) * height / (to.height || height);
    const w = from.width * width / (to.width || width);
    const h = from.height * height / (to.height || height);
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(w - width) + Math.abs(h - height) < 1) continue;
    move(pill, 'indicator', { x: x + dx, y: y + dy, w, h }, { x, y, w: width, h: height },
      pose => ({ transform: `translate(${pose.x}px, ${pose.y}px) scale(${Math.max(.1, pose.w / width)}, ${Math.max(.1, pose.h / height)})` }), velocity);
  }
}

export function animateContent(element) {
  spring(element, 'content', (progress) => ({ transform: `translateY(${4 * (1 - progress)}px)`, opacity: Math.min(1, .62 + .38 * progress) }));
}

export function panelOrigin(element) {
  return element?.getBoundingClientRect?.() ?? null;
}

function panelPose(dialog) {
  const { transform, opacity } = getComputedStyle(dialog);
  const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
  return { x: matrix.e, y: matrix.f, sx: matrix.a, sy: matrix.d, opacity: Number(opacity) };
}

function panelTransform(dialog, source, pose = restingPanel) {
  if (!source?.width || !source.height) return { x: 0, y: 10, sx: .98, sy: .98 };
  const rect = dialog.getBoundingClientRect();
  const width = dialog.offsetWidth, height = dialog.offsetHeight;
  const left = rect.left - pose.x - width * (1 - pose.sx) / 2;
  const top = rect.top - pose.y - height * (1 - pose.sy) / 2;
  const sx = Math.max(.62, Math.min(.98, source.width / width));
  const sy = Math.max(.76, Math.min(.98, source.height / height));
  const insetX = width * (1 - sx) / 2;
  const insetY = height * (1 - sy) / 2;
  const clamp = (distance, min, max) => Math.max(min, Math.min(max, distance));
  return {
    x: clamp(source.left + source.width / 2 - left - width / 2, -left - insetX, innerWidth - left - width + insetX),
    y: clamp(source.top + source.height / 2 - top - height / 2, -top - insetY, innerHeight - top - height + insetY),
    sx, sy,
  };
}

const restingPanel = { x: 0, y: 0, sx: 1, sy: 1, opacity: 1 };
const panelFrame = ({ x, y, sx, sy, opacity }) => ({
  transform: `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`,
  opacity: Math.max(0, Math.min(1, opacity)),
});

export function openPanel(dialog, source = document.activeElement, { modal = true } = {}) {
  if (dialog.open) {
    if (closing.has(dialog)) {
      closing.delete(dialog);
      delete dialog.dataset.closing;
      move(dialog, 'panel', panelPose(dialog), restingPanel, panelFrame);
    }
    return;
  }
  const origin = source?.getBoundingClientRect ? panelOrigin(source) : source;
  origins.set(dialog, origin);
  if (modal) dialog.showModal();
  else dialog.show();
  if (!motionAllowed()) return;
  const geometry = panelTransform(dialog, origin);
  const start = modal ? { ...geometry, opacity: .32 }
    : { x: Math.max(-32, Math.min(0, geometry.x)), y: 0, sx: .96, sy: .99, opacity: .72 };
  move(dialog, 'panel', start, restingPanel, panelFrame, {});
}

export function requestClose(dialog, value) {
  if (!dialog.open || closing.has(dialog)) return;
  if (!motionAllowed() || !dialog.animate) {
    dialog.close(value);
    return;
  }
  dialog.dataset.closing = '';
  const start = panelPose(dialog);
  const target = panelTransform(dialog, origins.get(dialog), start);
  const end = { x: target.x * .43, y: target.y * .43, sx: 1 + (target.sx - 1) * .43, sy: 1 + (target.sy - 1) * .43, opacity: .06 };
  const animation = move(dialog, 'dismissal', start, end, panelFrame);
  closing.set(dialog, animation);
  animation.finished.then(() => {
    if (closing.get(dialog) !== animation) return;
    closing.delete(dialog);
    animation.cancel();
    if (dialog.open) dialog.close(value);
  }, () => {
    if (closing.get(dialog) !== animation) return;
    closing.delete(dialog);
    delete dialog.dataset.closing;
  });
}

export function installPanels() {
  const dialogs = [...document.querySelectorAll('dialog')];
  function fitViewport() {
    const viewport = window.visualViewport;
    const height = viewport?.scale === 1 ? Math.min(innerHeight, viewport.height) : innerHeight;
    root.style.setProperty('--panel-viewport', Math.floor(height) + 'px');
  }
  window.addEventListener('resize', fitViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', fitViewport, { passive: true });
  fitViewport();
  for (const dialog of dialogs) {
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || dialog.matches(':modal')) return;
      event.preventDefault();
      requestClose(dialog);
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      requestClose(dialog);
    });
    dialog.addEventListener('submit', (event) => {
      if (event.target.method !== 'dialog') return;
      event.preventDefault();
      requestClose(dialog, event.submitter?.value);
    });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      animations.get(dialog)?.cancel();
      closing.delete(dialog);
      delete dialog.dataset.closing;
    });
  }
}

let viewTransition;
let viewRevision = 0;
export function settleChartTransition() {
  viewRevision++;
  viewTransition?.skipTransition();
}

export function transitionChart(element, update) {
  const revision = ++viewRevision;
  viewTransition?.skipTransition();
  if (!element || !motionAllowed() || !element.startViewTransition) {
    update();
    if (motionAllowed()) {
      const shape = element?.querySelector('.waterfall-frame, .contribution-chart');
      if (shape) play(shape, [{ opacity: .86 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
    }
    return;
  }
  const transition = element.startViewTransition(() => { if (revision === viewRevision) update(); });
  viewTransition = transition;
  const clear = () => {
    if (viewTransition !== transition) return;
    viewTransition = null;
  };
  transition.updateCallbackDone.catch(() => {});
  transition.finished.then(clear, clear);
}

export function installLighting() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let frame = 0;
  let pointer;
  document.addEventListener('pointermove', (event) => {
    const surface = event.target.closest?.('[data-light], .button.primary, .workspace-nav, .segmented, .assistant-button, .chart-expand');
    const control = surface?.querySelector(':scope > .selection-pill') ?? surface;
    if (!control || root.dataset.transparency === 'reduced' || !motionAllowed()) return;
    pointer = { control, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const { control, x, y } = pointer;
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const percent = value => Math.round(Math.max(0, Math.min(100, value * 100))) + '%';
      control.style.setProperty('--light-x', percent((x - rect.left) / rect.width));
      control.style.setProperty('--light-y', percent((y - rect.top) / rect.height));
    });
  }, { passive: true });
}

new MutationObserver(() => {
  if (motionAllowed()) return;
  viewTransition?.skipTransition();
  for (const animation of document.getAnimations()) animations.get(animation.effect?.target)?.finish();
}).observe(root, { attributeFilter: ['data-motion'] });
