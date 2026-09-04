'use strict';

const state = {
  meta: { categories: [], units: [], locations: [], soon_days: 21, today: '' },
  today: new Date().toISOString().slice(0, 10),
  items: [],
  tab: 'active',
  search: '',
  location: '',
  condition: '',
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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtNum = (n) => (Math.round(n * 100) / 100).toString();

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

const parseIso = (iso) => new Date(iso + 'T00:00:00');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  if (months < 1) return plural(Math.round((to - from) / 86400000), 'day');
  if (months < 12) return plural(months, 'month');
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years}y ${rest}m` : plural(years, 'year');
}

function conditionLabel(item) {
  if (item.state === 'unknown') return 'No date set';
  if (item.days_left === 0) return 'Best before today';
  if (item.state === 'expired') return `${fmtSpan(item.best_before, state.today)} past best before`;
  return `${fmtSpan(state.today, item.best_before)} left`;
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
  state.meta.categories.map((c) => ({ value: c.name, label: `${c.name} · ~${c.months} mo` }));
const locationOptions = () =>
  state.meta.locations.map((l) => ({ value: String(l.id), label: l.name }));
const unitOptions = () => state.meta.units.map((u) => ({ value: u, label: u }));

// -------------------------------------------------------------------- render

function visibleItems() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.tab === 'active' ? item.status !== 'active' : item.status === 'active') return false;
    if (state.location && String(item.location_id || '') !== state.location) return false;
    if (state.condition && item.state !== state.condition) return false;
    if (q) {
      const hay = `${item.name} ${item.category} ${item.notes} ${item.location || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderStats() {
  const active = state.items.filter((i) => i.status === 'active');
  const expired = active.filter((i) => i.state === 'expired').length;
  const soon = active.filter((i) => i.state === 'soon').length;
  const chips = [`<span class="chip"><b>${active.length}</b> in the freezer</span>`];
  if (soon) chips.push(`<span class="chip soon"><b>${soon}</b> to use soon</span>`);
  if (expired) chips.push(`<span class="chip bad"><b>${expired}</b> past best before</span>`);
  $('#stats').innerHTML = chips.join('');
}

function cardHtml(item) {
  const closed = item.status !== 'active';
  const takeOpen = state.takingId === item.id;
  const bits = [];
  if (item.location) bits.push(item.location);
  bits.push(item.category);
  bits.push(`frozen ${fmtDate(item.frozen_on)} · ${fmtSpan(item.frozen_on, state.today)} ago`);
  if (item.best_before && !closed) bits.push(`best before ${fmtDate(item.best_before)}`);
  if (item.notes) bits.push(`<span class="note">${escapeHtml(item.notes)}</span>`);

  const badge = closed
    ? `<span class="badge unknown">${item.status === 'used' ? 'Used up' : 'Thrown out'}</span>`
    : `<span class="badge ${item.state}">${conditionLabel(item)}</span>`;

  const actions = closed
    ? `<button data-act="restore">Put back</button><button data-act="edit">Edit</button>`
    : `<button data-act="take">Take out…</button>
       <button data-act="allgone">All gone</button>
       <button data-act="discard">Threw out</button>
       <button data-act="edit">Edit</button>`;

  const takeRow = takeOpen
    ? `<form class="take-row" data-act="take-submit">
         <span>Take</span>
         <input type="number" name="amount" step="any" min="0.01" max="${item.amount}"
                value="${fmtNum(Math.min(1, item.amount))}" autofocus>
         <span>${escapeHtml(item.unit)} of ${fmtNum(item.amount)}</span>
         <button class="primary" type="submit">Confirm</button>
         <button class="ghost" type="button" data-act="take-cancel">Cancel</button>
       </form>`
    : '';

  return `<article class="card ${closed ? 'closed unknown' : item.state}" data-id="${item.id}">
    <div class="bar"></div>
    <div class="card-body">
      <div class="card-title">
        <h3>${escapeHtml(item.name)}</h3>
        <span class="qty">${fmtNum(item.amount)} ${escapeHtml(item.unit)}</span>
        ${badge}
      </div>
      <div class="meta">${bits.map((b) => `<span>${b}</span>`).join('')}</div>
      ${takeRow}
    </div>
    <div class="card-actions">${actions}</div>
  </article>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  renderStats();
  const items = visibleItems();
  const list = $('#list');

  if (!items.length) {
    const filtered = state.search || state.location || state.condition;
    list.innerHTML = `<div class="empty">
      <p style="font-size:32px">${state.tab === 'active' ? '🧊' : '📋'}</p>
      <p><strong>${filtered ? 'Nothing matches those filters.'
        : state.tab === 'active' ? 'Your freezer is empty.' : 'No history yet.'}</strong></p>
      <p>${filtered ? 'Try clearing the search or filters.'
        : state.tab === 'active' ? 'Add something above and it will show up here.'
        : 'Items you use up or throw out are kept here.'}</p>
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

  const groups = new Map();
  for (const item of items) {
    const key = item.location || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const order = state.meta.locations.map((l) => l.name).concat('Unassigned');
  const sorted = [...groups.entries()].sort(
    (a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  list.innerHTML = sorted.map(([name, group]) => {
    const warn = group.filter((i) => i.state === 'expired').length;
    return `<div class="group-head">${escapeHtml(name)}
        <span>${group.length} item${group.length === 1 ? '' : 's'}${warn ? ` · ${warn} past best before` : ''}</span>
      </div>` + group.map(cardHtml).join('');
  }).join('');
}

// --------------------------------------------------------------------- data

async function loadMeta() {
  state.meta = await api('/api/meta');
  state.today = state.meta.today;
  fillSelect($('#f-category'), categoryOptions());
  fillSelect($('#f-unit'), unitOptions());
  fillSelect($('#f-location'), locationOptions(), { placeholder: 'Unassigned' });
  fillSelect($('#filter-location'), locationOptions(), { placeholder: 'All locations' });
  $('#filter-location').value = state.location;
  $$('[data-categories]').forEach((s) => fillSelect(s, categoryOptions()));
  $$('[data-units]').forEach((s) => fillSelect(s, unitOptions()));
  $$('[data-locations]').forEach((s) =>
    fillSelect(s, locationOptions(), { placeholder: 'Unassigned' }));
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

async function refreshSuggestion() {
  if (bestBeforeTouched) return;
  const params = new URLSearchParams({
    category: $('#f-category').value,
    frozen_on: $('#f-frozen').value || state.meta.today,
  });
  const data = await api(`/api/suggest-best-before?${params}`);
  $('#f-best').value = data.best_before;
  $('#f-hint').textContent = `· suggested: ~${data.months} months`;
}

function resetAddForm() {
  const form = $('#add-form');
  form.reset();
  bestBeforeTouched = false;
  $('#f-frozen').value = state.meta.today;
  $('#add-error').textContent = '';
  refreshSuggestion();
}

function toggleAddForm(open) {
  const form = $('#add-form');
  const show = open ?? form.hidden;
  form.hidden = !show;
  $('#add-toggle').setAttribute('aria-expanded', String(show));
  if (show) { resetAddForm(); $('#f-name').focus(); }
}

// ------------------------------------------------------------------- actions

async function cardAction(act, id, form) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  try {
    if (act === 'take') { state.takingId = id; render(); return; }
    if (act === 'take-cancel') { state.takingId = null; render(); return; }
    if (act === 'take-submit') {
      const amount = parseFloat(new FormData(form).get('amount'));
      const updated = await api(`/api/items/${id}/take`, {
        method: 'POST', body: JSON.stringify({ amount }),
      });
      state.takingId = null;
      replaceItem(updated);
      toast(updated.status === 'used'
        ? `${item.name} — all used up`
        : `Took ${fmtNum(amount)} ${item.unit}, ${fmtNum(updated.amount)} left`);
      return;
    }
    if (act === 'allgone') {
      const updated = await api(`/api/items/${id}/take`, { method: 'POST', body: '{}' });
      replaceItem(updated);
      toast(`${item.name} — all used up`);
      return;
    }
    if (act === 'discard') {
      if (!confirm(`Throw out "${item.name}" (${fmtNum(item.amount)} ${item.unit})?`)) return;
      replaceItem(await api(`/api/items/${id}/discard`, { method: 'POST', body: '{}' }));
      toast(`${item.name} — thrown out`);
      return;
    }
    if (act === 'restore') {
      replaceItem(await api(`/api/items/${id}/restore`, { method: 'POST' }));
      toast(`${item.name} is back in the freezer`);
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
      <span class="count">${l.item_count} item${l.item_count === 1 ? '' : 's'}</span>
      <button class="danger-ghost" data-act="delete-location">Delete</button>
    </li>`).join('') || '<li>No locations yet.</li>';
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

  $('#add-toggle').addEventListener('click', () => toggleAddForm());
  $('#add-cancel').addEventListener('click', () => toggleAddForm(false));
  $('#f-category').addEventListener('change', refreshSuggestion);
  $('#f-frozen').addEventListener('change', refreshSuggestion);
  $('#f-best').addEventListener('input', () => { bestBeforeTouched = true; });

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
      toast(`${item.name} is in the freezer`);
      resetAddForm();
      $('#f-name').focus();
    } catch (err) {
      $('#add-error').textContent = err.message;
    }
  });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#filter-location').addEventListener('change', (e) => { state.location = e.target.value; render(); });
  $('#filter-state').addEventListener('change', (e) => { state.condition = e.target.value; render(); });
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
      toast('Saved');
    } catch (err) {
      $('#edit-error').textContent = err.message;
    }
  });
  $('#edit-delete').addEventListener('click', async () => {
    if (!confirm('Delete this item and its history for good?')) return;
    await api(`/api/items/${state.editingId}`, { method: 'DELETE' });
    state.items = state.items.filter((i) => i.id !== state.editingId);
    $('#edit-dialog').close();
    render();
    toast('Deleted');
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
    if (!confirm('Delete this location? Its items stay, but become unassigned.')) return;
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
  $('#f-frozen').value = state.meta.today;
  await loadItems();
  await refreshSuggestion();
})();
