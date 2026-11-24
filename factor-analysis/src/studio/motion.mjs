const root = document.documentElement;
const animations = new WeakMap();
const origins = new WeakMap();
const closing = new WeakSet();

export const motionAllowed = () => root.dataset.motion !== 'reduced' && !document.hidden;

const settings = {
  indicator: { duration: 290, damping: .78, frequency: 10.4 },
  panel: { duration: 340, damping: .9, frequency: 9.2 },
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
  const frames = Array.from({ length: 19 }, (_, index) => {
    const time = index / 18;
    return { ...frame(response(time, profile) / end, time), offset: time };
  });
  return play(element, frames, { duration: profile.duration });
}

const activeSelector = ':is([aria-current="page"], [aria-pressed="true"])';

export function captureIndicators(scope) {
  return new Map([...scope.querySelectorAll('[data-motion-track][data-indicator-ready]')]
    .map((track) => [track.dataset.motionTrack, track.firstElementChild.getBoundingClientRect()]));
}

export function syncIndicators(scope, previous = new Map(), animate = true) {
  for (const track of scope.querySelectorAll('[data-motion-track]')) {
    const active = track.querySelector(activeSelector);
    if (!active || !active.offsetWidth) continue;
    const pill = track.firstElementChild;
    const from = previous.get(track.dataset.motionTrack) ??
      (track.hasAttribute('data-indicator-ready') ? pill.getBoundingClientRect() : null);
    const width = active.offsetWidth;
    const height = active.offsetHeight;
    const x = active.offsetLeft;
    const y = active.offsetTop;
    const transform = `translate(${x}px, ${y}px)`;
    const geometry = `${x}:${y}:${width}:${height}`;
    if (pill.dataset.geometry === geometry && !previous.has(track.dataset.motionTrack)) continue;
    animations.get(pill)?.cancel();
    Object.assign(pill.style, { width: `${width}px`, height: `${height}px`, transform });
    track.dataset.indicatorReady = '';
    pill.dataset.geometry = geometry;
    if (!animate || !from || !from.width || !motionAllowed()) continue;
    const to = pill.getBoundingClientRect();
    const dx = (from.left - to.left) * width / (to.width || width);
    const dy = (from.top - to.top) * height / (to.height || height);
    const sx = from.width / (to.width || width) - 1;
    const sy = from.height / (to.height || height) - 1;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(sx) + Math.abs(sy) < 1) continue;
    spring(pill, 'indicator', (progress, time) => {
      const rem = 1 - progress;
      const stretch = Math.sin(Math.PI * time) * Math.max(0, rem) * .1;
      return { transform: `translate(${x + dx * rem}px, ${y + dy * rem}px) scale(${1 + sx * rem + (Math.abs(dx) >= Math.abs(dy) ? stretch : 0)}, ${1 + sy * rem + (Math.abs(dx) < Math.abs(dy) ? stretch : 0)})` };
    });
  }
}

export function animateContent(element) {
  spring(element, 'content', (progress) => ({ transform: `translateY(${4 * (1 - progress)}px)`, opacity: Math.min(1, .62 + .38 * progress) }));
}

export function panelOrigin(element) {
  return element?.getBoundingClientRect?.() ?? null;
}

function panelTransform(dialog, source) {
  if (!source?.width || !source.height) return { x: 0, y: 10, sx: .98, sy: .98 };
  const panel = dialog.getBoundingClientRect();
  const sx = Math.max(.62, Math.min(.98, source.width / panel.width));
  const sy = Math.max(.76, Math.min(.98, source.height / panel.height));
  const insetX = panel.width * (1 - sx) / 2;
  const insetY = panel.height * (1 - sy) / 2;
  const clamp = (distance, min, max) => Math.max(min, Math.min(max, distance));
  return {
    x: clamp(source.left + source.width / 2 - panel.left - panel.width / 2, -panel.left - insetX, innerWidth - panel.right + insetX),
    y: clamp(source.top + source.height / 2 - panel.top - panel.height / 2, -panel.top - insetY, innerHeight - panel.bottom + insetY),
    sx, sy,
  };
}

const panelFrame = ({ x, y, sx, sy }, rem) =>
  `translate3d(${x * rem}px, ${y * rem}px, 0) scale(${1 + (sx - 1) * rem}, ${1 + (sy - 1) * rem})`;

export function openPanel(dialog, source = document.activeElement) {
  if (dialog.open) return;
  const origin = source?.getBoundingClientRect ? panelOrigin(source) : source;
  origins.set(dialog, origin);
  dialog.showModal();
  if (!motionAllowed()) return;
  const state = panelTransform(dialog, origin);
  spring(dialog, 'panel', (progress) => ({ transform: panelFrame(state, 1 - progress), opacity: Math.min(1, .32 + progress) }));
}

function requestClose(dialog, value) {
  if (!dialog.open || closing.has(dialog)) return;
  if (!motionAllowed() || !dialog.animate) {
    dialog.close(value);
    return;
  }
  closing.add(dialog);
  dialog.dataset.closing = '';
  const current = getComputedStyle(dialog);
  const start = { transform: current.transform, opacity: current.opacity };
  animations.get(dialog)?.cancel();
  const target = panelTransform(dialog, origins.get(dialog));
  const animation = play(dialog, [start, { transform: panelFrame(target, .43), opacity: .08 }], { duration: 155, easing: 'cubic-bezier(.43,0,.76,.32)', fill: 'forwards' });
  animation.finished.then(() => {
    animation.cancel();
    closing.delete(dialog);
    if (dialog.open) dialog.close(value);
  }, () => {
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
    for (const dialog of dialogs) {
      const animation = animations.get(dialog);
      if (dialog.open && animation?.playState === 'running') animation.finish();
    }
  }
  window.addEventListener('resize', fitViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', fitViewport, { passive: true });
  fitViewport();
  for (const dialog of dialogs) {
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
export function transitionChart(element, update) {
  const revision = ++viewRevision;
  viewTransition?.skipTransition();
  if (!motionAllowed() || !document.startViewTransition) {
    update();
    if (motionAllowed()) animateContent(element);
    return;
  }
  element.style.viewTransitionName = 'chart-switch';
  const transition = document.startViewTransition(() => { if (revision === viewRevision) update(); });
  viewTransition = transition;
  const clear = () => {
    if (viewTransition !== transition) return;
    viewTransition = null;
    element.style.viewTransitionName = '';
  };
  transition.finished.then(clear, clear);
}

export function installLighting() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let frame = 0;
  let pointer;
  document.addEventListener('pointermove', (event) => {
    const control = event.target.closest?.('[data-light], .button.primary');
    if (!control || root.dataset.transparency === 'reduced' || !motionAllowed()) return;
    pointer = { control, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const { control, x, y } = pointer;
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      control.style.setProperty('--light-x', Math.round((x - rect.left) / rect.width * 100) + '%');
      control.style.setProperty('--light-y', Math.round((y - rect.top) / rect.height * 100) + '%');
    });
  }, { passive: true });
}

new MutationObserver(() => {
  if (motionAllowed()) return;
  viewTransition?.skipTransition();
  for (const animation of document.getAnimations()) animations.get(animation.effect?.target)?.finish();
}).observe(root, { attributeFilter: ['data-motion'] });
