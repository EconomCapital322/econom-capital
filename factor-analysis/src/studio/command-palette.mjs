import { openPanel, requestClose } from './motion.mjs';

export function commandPalette(dialog, available) {
  const search = dialog.querySelector('input');
  const list = dialog.querySelector('[role="listbox"]');
  const empty = dialog.querySelector('#command-empty');
  let commands = [];
  let matches = [];
  let selected = -1;
  const normalize = (value) => value.toLowerCase().replaceAll('ё', 'е');

  function select(index, scroll = false) {
    selected = index;
    for (const [position, item] of [...list.children].entries()) {
      item.setAttribute('aria-selected', String(position === index));
    }
    const item = list.children[index];
    if (item) {
      search.setAttribute('aria-activedescendant', item.id);
      if (scroll) item.scrollIntoView({ block: 'nearest' });
    } else {
      search.removeAttribute('aria-activedescendant');
    }
  }

  function filter() {
    const words = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
    matches = commands.filter(({ title, group, keywords = '' }) =>
      words.every((word) => normalize(title + ' ' + group + ' ' + keywords).includes(word)));
    list.replaceChildren(...matches.map(({ title, group }, index) => {
      const option = document.createElement('div');
      const label = document.createElement('span');
      const category = document.createElement('small');
      option.id = 'command-option-' + index;
      option.dataset.command = index;
      option.setAttribute('role', 'option');
      label.textContent = title;
      category.textContent = group;
      option.append(label, category);
      return option;
    }));
    empty.hidden = matches.length > 0;
    list.hidden = !matches.length;
    search.setAttribute('aria-expanded', String(matches.length > 0));
    list.scrollTop = 0;
    select(matches.length ? 0 : -1);
  }

  function run(index) {
    const command = matches[index];
    if (!command) return;
    dialog.close();
    command.run();
  }

  function open(source = document.activeElement) {
    if (dialog.open && dialog.hasAttribute('data-closing')) {
      openPanel(dialog, source);
      search.focus({ preventScroll: true });
      return;
    }
    if (dialog.open) { requestClose(dialog); return; }
    commands = available(source);
    search.value = '';
    filter();
    openPanel(dialog, source);
    search.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (event) => {
    if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || event.code !== 'KeyK' && event.key.toLowerCase() !== 'k') return;
    if (document.querySelector('dialog:modal:not(#command-palette)')) return;
    event.preventDefault();
    if (!event.repeat) open();
  });
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose(dialog);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(selected);
    } else if (matches.length && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      select((selected + direction + matches.length) % matches.length, true);
    }
  });
  list.addEventListener('pointermove', (event) => {
    const item = event.target.closest('[data-command]');
    if (item && Number(item.dataset.command) !== selected) select(Number(item.dataset.command));
  });
  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-command]');
    if (item) run(Number(item.dataset.command));
  });
  return open;
}
