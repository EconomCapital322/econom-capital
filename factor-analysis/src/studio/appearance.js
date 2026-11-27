(() => {
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const storageKey = 'spectrum-appearance';
  const choices = {
    theme: ['system', 'light', 'dark'], motion: ['full', 'reduced'], density: ['comfortable', 'compact'],
  };
  const system = {
    dark: matchMedia('(prefers-color-scheme: dark)'),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)'),
  };
  let preferences;
  function read(value) {
    let saved;
    try { saved = JSON.parse(value); } catch { /* Ignore invalid saved preferences. */ }
    return Object.fromEntries(Object.entries(choices).map(([key, allowed]) =>
      [key, allowed.includes(saved?.[key]) ? saved[key] : allowed[0]]));
  }
  function apply() {
    const theme = preferences.theme === 'system' ? (system.dark.matches ? 'dark' : 'light') : preferences.theme;
    root.dataset.theme = theme;
    root.dataset.transparency = 'reduced';
    root.dataset.motion = system.reducedMotion.matches ? 'reduced' : preferences.motion;
    root.dataset.sidebar = 'expanded';
    root.dataset.density = preferences.density;
    root.dataset.optics = 'standard';
    themeColor.content = theme === 'dark' ? '#14151c' : '#ffffff';
    const button = document.querySelector('[data-action="toggle-theme"]');
    if (button) {
      const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
      button.setAttribute('aria-label', label);
      button.dataset.tooltip = label;
    }
  }
  function select(key, value) {
    if (!choices[key]?.includes(value)) return;
    preferences[key] = value;
    apply();
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Keep the choice in this tab. */ }
  }
  try { preferences = read(localStorage.getItem(storageKey)); } catch { preferences = read(null); }
  apply();
  for (const media of Object.values(system)) media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    requestAnimationFrame(() => { root.dataset.interactive = ''; });
  }, { once: true });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-action="toggle-theme"]')) select('theme', root.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('spectrum-appearance', ({ detail }) => select(detail?.key, detail?.value));
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    preferences = read(event.newValue);
    apply();
  });
})();
