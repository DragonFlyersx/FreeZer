'use strict';

const state = {
  meta: { categories: [], units: [], locations: [], soon_days: 21, today: '' },
  today: new Date().toISOString().slice(0, 10),
  items: [],
  tab: 'active',
  search: '',
  takingId: null,   // item whose inline "take" row is open
  editingId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Noget gik galt (${res.status})`);
  return data;
}

const fmtNum = (n) => (Math.round(n * 100) / 100).toString();

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('da-DK', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

const parseIso = (iso) => new Date(iso + 'T00:00:00');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Add whole months, clamping to the last valid day (31 Jan + 1 = 28 Feb). */
function addMonths(d, months) {
  const target = d.getMonth() + months;
  const year = d.getFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(d.getDate(), lastDay));
}

/**
 * Whole calendar months from `from` to `to`. Counting real months matters:
 * three months is 89-92 days depending on which ones, so dividing days by an
 * average month length rounds a genuine 3-month span down to 2.
 */
function monthsBetween(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12
             + (to.getMonth() - from.getMonth());
  if (addMonths(from, months) > to) months -= 1;
  return Math.max(0, months);
}

/** Human-readable span between two ISO dates, `from` no later than `to`. */
function fmtSpan(fromIso, toIso) {
  const from = parseIso(fromIso);
  const to = parseIso(toIso);
  const months = monthsBetween(from, to);
  // Days below one calendar month, so a month reads the same in February
  // (28 days) as in March (31) instead of flipping between units.
  if (months < 1) return plural(Math.round((to - from) / 86400000), 'dag', 'dage');
  if (months < 12) return plural(months, 'måned', 'måneder');
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} år ${rest} md.` : plural(years, 'år', 'år');
}

