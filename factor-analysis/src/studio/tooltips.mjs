/** Delegated hints share the app's theme and also work inside the curves shadow root. */
export function installTooltips(scope) {
  const tip = document.createElement('div');
  tip.id = 'ui-hint';
  tip.className = 'ui-tooltip';
  tip.role = 'tooltip';
  tip.hidden = true;
  document.body.append(tip);
  let active = null;
  let shadowDescription = null;
  const owner = event => event.composedPath().find(node => node instanceof Element &&
    (node.hasAttribute('title') || node.hasAttribute('data-tooltip')));

  function hide() {
    if (active && active.getRootNode() instanceof ShadowRoot) {
      if (shadowDescription === null) active.removeAttribute('aria-description');
      else active.setAttribute('aria-description', shadowDescription);
    }
    if (active) {
      const ids = (active.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tip.id);
      if (ids.length) active.setAttribute('aria-describedby', ids.join(' '));
      else active.removeAttribute('aria-describedby');
    }
    active = null;
    tip.hidden = true;
  }
  function show(target) {
    const text = target?.getAttribute('title') ?? target?.getAttribute('data-tooltip');
    if (!text?.trim()) return;
    hide();
    // Suppress the browser tooltip before its hover delay starts.
    target.dataset.tooltip = text;
    target.removeAttribute('title');
    active = target;
    tip.textContent = text;
    tip.hidden = false;
    const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (target.getRootNode() instanceof ShadowRoot) {
      shadowDescription = target.getAttribute('aria-description');
      target.setAttribute('aria-description', text);
    } else target.setAttribute('aria-describedby', [...new Set([...ids, tip.id])].join(' '));
    const box = target.getBoundingClientRect(), size = tip.getBoundingClientRect();
    const below = box.bottom + 8;
    const top = below + size.height <= innerHeight - 12 ? below : Math.max(12, box.top - size.height - 8);
    const left = Math.max(12, Math.min(innerWidth - size.width - 12, box.left + (box.width - size.width) / 2));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  scope.addEventListener('pointerover', event => { if (event.pointerType !== 'touch') show(owner(event)); });
  scope.addEventListener('pointerout', event => {
    if (active && !(event.relatedTarget instanceof Node && active.contains(event.relatedTarget))) hide();
  });
  scope.addEventListener('focusin', event => show(owner(event)));
  scope.addEventListener('focusout', hide);
  scope.addEventListener('pointerdown', hide);
  scope.addEventListener('click', hide);
  scope.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  scope.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  new MutationObserver(() => { if (active && !active.isConnected) hide(); })
    .observe(document.body, { childList: true, subtree: true });
}
