(() => {
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const storageKey = 'spectrum-appearance';
  const choices = {
    theme: ['system', 'light', 'dark'], transparency: ['full', 'reduced'],
    motion: ['full', 'reduced'], sidebar: ['expanded', 'collapsed'],
    density: ['comfortable', 'compact'], optics: ['standard', 'enhanced'],
  };
  const system = {
    dark: matchMedia('(prefers-color-scheme: dark)'),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)'),
    reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)'),
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
    root.dataset.transparency = system.reducedTransparency.matches ? 'reduced' : preferences.transparency;
    root.dataset.motion = system.reducedMotion.matches ? 'reduced' : preferences.motion;
    root.dataset.sidebar = preferences.sidebar;
    root.dataset.density = preferences.density;
    root.dataset.optics = preferences.optics;
    themeColor.content = theme === 'dark' ? '#14151c' : '#f3f4f8';
  }

  try { preferences = read(localStorage.getItem(storageKey)); } catch { preferences = read(null); }
  apply();
  for (const media of Object.values(system)) media.addEventListener('change', apply);

  document.addEventListener('DOMContentLoaded', () => {
    const controls = [...document.querySelectorAll('[data-preference]')];
    const toggle = document.querySelector('#rail-toggle');
    function syncControls() {
      for (const control of controls) control.value = preferences[control.dataset.preference];
      const expanded = preferences.sidebar === 'expanded';
      const title = expanded ? 'Свернуть меню' : 'Развернуть меню';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', title);
      toggle.title = title;
    }
    function save() {
      apply();
      syncControls();
      try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* This tab keeps the preference. */ }
    }
    function select(key, value) {
      if (!choices[key]?.includes(value)) return;
      preferences[key] = value;
      save();
    }
    for (const control of controls) control.addEventListener('change', () => {
      select(control.dataset.preference, control.value);
    });
    document.addEventListener('spectrum-appearance', ({ detail }) => select(detail.key, detail.value));
    toggle.addEventListener('click', () => {
      preferences.sidebar = preferences.sidebar === 'expanded' ? 'collapsed' : 'expanded';
      save();
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== storageKey) return;
      preferences = read(event.newValue);
      apply();
      syncControls();
    });
    syncControls();
    requestAnimationFrame(() => { root.dataset.interactive = ''; });
  }, { once: true });
})();