function conditionLabel(item) {
  if (item.state === 'unknown') return 'Ingen dato';
  if (item.days_left === 0) return 'Bedst før i dag';
  if (item.state === 'expired') return `${fmtSpan(item.best_before, state.today)} over bedst før`;
  return `${fmtSpan(state.today, item.best_before)} tilbage`;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function fillSelect(select, options, { placeholder } = {}) {
  select.innerHTML = '';
  if (placeholder) select.append(new Option(placeholder, ''));
  for (const opt of options) select.append(new Option(opt.label, opt.value));
}

const categoryOptions = () =>
  state.meta.categories.map((c) => ({ value: c.name, label: `${c.name}, holder ca. ${c.months} md.` }));
const locationOptions = () =>
  state.meta.locations.map((l) => ({ value: String(l.id), label: l.name }));
const unitOptions = () => state.meta.units.map((u) => ({ value: u, label: u }));

// -------------------------------------------------------------------- render

function visibleItems() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.tab === 'active' ? item.status !== 'active' : item.status === 'active') return false;
    if (q) {
      const hay = `${item.name} ${item.category} ${item.notes} ${item.location || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderStats() {
  const active = state.items.filter((i) => i.status === 'active').length;
  $('#stats').textContent = active
    ? `Der er ${plural(active, 'ting', 'ting')} i fryseren.`
    : 'Fryseren er tom.';
}

function statusText(item) {
  if (item.status === 'used') return `Brugt op ${fmtDate(item.closed_at?.slice(0, 10))}`;
  if (item.status === 'discarded') return `Smidt ud ${fmtDate(item.closed_at?.slice(0, 10))}`;
  if (!item.best_before) return conditionLabel(item);
  if (item.state === 'expired') return `Over bedst før siden ${fmtDate(item.best_before)}`;
  return `Bedst før ${fmtDate(item.best_before)} (${conditionLabel(item).toLowerCase()})`;
}

function cardHtml(item) {
  const closed = item.status !== 'active';
  const frozen = item.frozen_on === state.today ? 'frosset i dag'
    : `frosset ${fmtDate(item.frozen_on)}`;

  const actions = closed
    ? `<button class="primary" data-act="restore">Læg tilbage i fryseren</button>
       <button class="link" data-act="edit">Ret</button>`
    : `<button class="primary" data-act="take">Tag ud</button>
       <button class="secondary" data-act="allgone">Brugt op</button>
       <button class="secondary" data-act="discard">Smidt ud</button>
       <button class="link" data-act="edit">Ret</button>`;

  const takeRow = state.takingId === item.id
    ? `<form class="take-row" data-act="take-submit">
         <div class="stepper">
           <button type="button" data-step="-1" aria-label="Færre">−</button>
           <input type="number" name="amount" inputmode="decimal" step="any" min="0.01"
                  max="${item.amount}" value="${fmtNum(Math.min(1, item.amount))}" aria-label="Hvor mange">
           <button type="button" data-step="1" aria-label="Flere">+</button>
         </div>
         <span class="of">af ${fmtNum(item.amount)} ${escapeHtml(item.unit)}</span>
         <button class="primary" type="submit">Tag ud</button>
         <button class="secondary" type="button" data-act="take-cancel">Annuller</button>
       </form>`
    : '';

  return `<article class="card ${closed ? 'closed' : item.state}" data-id="${item.id}">
    <div class="card-title">
      <h3>${escapeHtml(item.name)}</h3>
      ${closed ? '' : `<span class="qty">${fmtNum(item.amount)} ${escapeHtml(item.unit)}</span>`}
    </div>
    <p class="status ${closed ? 'closed' : item.state}">${statusText(item)}</p>
    <p class="where">${escapeHtml(item.location || 'Uden plads')}, ${frozen}</p>
    ${item.notes ? `<p class="note">${escapeHtml(item.notes)}</p>` : ''}
    ${takeRow || `<div class="card-actions">${actions}</div>`}
  </article>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Active items are grouped by what to eat first, not by drawer.
const GROUPS = [
  ['expired', 'Over bedst før'],
  ['soon', 'Spis snart'],
  ['ok', 'God endnu'],
  ['unknown', 'Uden dato'],
];

function render() {
  renderStats();
  const items = visibleItems();
  const list = $('#list');

  if (!items.length) {
    list.innerHTML = `<div class="empty">
      <strong>${state.search ? 'Ingen varer passer til søgningen.'
        : state.tab === 'active' ? 'Fryseren er tom.' : 'Intet her endnu.'}</strong>
      ${state.search ? 'Prøv et andet ord, eller ryd søgefeltet.'
        : state.tab === 'active' ? 'Tryk på “Læg noget i fryseren” for at begynde.'
        : 'Det du bruger op eller smider ud, kan du finde her.'}
    </div>`;
    return;
  }

  if (state.tab !== 'active') {
    list.innerHTML = items
      .slice()
      .sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || ''))
      .map(cardHtml)
      .join('');
    return;
  }

  const byDate = (a, b) => (a.best_before || '').localeCompare(b.best_before || '');
  list.innerHTML = GROUPS.map(([key, title]) => {
    const group = items.filter((i) => i.state === key).sort(byDate);
    if (!group.length) return '';
    return `<h2 class="group-head ${key}">${title} <span>${plural(group.length, 'vare', 'varer')}</span></h2>`
      + group.map(cardHtml).join('');
  }).join('');
}

// --------------------------------------------------------------------- data

async function loadMeta() {
  state.meta = await api('/api/meta');
  state.today = state.meta.today;
  fillSelect($('#f-category'), categoryOptions());
  fillSelect($('#f-unit'), unitOptions());
  fillSelect($('#f-location'), locationOptions(), { placeholder: 'Uden plads' });
  $$('[data-categories]').forEach((s) => fillSelect(s, categoryOptions()));
  $$('[data-units]').forEach((s) => fillSelect(s, unitOptions()));
  $$('[data-locations]').forEach((s) =>
    fillSelect(s, locationOptions(), { placeholder: 'Uden plads' }));
}

async function loadItems() {
  const data = await api('/api/items?status=all');
  state.items = data.items;
  state.today = data.today;
  render();
}

