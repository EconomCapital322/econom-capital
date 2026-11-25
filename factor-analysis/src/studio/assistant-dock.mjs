import { openPanel, requestClose } from './motion.mjs';

export function assistantDock(dialog, restoreButton) {
  const root = document.documentElement;
  const desktop = matchMedia('(min-width: 1180px)');
  const widthKey = 'spectrum-assistant-width';
  const minimum = 320;
  let desiredWidth = 376;
  let opener;
  let drag;
  let collapsedScroll;
  let minimizePending = false;
  let frame = 0;
  try { desiredWidth = Number(localStorage.getItem(widthKey)) || desiredWidth; } catch { /* Use the default width. */ }

  const isDocked = () => dialog.dataset.presentation === 'docked';
  const minimized = () => root.dataset.assistant === 'minimized';
  const maximum = () => Math.min(600, Math.max(360, Math.round(innerWidth * .36)));
  const width = () => Math.round(Math.max(minimum, Math.min(maximum(), desiredWidth)));

  function resize() {
    const size = width();
    const cssWidth = size + 'px';
    if (root.style.getPropertyValue('--assistant-width') !== cssWidth) root.style.setProperty('--assistant-width', cssWidth);
    const grip = dialog.querySelector('[data-assistant-resize]');
    if (grip) {
      grip.setAttribute('aria-valuemin', minimum);
      grip.setAttribute('aria-valuemax', maximum());
      grip.setAttribute('aria-valuenow', size);
      grip.setAttribute('aria-valuetext', size + ' пикселей');
    }
  }

  function persistWidth() {
    try { localStorage.setItem(widthKey, String(desiredWidth)); } catch { /* Keep the width for this session. */ }
  }

  function focusPanel() {
    const control = isDocked() ? dialog.querySelector('#question') ?? dialog.querySelector('#assistant-title')
      : dialog.querySelector('.drawer-head form button');
    control?.focus({ preventScroll: true });
  }

  function open(source, focus = true) {
    minimizePending = false;
    if (source?.focus) opener = source;
    const presentation = desktop.matches ? 'docked' : 'modal';
    const needsOpen = !dialog.open || dialog.dataset.presentation !== presentation;
    if (needsOpen) {
      const body = dialog.querySelector('.drawer-body');
      const scroll = collapsedScroll?.body === body ? collapsedScroll?.top : body?.scrollTop;
      const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
      if (dialog.open) dialog.close();
      dialog.dataset.presentation = presentation;
      root.dataset.assistant = presentation;
      restoreButton.hidden = true;
      resize();
      openPanel(dialog, source, { modal: !isDocked() });
      if (body && scroll) body.scrollTop = scroll;
      collapsedScroll = null;
      if (focused) focused.focus({ preventScroll: true });
      else if (focus) focusPanel();
    } else if (focus) {
      openPanel(dialog, source, { modal: !isDocked() });
      focusPanel();
    }
  }

  function minimize() {
    if (!dialog.open || !isDocked() || dialog.hasAttribute('data-closing')) return;
    const body = dialog.querySelector('.drawer-body');
    collapsedScroll = { body, top: body?.scrollTop };
    minimizePending = true;
    requestClose(dialog, 'minimized');
  }

  function clearDrag(event) {
    if (drag?.pointer !== event.pointerId) return;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    drag = null;
    resize();
    persistWidth();
    delete root.dataset.assistantResizing;
  }

  dialog.addEventListener('pointerdown', (event) => {
    const grip = event.target.closest('[data-assistant-resize]');
    if (!isDocked() || !grip || event.button !== 0) return;
    grip.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, start: event.clientX, width: width() };
    root.dataset.assistantResizing = '';
  });
  dialog.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    desiredWidth = drag.width + drag.start - event.clientX;
    desiredWidth = width();
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; resize(); });
  });
  dialog.addEventListener('lostpointercapture', clearDrag);
  dialog.addEventListener('pointerup', clearDrag);
  dialog.addEventListener('pointercancel', clearDrag);
  dialog.addEventListener('keydown', (event) => {
    if (!isDocked() || event.defaultPrevented) return;
    if (!event.target.matches('[data-assistant-resize]')) return;
    const next = { ArrowLeft: width() + 24, ArrowRight: width() - 24, Home: minimum, End: maximum() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    root.dataset.assistantResizing = '';
    desiredWidth = next;
    desiredWidth = width();
    resize();
    persistWidth();
    requestAnimationFrame(() => { if (!drag) delete root.dataset.assistantResizing; });
  });

  dialog.addEventListener('close', () => {
    if (dialog.open || minimized()) return;
    if (minimizePending && dialog.returnValue === 'minimized') {
      minimizePending = false;
      root.dataset.assistant = 'minimized';
      restoreButton.hidden = false;
      restoreButton.focus({ preventScroll: true });
      return;
    }
    minimizePending = false;
    delete root.dataset.assistant;
    if (document.activeElement === document.body && opener?.isConnected && !opener.closest('[hidden]')) {
      opener.focus({ preventScroll: true });
    }
  });
  desktop.addEventListener('change', () => { if (dialog.open) open(null, false); });
  window.addEventListener('resize', resize, { passive: true });
  return { open, minimize, minimized, isDocked, resize };
}