function replaceItem(item) {
  const idx = state.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) state.items[idx] = item; else state.items.push(item);
  render();
}

// ------------------------------------------------------------------ add form

let bestBeforeTouched = false;

function updateDateHint() {
  const frozen = $('#f-frozen').value;
  const best = $('#f-best').value;
  $('#f-hint').textContent = `(${frozen === state.meta.today ? 'frosset i dag' : `frosset ${fmtDate(frozen)}`}`
    + `${best ? `, bedst før ${fmtDate(best)}` : ''})`;
}

async function refreshSuggestion() {
  if (!bestBeforeTouched) {
    const params = new URLSearchParams({
      category: $('#f-category').value,
      frozen_on: $('#f-frozen').value || state.meta.today,
    });
    $('#f-best').value = (await api(`/api/suggest-best-before?${params}`)).best_before;
  }
  updateDateHint();
}

function openAddForm() {
  $('#add-form').reset();
  $('#add-form .more').open = false;
  bestBeforeTouched = false;
  $('#f-frozen').value = state.meta.today;
  $('#add-error').textContent = '';
  refreshSuggestion();
  $('#add-dialog').showModal();
  $('#f-name').focus();
}

/** The − / + buttons next to an amount field. */
function step(button) {
  const input = button.parentElement.querySelector('input');
  let next = (parseFloat(input.value) || 0) + Number(button.dataset.step);
  if (input.max && next > parseFloat(input.max)) next = parseFloat(input.max);
  if (next < (parseFloat(input.min) || 0)) return;
  input.value = fmtNum(next);
}

// ------------------------------------------------------------------- actions

async function cardAction(act, id, form) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  try {
    if (act === 'take' && item.amount > 1) { state.takingId = id; render(); return; }
    if (act === 'take') act = 'allgone';
    if (act === 'take-cancel') { state.takingId = null; render(); return; }
    if (act === 'take-submit') {
      const amount = parseFloat(new FormData(form).get('amount'));
      const updated = await api(`/api/items/${id}/take`, {
        method: 'POST', body: JSON.stringify({ amount }),
      });
      state.takingId = null;
      replaceItem(updated);
      toast(updated.status === 'used'
        ? `${item.name} er brugt op`
        : `Tog ${fmtNum(amount)} ${item.unit}, ${fmtNum(updated.amount)} tilbage`);
      return;
    }
    if (act === 'allgone') {
      const updated = await api(`/api/items/${id}/take`, { method: 'POST', body: '{}' });
      state.takingId = null;
      replaceItem(updated);
      toast(`${item.name} er brugt op`);
      return;
    }
    if (act === 'discard') {
      if (!confirm(`Smid "${item.name}" (${fmtNum(item.amount)} ${item.unit}) ud?`)) return;
      replaceItem(await api(`/api/items/${id}/discard`, { method: 'POST', body: '{}' }));
      toast(`${item.name} er smidt ud`);
      return;
    }
    if (act === 'restore') {
      replaceItem(await api(`/api/items/${id}/restore`, { method: 'POST' }));
      toast(`${item.name} er tilbage i fryseren`);
      return;
    }
    if (act === 'edit') { openEdit(item); return; }
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- edit modal

function openEdit(item) {
  state.editingId = item.id;
  const form = $('#edit-form');
  form.name.value = item.name;
  form.category.value = item.category;
  form.location_id.value = item.location_id ? String(item.location_id) : '';
  form.amount.value = fmtNum(item.amount);
  form.unit.value = item.unit;
  form.frozen_on.value = item.frozen_on;
  form.best_before.value = item.best_before || '';
  form.notes.value = item.notes;
  $('#edit-error').textContent = '';
  $('#edit-dialog').showModal();
}

// ----------------------------------------------------------- locations modal

async function renderLocations() {
  const { locations } = await api('/api/locations');
  state.meta.locations = locations.map(({ id, name }) => ({ id, name }));
  $('#locations-list').innerHTML = locations.map((l) => `
    <li data-id="${l.id}">
      <input value="${escapeHtml(l.name)}" data-act="rename">
      <span class="count">${plural(l.item_count, 'vare', 'varer')}</span>
      <button class="danger" data-act="delete-location">Slet</button>
    </li>`).join('') || '<li>Ingen pladser endnu.</li>';
}

// --------------------------------------------------------------------- theme

const THEME_KEY = 'freezer-theme';

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;               // "system": let the media query decide
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch (e) { /* private mode etc. */ }
  $$('#theme-switch button').forEach((b) =>
    b.classList.toggle('active', b.dataset.theme === choice));
}

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; }
}

// -------------------------------------------------------------------- wiring

function wire() {
  applyTheme(currentTheme());
  $('#theme-switch').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-theme]');
    if (button) applyTheme(button.dataset.theme);
  });

  $('#add-open').addEventListener('click', openAddForm);
  $('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
  $('#f-category').addEventListener('change', refreshSuggestion);
  $('#f-frozen').addEventListener('change', refreshSuggestion);
  $('#f-best').addEventListener('input', () => { bestBeforeTouched = true; updateDateHint(); });
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-step]');
    if (button) step(button);
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.location_id = data.location_id ? Number(data.location_id) : null;
    try {
      const item = await api('/api/items', { method: 'POST', body: JSON.stringify(data) });
      state.items.push(item);
      state.tab = 'active';
      $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.status === 'active'));
      render();
      $('#add-dialog').close();
      toast(`${item.name} er lagt i fryseren`);
    } catch (err) {
      $('#add-error').textContent = err.message;
    }
  });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    state.tab = tab.dataset.status;
    state.takingId = null;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    render();
  }));

  $('#list').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const card = button.closest('.card');
    cardAction(button.dataset.act, Number(card.dataset.id));
  });
  $('#list').addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-act]');
    if (!form) return;
    e.preventDefault();
    cardAction('take-submit', Number(form.closest('.card').dataset.id), form);
  });

  $('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.location_id = data.location_id ? Number(data.location_id) : null;
    data.best_before = data.best_before || null;
    try {
      replaceItem(await api(`/api/items/${state.editingId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }));
      $('#edit-dialog').close();
      toast('Gemt');
    } catch (err) {
      $('#edit-error').textContent = err.message;
    }
  });
  $('#edit-delete').addEventListener('click', async () => {
    if (!confirm('Slet varen og dens historik for altid?')) return;
    await api(`/api/items/${state.editingId}`, { method: 'DELETE' });
    state.items = state.items.filter((i) => i.id !== state.editingId);
    $('#edit-dialog').close();
    render();
    toast('Slettet');
  });

  $('#manage-locations').addEventListener('click', async () => {
    await renderLocations();
    $('#locations-dialog').showModal();
  });
  $('#locations-close').addEventListener('click', () => $('#locations-dialog').close());
  $('#locations-dialog').addEventListener('close', async () => {
    await loadMeta();
    await loadItems();
  });
  $('#location-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/locations', {
        method: 'POST', body: JSON.stringify({ name: $('#location-name').value }),
      });
      $('#location-name').value = '';
      await renderLocations();
    } catch (err) { toast(err.message); }
  });
  $('#locations-list').addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-act="delete-location"]');
    if (!button) return;
    const li = button.closest('li');
    if (!confirm('Slet pladsen? Varerne bliver, men står uden plads.')) return;
    await api(`/api/locations/${li.dataset.id}`, { method: 'DELETE' });
    await renderLocations();
  });
  $('#locations-list').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-act="rename"]');
    if (!input) return;
    try {
      await api(`/api/locations/${input.closest('li').dataset.id}`, {
        method: 'PATCH', body: JSON.stringify({ name: input.value }),
      });
      await renderLocations();
    } catch (err) { toast(err.message); await renderLocations(); }
  });
}

(async function start() {
  wire();
  await loadMeta();
  await loadItems();
})();
