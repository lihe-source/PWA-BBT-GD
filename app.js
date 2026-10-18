import { APP, VERSION, DEFAULT_PROFILE, CONDITIONS, clone, uuid, stable, escapeHTML as h, addDays, daysBetween, validDate, localNow, formatStamp, tempText, parseTemperature, entityKey, project, currentState, dailyValues, dailySeries, weeklySeries, statistics, predict, snapshot, validateSnapshot, snapshotDiff, csv } from './core.js';
import { IndexedKV, Repository } from './db.js';
import { GoogleAuth, Drive, SyncEngine, folderId, loadGoogle, backupFiles } from './drive.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const BASE = new URL('./', import.meta.url);
const PREFIX = `${APP}:${BASE.pathname}`;
const kv = new IndexedKV(PREFIX);
const repo = new Repository(kv);
const auth = new GoogleAuth();
const S = { key: 'local', dataset: 'local', meta: null, ws: null, view: project([]), prefs: { theme: 'light', mode: 'day', range: '30' }, config: {}, engine: null, syncState: '', page: 'chart', editor: 'temperature', historyLimit: 40, backupLimit: 5, selectedBackup: '', series: [], selection: '', scrollToSelection: true, recordContext: null, periodContext: null, dirty: { record: false, period: false, profile: false, cloud: false }, saving: false, syncing: false, ready: false, selectedTheme: 'light' };
let toastTimer, syncTimer, draftTimer, refreshTimer, activationTimer, modalResolve, updateBusy = false, reloadInProgress = false, swRegistration = null;
let currentUpdate = null, profileContext = null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(PREFIX) : null;

function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500); }
function fail(error) { console.warn('BBT action failed:', error.name || 'Error'); toast(error.message || '操作未完成，請重試', true); }
function fatal(error) { $('fatal-banner').hidden = false; $('fatal-banner').textContent = `本機儲存無法正常使用：${error.message}。請勿清除瀏覽器資料；可先重新開啟程式，或改用一般瀏覽模式。`; }
function busy(button, value) { if (button) { button.disabled = value; button.setAttribute('aria-busy', String(value)); } }
function broadcast() { channel?.postMessage({ type: 'data', key: S.key }); }
function prettyDate(date, year = true) { return date ? (year ? date.slice(2) : date.slice(5)).replaceAll('-', '/') : '—'; }
function today() { return localNow(S.view.profile.timeZone).date; }
function actor() { return auth.account?.email || S.meta?.email || '本機使用者'; }
async function savePrefs() { await kv.set('preferences', S.prefs); }
function theme(value) {
  S.selectedTheme = value;
  const dark = value === 'dark' || (value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]').content = dark ? '#19161f' : '#fff8f3';
}

function openModal(title, html, actions = []) {
  if (modalResolve) { modalResolve(null); modalResolve = null; }
  $('modal-title').textContent = title; $('modal-body').innerHTML = html; $('modal-actions').replaceChildren();
  for (const action of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `button ${action.style || 'secondary'}`; button.textContent = action.label;
    button.addEventListener('click', () => closeModal(action.value));
    $('modal-actions').append(button);
  }
  const promise = new Promise(resolve => { modalResolve = resolve; });
  if (!$('modal').open) $('modal').showModal(); return promise;
}
function closeModal(value = null) { const resolve = modalResolve; modalResolve = null; $('modal').close(); resolve?.(value); }
async function confirmAction(title, html, label = '確認', danger = false) {
  return (await openModal(title, `<div class="modal-copy">${html}</div>`, [{ label: '取消', value: false }, { label, value: true, style: danger ? 'danger' : 'primary' }])) === true;
}

function captureForms() {
  return { at: Date.now(), dirty: S.dirty, recordContext: S.recordContext, periodContext: S.periodContext, profileContext,
    record: { date: $('record-date').value, time: $('record-time').value, temperature: $('record-temperature').value, basal: $('record-basal').checked, primary: $('record-primary').checked, conditions: [...document.querySelectorAll('[name=condition]:checked')].map(e => e.value), notes: $('record-notes').value },
    period: { start: $('period-start').value, end: $('period-end').value },
    profile: { name: $('profile-name').value, cycleLength: $('cycle-length').value, timeZone: $('time-zone').value },
    cloud: { clientId: $('client-id').value, folder: $('folder-input').value }
  };
}
function emergencyDraft(draft = captureForms()) { try { localStorage.setItem(`${PREFIX}:draft:${S.key}`, JSON.stringify(draft)); } catch { /* IndexedDB write is still attempted */ } return draft; }
async function flushDraft() { clearTimeout(draftTimer); const key = S.key; const draft = emergencyDraft(); await kv.set(`draft:${key}`, draft); }
function markDirty(type) { S.dirty[type] = true; emergencyDraft(); clearTimeout(draftTimer); draftTimer = setTimeout(() => { flushDraft().catch(fatal); }, 300); }
async function loadDraft() {
  let saved = await kv.get(`draft:${S.key}`);
  try { const emergency = JSON.parse(localStorage.getItem(`${PREFIX}:draft:${S.key}`) || 'null'); if (emergency && (!saved || emergency.at > saved.at)) saved = emergency; } catch { /* invalid draft does not affect records */ }
  S.dirty = { record: false, period: false, profile: false, cloud: false };
  resetRecord(false); resetPeriod(false); populateProfile(true); populateCloud();
  if (!saved) return;
  S.dirty = { ...S.dirty, ...saved.dirty };
  if (S.dirty.record && saved.record) {
    const r = saved.record;
    $('record-date').value = r.date || ''; $('record-time').value = r.time || ''; $('record-temperature').value = r.temperature || '';
    $('record-basal').checked = Boolean(r.basal); $('record-primary').checked = Boolean(r.primary); $('record-notes').value = r.notes || '';
    for (const input of document.querySelectorAll('[name=condition]')) input.checked = r.conditions?.includes(input.value) || false;
    S.recordContext = saved.recordContext || S.recordContext;
    updateRecordTitle();
    if (r.notes || r.conditions?.length) $('record-form').querySelector('details').open = true;
  }
  if (S.dirty.period && saved.period) { $('period-start').value = saved.period.start || ''; $('period-end').value = saved.period.end || ''; S.periodContext = saved.periodContext || S.periodContext; $('period-form-title').textContent = S.periodContext?.id ? '編輯月經記錄' : '月經記錄'; }
  if (S.dirty.profile && saved.profile) { $('profile-name').value = saved.profile.name || ''; $('cycle-length').value = saved.profile.cycleLength || ''; ensureZone(saved.profile.timeZone); $('time-zone').value = saved.profile.timeZone; profileContext = saved.profileContext || profileContext; }
  if (S.dirty.cloud && saved.cloud) { $('client-id').value = saved.cloud.clientId || ''; $('folder-input').value = saved.cloud.folder || ''; }
}

function resetRecord(persist = true) {
  $('record-form').reset(); const now = localNow(S.view.profile.timeZone);
  $('record-date').value = now.date; $('record-time').value = now.time; $('record-temperature').value = '';
  $('record-primary').checked = !dailyValues(S.view).has(now.date);
  S.recordContext = { id: null, parents: [], barrier: S.view.barrier, oldDate: '', primaryParents: {}, timeZone: S.view.profile.timeZone };
  S.dirty.record = false; updateRecordTitle();
  $('record-form').querySelector('details').open = false;
  if (persist && S.ready) flushDraft().catch(fatal);
}
function updateRecordTitle() { const edit = Boolean(S.recordContext?.id); $('record-form-title').textContent = edit ? '編輯體溫' : '新增體溫'; $('save-record').querySelector('span').textContent = edit ? '儲存修改' : '儲存體溫'; $('cancel-edit').hidden = !edit; }
function resetPeriod(persist = true) { $('period-form').reset(); $('period-start').value = today(); S.periodContext = { id: null, parents: [], barrier: S.view.barrier }; S.dirty.period = false; $('period-form-title').textContent = '月經記錄'; if (persist && S.ready) flushDraft().catch(fatal); }
function ensureZone(zone) { if (zone && ![...$('time-zone').options].some(o => o.value === zone)) { const option = new Option(zone, zone); $('time-zone').add(option); } }
function populateProfile(force = false) {
  if (!force && S.dirty.profile) return;
  const p = S.view.profile; ensureZone(p.timeZone); $('profile-name').value = p.name; $('cycle-length').value = p.cycleLength; $('time-zone').value = p.timeZone;
  profileContext = { parents: S.view.entities.get('profile:main')?.heads.map(e => e.rev) || [], barrier: S.view.barrier };
}
function populateCloud() { $('client-id').value = S.config.clientId || ''; $('folder-input').value = S.config.folderId ? `https://drive.google.com/drive/folders/${S.config.folderId}` : ''; }
function setEditor(value) { S.editor = value; $('record-form').hidden = value !== 'temperature'; $('period-form').hidden = value !== 'period'; document.querySelectorAll('[data-editor]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.editor === value))); }
function navigate(page) {
  if (!['chart', 'records', 'settings'].includes(page)) page = 'chart';
  S.page = page;
  document.querySelectorAll('.page').forEach(e => { e.hidden = e.id !== `page-${page}`; });
  document.querySelectorAll('[data-page]').forEach(e => { e.dataset.page === page ? e.setAttribute('aria-current', 'page') : e.removeAttribute('aria-current'); });
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  $('main').scrollTop = 0;
  if (page === 'chart') { S.scrollToSelection = true; renderChart(); }
  if (page === 'settings') { renderSettings(); if (navigator.onLine) loadGoogle().catch(() => {}); }
}
async function refresh({ notify = false } = {}) {
  const key = S.key, dataset = S.dataset; const ws = await repo.read(key, dataset);
  if (key !== S.key) return;
  S.ws = ws; S.view = project(ws.events);
  renderAll();
  if (notify) broadcast();
}
function renderAll() { renderChart(); renderHistory(); renderPeriods(); renderSettings(); renderConflictsBanner(); renderStatus(); populateProfile(); }

function chartBounds() {
  const now = today(); let start, end = now;
  if (S.prefs.range === 'month') start = `${now.slice(0, 7)}-01`;
  else if (S.prefs.range === 'cycle') { start = S.view.periods.filter(p => !p.conflict && p.start <= now).at(-1)?.start || addDays(now, -29); if (daysBetween(start, now) > 365) start = addDays(now, -365); }
  else if (S.prefs.range === 'custom') { start = S.prefs.start || addDays(now, -29); end = S.prefs.end || now; }
  else start = addDays(now, -29);
  return { start, end };
}
function renderChart() {
  const { start, end } = chartBounds(); const weekly = S.prefs.mode === 'week';
  let series;
  try { series = weekly ? weeklySeries(S.view, start, end) : dailySeries(S.view, start, end); } catch (e) { $('temperature-chart').innerHTML = `<div class="inline-error">${h(e.message)}</div>`; return; }
  S.series = series;
  if (!series.some(p => p.date === S.selection)) S.selection = weekly ? series.at(-1)?.date : (series.some(p => p.date === today()) ? today() : series.at(-1)?.date);
  $('mode-day').setAttribute('aria-pressed', String(!weekly)); $('mode-week').setAttribute('aria-pressed', String(weekly));
  $('chart-range').value = S.prefs.range; $('custom-range').hidden = S.prefs.range !== 'custom';
  if (document.activeElement !== $('range-start')) $('range-start').value = S.prefs.start || start;
  if (document.activeElement !== $('range-end')) $('range-end').value = S.prefs.end || end;
  $('range-caption').textContent = `${S.view.profile.name} · ${prettyDate(start)} — ${prettyDate(end)}`;
  document.querySelector('.legend>span:first-child').innerHTML = `<i class="legend-dot"></i>${weekly ? '每週平均體溫' : '每日主要量測'}`;
  renderSelection();
  const oldScroll = $('temperature-chart').querySelector('.chart-scroll')?.scrollLeft || 0;
  const viewportWidth = $('temperature-chart').clientWidth - 37 || Math.max(240, innerWidth - 120);
  const step = weekly ? 91 : 61;
  const width = Math.max(viewportWidth, series.length * step + 24);
  const spacing = series.length > 1 ? (width - 56) / (series.length - 1) : 0;
  const x = i => series.length === 1 ? width / 2 : 28 + i * spacing;
  const y = value => 32 + (400 - Math.min(400, Math.max(350, value))) / 50 * 232;
  const pred = predict(S.view, today());
  let axis = '', lines = '', bands = '', hits = '', dots = '', segments = [], segment = [];
  for (let value = 400; value >= 350; value -= 5) { axis += `<text x="29" y="${y(value)}" text-anchor="end">${(value / 10).toFixed(1)}</text>`; lines += `<line x1="0" x2="${width}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/>`; }
  const selectedIndex = series.findIndex(p => p.date === S.selection);
  for (let i = 0; i < series.length; i++) {
    const p = series[i], px = x(i), selected = p.date === S.selection;
    const occupied = S.view.periods.some(period => !period.conflict && p.date >= period.start && p.date <= (period.end || today()));
    if (occupied && !weekly) bands += `<rect x="${px - spacing / 2}" y="27" width="${Math.max(40, spacing)}" height="243" class="period-band" rx="2"/>`;
    if (!weekly && pred.estimate && p.date >= pred.estimate.start && p.date <= pred.estimate.end) bands += `<rect x="${px - spacing / 2}" y="27" width="${Math.max(40, spacing)}" height="243" class="estimate-band" rx="2"/>`;
    if (p.temp10 === null) { if (segment.length) segments.push(segment); segment = []; }
    else {
      const py = y(p.temp10); segment.push([px, py]);
      const outOfBounds = p.temp10 > 400 ? '↑' : p.temp10 < 350 ? '↓' : '';
      dots += `${selected ? `<circle cx="${px}" cy="${py}" r="11" class="selected-halo"/>` : ''}<circle cx="${px}" cy="${py}" r="${selected ? 5.5 : 4.2}" class="chart-point${!weekly && !p.record.basal ? ' other' : ''}${p.record?.conflict ? ' conflicted' : ''}"/><text x="${px}" y="${py - 13}" class="point-value">${outOfBounds}${tempText(p.temp10)}°C</text>`;
    }
    const dateLabel = weekly ? `${prettyDate(p.date, false)}` : `${Number(p.date.slice(5, 7))}/${Number(p.date.slice(8))}`;
    const label2 = weekly ? `— ${prettyDate(p.end, false)}` : ['日', '一', '二', '三', '四', '五', '六'][new Date(`${p.date}T00:00:00Z`).getUTCDay()];
    const aria = weekly ? `${p.date}至${p.end}，${p.temp10 === null ? '沒有記錄' : `平均${tempText(p.temp10)}攝氏，${p.count}天`}` : `${p.date}，${p.record ? `${p.record.time}，${tempText(p.temp10)}攝氏` : '沒有體溫記錄'}`;
    hits += `<g role="button" tabindex="0" data-chart-index="${i}" aria-label="${h(aria)}" aria-pressed="${selected}"><rect x="${Math.max(0, px - (spacing || 60) / 2)}" y="5" width="${spacing || 60}" height="305" class="chart-hit"/><text x="${px}" y="290" class="chart-date${selected ? ' selected' : ''}${p.date === today() ? ' today' : ''}">${dateLabel}</text><text x="${px}" y="307" class="chart-date${selected ? ' selected' : ''}">${label2}</text></g>`;
  }
  if (segment.length) segments.push(segment);
  const paths = segments.map(points => `<path class="chart-path" d="${points.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(2)},${b.toFixed(2)}`).join(' ')}"/>`).join('');
  const selectedLine = selectedIndex >= 0 ? `<line x1="${x(selectedIndex)}" x2="${x(selectedIndex)}" y1="27" y2="271" class="selected-line"/>` : '';
  const hasValues = series.some(p => p.temp10 !== null);
  $('temperature-chart').innerHTML = `<svg class="chart-axis" viewBox="0 0 37 320" aria-hidden="true">${axis}</svg><div class="chart-scroll" aria-label="體溫圖表，可左右捲動"><svg width="${width}" height="320" viewBox="0 0 ${width} 320" role="group" aria-label="${weekly ? '每週平均' : '每日'}體溫折線圖，縱軸35至40攝氏">${bands}${lines}${selectedLine}${paths}${dots}${hits}</svg></div>${!hasValues ? `<div class="chart-empty-overlay"><strong>讓記錄慢慢連成曲線</strong><span>這段日期還沒有體溫資料</span><button class="button secondary compact" type="button" data-action="new-record">${icon('plus')}記錄一筆體溫</button></div>` : ''}`;
  const scroll = $('temperature-chart').querySelector('.chart-scroll');
  if (S.scrollToSelection && selectedIndex >= 0) { scroll.scrollLeft = Math.max(0, x(selectedIndex) - viewportWidth * .65); S.scrollToSelection = false; } else scroll.scrollLeft = oldScroll;
  renderInsights(pred);
}
function renderSelection() {
  const point = S.series.find(p => p.date === S.selection); const weekly = S.prefs.mode === 'week';
  if (!point) { $('selection-info').innerHTML = '<p class="muted">請選擇日期</p>'; return; }
  const date = weekly ? `${prettyDate(point.date)} — ${prettyDate(point.end)}` : prettyDate(point.date);
  let detail = weekly ? (point.count ? `當週平均・已記錄 ${point.count}／7 天` : '本週尚無體溫記錄') : (point.record ? `${point.record.time} · ${point.record.basal ? '基礎體溫' : '其他時間量測'}${point.record.count > 1 ? ` · 當日共 ${point.record.count} 筆` : ''}${point.record.conflict ? ' · 資料待處理' : ''}` : (point.date === today() ? '今日尚未記錄' : '當日無體溫記錄'));
  const label = weekly ? '週平均' : point.date === today() ? '今天' : '';
  $('selection-info').innerHTML = `<div><div class="selection-date">${date}${label ? `<span class="soft-pill">${label}</span>` : ''}</div><span class="selection-time">${h(detail)}</span>${!weekly && point.record?.count > 1 ? '<button type="button" class="text-button" data-action="selected-day">查看當日其他記錄</button>' : ''}</div><div class="selection-actions"><div class="selected-reading"><strong>${tempText(point.temp10)}</strong><span>°C</span></div>${!weekly && point.record ? `<button type="button" class="selection-edit" data-edit-record="${h(point.record.id)}" aria-label="編輯這筆體溫">${icon('edit')}</button>` : ''}</div>`;
}
function renderInsights(pred) {
  const cycle = pred.cycleDay ? `週期第 ${pred.cycleDay} 天` : '尚無週期記錄';
  const estimate = pred.estimate ? `推估排卵 ${prettyDate(pred.estimate.start, false)} — ${prettyDate(pred.estimate.end, false)}` : pred.reason;
  $('cycle-insight').innerHTML = `<strong>${cycle}</strong><span class="detail">${h(estimate || '資料不足，暫不推估')}${pred.estimate ? `<br>${pred.estimate.learned ? '依最近週期估算' : '依自填週期初步估算'}` : ''}</span>`;
  $('trend-insight').innerHTML = pred.trend ? `<strong>可能進入高溫期</strong><span class="detail">${prettyDate(pred.trend.start, false)} 起，連續 3 天升溫<br>趨勢提示，並非排卵確診</span>` : '<strong>持續記錄，觀察變化</strong><span class="detail">需連續有效基礎體溫；一般量測及受干擾資料不納入升溫判讀。</span>';
}

function renderHistory() {
  const stats = statistics(S.view); $('record-total').textContent = `${stats.days} 天・${stats.records} 筆`;
  const daily = dailyValues(S.view); const filter = $('history-date').value;
  const records = [...S.view.records].reverse().filter(r => !filter || r.date === filter);
  $('more-records').hidden = records.length <= S.historyLimit;
  if (!records.length) { $('history-list').innerHTML = `<div class="empty-state">${icon('thermo')}<strong>${filter ? '這一天還沒有記錄' : '從第一筆體溫開始'}</strong><span>${filter ? '可清除日期篩選，查看全部記錄。' : '填入日期、時間與體溫，就會出現在這裡。'}</span></div>`; return; }
  $('history-list').innerHTML = records.slice(0, S.historyLimit).map(r => `<article class="record-item"><div><span class="record-item-date">${prettyDate(r.date)}</span><span class="record-item-time">${r.time}</span><div class="record-item-tags">${daily.get(r.date)?.id === r.id ? '<span class="tag primary-tag">主要量測</span>' : ''}<span class="tag">${r.basal ? '基礎體溫' : '一般量測'}</span>${r.conditions.map(c => `<span class="tag warn">${h(c)}</span>`).join('')}${r.conflict ? '<span class="tag warn">差異待處理</span>' : ''}</div>${r.notes ? `<p class="record-item-note">${h(r.notes)}</p>` : ''}</div><div class="record-item-right"><span class="record-item-temp">${tempText(r.temp10)}<small>°C</small></span><button class="icon-button" type="button" data-edit-record="${h(r.id)}" aria-label="編輯${h(r.date)} ${r.time}體溫">${icon('edit')}</button><button class="icon-button" type="button" data-delete-record="${h(r.id)}" aria-label="刪除${h(r.date)} ${r.time}體溫">${icon('trash')}</button></div></article>`).join('');
}
function renderPeriods() {
  $('period-list').innerHTML = S.view.periods.length ? [...S.view.periods].reverse().map(p => `<div class="period-item"><div>${prettyDate(p.start)} — ${p.end ? prettyDate(p.end) : '進行中'}${p.conflict ? '<span class="tag warn">待處理</span>' : ''}</div><div><button type="button" class="icon-button" data-edit-period="${h(p.id)}" aria-label="編輯月經記錄">${icon('edit')}</button><button type="button" class="icon-button" data-delete-period="${h(p.id)}" aria-label="刪除月經記錄">${icon('trash')}</button></div></div>`).join('') : '<p class="field-help" style="margin-top:16px">尚未加入月經記錄。</p>';
}
async function newRecord() {
  if (S.dirty.record && !(await confirmAction('保留目前草稿？', '<p>目前表單有尚未儲存的內容。按「重新新增」會清空這份草稿，已儲存的體溫不受影響。</p>', '重新新增'))) return;
  resetRecord(); setEditor('temperature'); navigate('records'); $('record-temperature').focus({ preventScroll: true });
}
async function editRecord(id) {
  const entity = S.view.entities.get(entityKey('record', id)); const record = S.view.records.find(r => r.id === id);
  if (!record || !entity) throw new Error('這筆資料已不存在');
  if (entity.conflict) { showConflicts(); return; }
  if (S.dirty.record && S.recordContext?.id !== id && !(await confirmAction('切換編輯記錄', '<p>切換後會清除目前尚未儲存的表單內容。</p>', '開啟記錄'))) return;
  const primary = S.view.entities.get(entityKey('primary', record.date));
  S.recordContext = { id, oldDate: record.date, parents: entity.heads.map(e => e.rev), barrier: S.view.barrier, timeZone: record.timeZone, primaryParents: { [record.date]: primary?.heads.map(e => e.rev) || [] } };
  $('record-date').value = record.date; $('record-time').value = record.time; $('record-temperature').value = tempText(record.temp10); $('record-basal').checked = record.basal;
  $('record-primary').checked = dailyValues(S.view).get(record.date)?.id === id; $('record-notes').value = record.notes;
  for (const input of document.querySelectorAll('[name=condition]')) input.checked = record.conditions.includes(input.value);
  $('record-form').querySelector('details').open = Boolean(record.notes || record.conditions.length);
  S.dirty.record = true; updateRecordTitle(); setEditor('temperature'); navigate('records'); await flushDraft();
}
async function saveRecord(event) {
  event.preventDefault(); if (S.saving) return; if (!$('record-form').reportValidity()) return;
  if (S.view.restoreConflict) { showConflicts(); return; }
  S.saving = true; busy($('save-record'), true);
  try {
    const temp10 = parseTemperature($('record-temperature').value);
    if ((temp10 < 350 || temp10 > 400) && !(await confirmAction('體溫超出圖表範圍', `<p>你輸入的是 <b>${tempText(temp10)}°C</b>，超出圖表的 35～40°C 範圍。</p><p>儲存後保留原值，以圖表邊緣標示，且不納入排卵趨勢分析。請先確認數值與單位。</p>`, '確認儲存'))) return;
    const id = S.recordContext?.id || uuid(); const value = { date: $('record-date').value, time: $('record-time').value, temp10, basal: $('record-basal').checked, conditions: [...document.querySelectorAll('[name=condition]:checked')].map(e => e.value), notes: $('record-notes').value.trim(), timeZone: S.recordContext?.timeZone || S.view.profile.timeZone };
    const duplicate = S.view.records.find(r => r.id !== id && r.date === value.date && r.time === value.time && r.temp10 === value.temp10);
    if (duplicate && !(await confirmAction('相同時間已有體溫記錄', `<p>${prettyDate(value.date)} ${value.time} 已有 ${tempText(temp10)}°C 的記錄。</p><p>是否仍要另外新增一筆？</p>`, '仍要新增'))) return;
    const changes = [{ type: 'record', id, value, parents: S.recordContext?.parents || [] }];
    const context = S.recordContext;
    if (context?.oldDate && context.oldDate !== value.date && S.view.primaries.get(context.oldDate)?.recordId === id) changes.push({ type: 'primary', id: context.oldDate, value: null, parents: context.primaryParents[context.oldDate] || [] });
    if ($('record-primary').checked) changes.push({ type: 'primary', id: value.date, value: { recordId: id }, ...(context?.primaryParents[value.date] ? { parents: context.primaryParents[value.date] } : {}) });
    else if (S.view.primaries.get(value.date)?.recordId === id) changes.push({ type: 'primary', id: value.date, value: null });
    await repo.change(S.key, S.dataset, actor(), changes, [], { barrier: context?.barrier || S.view.barrier });
    S.selection = value.date; S.prefs.mode = 'day'; await refresh({ notify: true }); resetRecord(false); await flushDraft();
    toast(S.engine && auth.valid ? '已儲存，將自動同步' : '已儲存於本機'); queueSync();
  } catch (e) { fail(e); } finally { S.saving = false; busy($('save-record'), false); }
}
async function deleteRecord(id) {
  const record = S.view.records.find(r => r.id === id); if (!record) return;
  const parents = S.view.entities.get(entityKey('record', id)).heads.map(e => e.rev), barrier = S.view.barrier;
  if (!(await confirmAction('刪除這筆體溫？', `<p>${prettyDate(record.date)} ${record.time} · <b>${tempText(record.temp10)}°C</b></p><p>刪除會同步至同一資料夾的其他裝置。</p>`, '刪除', true))) return;
  await repo.change(S.key, S.dataset, actor(), [{ type: 'record', id, value: null, parents }], [], { barrier });
  if (S.recordContext?.id === id) resetRecord(false);
  await refresh({ notify: true }); await flushDraft(); toast('已刪除，保留異動版本'); queueSync();
}
async function editPeriod(id) {
  const entity = S.view.entities.get(entityKey('period', id)); const p = S.view.periods.find(p => p.id === id); if (!p) return;
  if (entity.conflict) { showConflicts(); return; }
  if (S.dirty.period && S.periodContext?.id !== id && !(await confirmAction('切換月經記錄', '<p>將清除目前尚未儲存的月經表單。</p>', '開啟記錄'))) return;
  S.periodContext = { id, parents: entity.heads.map(e => e.rev), barrier: S.view.barrier }; $('period-start').value = p.start; $('period-end').value = p.end || ''; $('period-form-title').textContent = '編輯月經記錄'; S.dirty.period = true; setEditor('period'); navigate('records'); await flushDraft();
}
async function savePeriod(event) {
  event.preventDefault(); if (!$('period-form').reportValidity() || S.saving) return;
  S.saving = true; busy($('save-period'), true);
  try {
    const id = S.periodContext?.id || uuid(), start = $('period-start').value, end = $('period-end').value;
    if (S.view.periods.some(p => p.id !== id && p.start === start)) throw new Error('這個開始日已經有月經記錄，請編輯原本那一筆');
    if (S.view.restoreConflict) throw new Error('請先處理還原版本差異');
    await repo.change(S.key, S.dataset, actor(), [{ type: 'period', id, value: { start, end }, parents: S.periodContext?.parents || [] }], [], { barrier: S.periodContext?.barrier || S.view.barrier });
    await refresh({ notify: true }); resetPeriod(false); await flushDraft(); toast('月經記錄已儲存'); queueSync();
  } catch (e) { fail(e); } finally { S.saving = false; busy($('save-period'), false); }
}
async function deletePeriod(id) {
  const p = S.view.periods.find(p => p.id === id); if (!p) return;
  const parents = S.view.entities.get(entityKey('period', id)).heads.map(e => e.rev), barrier = S.view.barrier;
  if (!(await confirmAction('刪除月經記錄？', `<p>開始日期：${prettyDate(p.start)}</p><p>刪除後會重新計算週期參考。</p>`, '刪除', true))) return;
  await repo.change(S.key, S.dataset, actor(), [{ type: 'period', id, value: null, parents }], [], { barrier }); if (S.periodContext?.id === id) resetPeriod(false);
  await refresh({ notify: true }); await flushDraft(); toast('月經記錄已刪除'); queueSync();
}

function connectionValues() {
  const clientId = $('client-id').value.trim(), folder = folderId($('folder-input').value);
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('OAuth Client ID 格式不正確，需以 .apps.googleusercontent.com 結尾');
  return { clientId, folderId: folder };
}
async function saveConnection(event) {
  event?.preventDefault(); const config = connectionValues();
  if (S.engine?.running || S.syncing || auth.pending) throw new Error('目前正在登入或同步，完成後再修改連線設定');
  const changed = ['clientId', 'folderId'].some(k => S.config[k] !== config[k]);
  S.config = { ...S.config, ...config };
  await kv.set('connection', S.config); S.dirty.cloud = false;
  if (changed) { S.engine = null; auth.clear(); S.syncState = ''; }
  await flushDraft(); renderSettings(); renderStatus(); toast('設定已儲存，按「登入並同步」連線');
}
async function connectGoogle(forceAccount = false) {
  if (S.syncing || S.engine?.running) throw new Error('目前正在同步，請完成後再切換帳號');
  const config = connectionValues();
  // Start the OAuth popup directly inside the click's user gesture.
  S.engine = null; auth.clear();
  const authorization = auth.connect(config.clientId, forceAccount ? '' : (S.config.lastEmail || ''));
  busy($('connect-google'), true); busy($('switch-account'), true);
  try {
    await authorization;
    const drive = new Drive({ auth, folder: config.folderId });
    const [account, folder] = await Promise.all([drive.account(), drive.verifyFolder()]); auth.account = account;
    await flushDraft();
    const key = `${account.sub}:${config.folderId}`, dataset = `drive:${config.folderId}`;
    const localSource = S.key === 'local' && S.ws.events.length ? clone(S.ws.events) : null;
    S.config = { ...config, lastEmail: account.email }; await kv.set('connection', S.config);
    S.key = key; S.dataset = dataset; S.meta = { key, dataset, folderId: config.folderId, folderName: folder.name, email: account.email, sub: account.sub }; await kv.set('active-workspace', S.meta);
    S.engine = new SyncEngine({ repo, drive, key, dataset, onStatus: (status, error) => { if (S.engine?.key !== key) return; S.syncState = status; renderStatus(); if (error) $('sync-error').textContent = error.message; } });
    S.selectedBackup = ''; S.backupLimit = 5; await refresh(); await loadDraft(); await performSync(true);
    const migrationStamp = localSource?.map(e => e.id).sort().join('|');
    if (localSource && await kv.get(`migration:${key}`) !== migrationStamp) {
      const source = project(localSource);
      if (!source.conflicts.length && !source.stale.length && !source.restoreConflict) {
        const take = await confirmAction('加入尚未連線的本機記錄？', `<p>本機未連線區有 ${statistics(source).days} 天、${source.records.length} 筆體溫。</p><p>目前已開啟 <b>${h(folder.name)}</b>。可將這些記錄複製合併進此資料夾；本機原始資料仍保留。</p>`, '合併進此資料夾');
        if (take) {
          const changes = currentState(source).filter(e => (e.type !== 'profile' || !S.view.entities.has('profile:main')) && stable(S.view.entities.get(entityKey(e.type, e.id))?.value) !== stable(e.value)).map(e => ({ ...e, ...(S.view.entities.has(entityKey(e.type, e.id)) ? { parents: [] } : {}) }));
          if (changes.length) { await repo.change(S.key, S.dataset, actor(), changes); await refresh({ notify: true }); await performSync(true); }
          await kv.set(`migration:${key}`, migrationStamp);
        }
      } else toast('未連線區有資料差異，請先處理後再匯出／匯入', true);
    }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    renderSettings(); toast('已連線，資料已檢查並同步');
  } catch (e) { if (!S.engine) auth.clear(); throw e; }
  finally { busy($('connect-google'), false); busy($('switch-account'), false); renderSettings(); renderStatus(); }
}
async function disconnectGoogle() {
  if (S.syncing || S.engine?.running) throw new Error('同步中，請完成後再登出');
  await flushDraft();
  auth.clear(); S.engine = null; S.syncState = ''; S.key = 'local'; S.dataset = 'local'; S.meta = null; S.selectedBackup = ''; S.dirty = { record: false, period: false, profile: false, cloud: false };
  await kv.set('active-workspace', null); await refresh(); await loadDraft(); renderSettings(); renderStatus(); toast('已登出；雲端區的本機快取及待傳記錄仍保留');
}
function queueSync(delay = 1800) { clearTimeout(syncTimer); if (!S.engine || !auth.valid || !navigator.onLine) { renderStatus(); return; } syncTimer = setTimeout(() => { performSync(false).catch(() => {}); }, delay); }
async function performSync(manual = false) {
  const engine = S.engine;
  if (!engine || !auth.valid) { renderStatus(); if (manual) throw new Error('請先按「登入並同步」重新取得 Google 授權'); return; }
  if (!navigator.onLine) { if (manual) throw new Error('目前離線，記錄仍保留在本機，連線後會補傳'); return; }
  if (S.syncing) return S.syncPromise;
  S.syncing = true; busy($('sync-now'), true);
  const run = async () => { try {
    await engine.sync();
    if (S.engine !== engine) return;
    await repo.update(S.key, S.dataset, ws => { ws.backupCatalog = backupFiles(engine.files); return ws; });
    await refresh({ notify: true });
    if (!S.dirty.record) resetRecord(false);
    if (!S.dirty.period) resetPeriod(false);
    if (manual) toast(S.view.conflicts.length || S.view.stale.length || S.view.restoreConflict ? '已同步，請處理資料差異' : '同步完成');
  } catch (e) { if (S.engine === engine) await refresh(); if (manual) throw e; }
  finally { S.syncing = false; busy($('sync-now'), false); renderStatus(); if (S.ws?.outbox.length && S.syncState === 'done') queueSync(1500); } };
  S.syncPromise = run(); return S.syncPromise;
}
function renderStatus() {
  if (!S.ws) return;
  let label, state = '';
  if (!navigator.onLine) { label = '離線記錄'; state = 'error'; }
  else if (S.syncState === 'syncing') { label = '同步中'; state = 'syncing'; }
  else if (S.syncState === 'error') { label = '同步待重試'; state = 'error'; }
  else if (S.dataset === 'local') label = '本機記錄';
  else if (!auth.valid || !S.engine) { label = S.ws.outbox.length ? `待傳 ${S.ws.outbox.length} 筆` : '待連線'; state = 'error'; }
  else if (S.ws.outbox.length) label = `待傳 ${S.ws.outbox.length} 筆`;
  else { label = '已同步'; state = 'done'; }
  $('status-text').textContent = label; $('status-pill').dataset.state = state;
}
function renderSettings() {
  if (!S.ws) return;
  const connected = Boolean(S.engine && auth.valid);
  $('account-state').textContent = connected ? '已連線' : S.meta ? '需要重新連線' : '尚未連線';
  $('account-description').textContent = S.meta ? `${S.meta.email} · ${connected ? '授權有效' : '本機快取可離線使用，雲端同步需重新授權'}` : '先完成下方設定，再登入 Google。每個資料夾對應一位被記錄者。';
  $('connect-google').textContent = S.meta ? '重新連線並同步' : '登入並同步'; $('disconnect-google').hidden = !S.meta;
  $('switch-account').hidden = !S.config.lastEmail;
  $('workspace-label').textContent = S.meta ? S.meta.folderName || 'Google Drive 資料夾' : '本機未連線資料';
  $('last-sync').textContent = formatStamp(S.ws.lastSync, S.view.profile.timeZone);
  $('pending-count').textContent = S.dataset === 'local' ? `${S.ws.outbox.length} 筆本機異動` : `${S.ws.outbox.length} 筆異動`;
  $('sync-error').hidden = !S.ws.lastError; $('sync-error').textContent = S.ws.lastError || '';
  $('theme-select').value = S.prefs.theme; renderBackups(); renderSafety();
}
function renderBackups() {
  const files = backupFiles(S.engine?.files || S.ws.backupCatalog || []);
  if (!files.some(f => f.id === S.selectedBackup)) S.selectedBackup = files[0]?.id || '';
  if (!files.length) $('backup-list').innerHTML = `<div class="empty-state">${icon('cloud')}<strong>${S.meta ? '尚無雲端備份' : '連線後顯示雲端備份'}</strong><span>${S.meta ? '資料成功同步後，會自動建立完整備份。' : '離線時仍可使用下方 JSON 匯出。'}</span></div>`;
  else $('backup-list').innerHTML = files.slice(0, S.backupLimit).map((file, i) => {
    const p = file.properties || {};
    return `<label class="backup-option"><input type="radio" name="backup" value="${h(file.id)}" ${file.id === S.selectedBackup ? 'checked' : ''}><span><strong>${formatStamp(file.createdTime, S.view.profile.timeZone)}${i === 0 ? '<span class="latest">最新・預選</span>' : ''}</strong><small>共 ${h(p.bbtDays || '—')} 天資料・${h(p.bbtRecords || '—')} 筆體溫<br>資料期間：${prettyDate(p.bbtStart)} — ${prettyDate(p.bbtEnd)}<br>備份時間：${formatStamp(file.createdTime, S.view.profile.timeZone)}（${h(S.view.profile.timeZone)}）</small></span></label>`;
  }).join('');
  $('more-backups').hidden = files.length <= S.backupLimit; $('restore-backup').disabled = !S.selectedBackup;
}
function renderSafety() {
  const backups = S.ws.safetyBackups || []; $('safety-count').textContent = `（${backups.length} 份）`;
  $('safety-list').innerHTML = backups.length ? backups.map(b => `<div class="safety-item"><span>${h(b.label)}<br><span class="muted">${formatStamp(b.at, S.view.profile.timeZone)} · ${b.saved.stats?.days ?? '—'} 天</span></span><button type="button" class="text-button" data-download-safety="${h(b.id)}">匯出 JSON</button></div>`).join('') : '<p class="field-help">匯入或還原前會保留目前資料，最多 10 份，僅存於這台裝置。</p>';
}
async function refreshBackups() { await performSync(true); renderBackups(); }
async function manualBackup() {
  if (!S.engine || !auth.valid) throw new Error('請先登入 Google 並完成同步');
  await performSync(true);
  await S.engine.backup({ force: true, label: '手動備份' });
  await repo.update(S.key, S.dataset, ws => { ws.backupCatalog = backupFiles(S.engine.files); return ws; }); await refresh(); toast('完整雲端備份已建立');
}
async function restoreSelectedBackup() {
  if (!S.selectedBackup) throw new Error('請先選擇備份');
  if (!S.engine || !auth.valid) throw new Error('請先重新連線 Google，才能讀取與還原雲端備份');
  const id = S.selectedBackup; await performSync(true);
  const saved = await S.engine.readBackup(id); await restoreSnapshot(saved, true);
}
async function restoreSnapshot(saved, cloud = false) {
  validateSnapshot(saved, cloud ? S.dataset : null);
  if (S.view.conflicts.length || S.view.stale.length || S.view.restoreConflict) { showConflicts(); throw new Error('請先處理資料差異，再進行整份還原'); }
  const previewIds = S.ws.events.map(e => e.id).sort().join('|');
  const diff = snapshotDiff(S.view, saved), count = saved.state.filter(e => e.type === 'record').length;
  const accepted = await confirmAction(cloud ? '還原這個雲端時間點？' : '匯入並取代目前資料？', `<p>選定備份包含 <b>${count} 筆體溫</b>。</p><div class="diff-counts"><div><strong>${diff.added}</strong>新增項目</div><div><strong>${diff.changed}</strong>變更項目</div><div><strong>${diff.removed}</strong>移除項目</div></div><p>${S.meta ? '此操作會在同步後影響同一資料夾的所有共同使用者與裝置。' : '此操作會取代目前本機未連線區的資料。'}</p><p>還原前先建立安全備份；舊裝置後續補傳的修改會另外列出，不直接灌回。</p>`, '確認還原');
  if (!accepted) return;
  const latest = await repo.read(S.key, S.dataset);
  if (latest.events.map(e => e.id).sort().join('|') !== previewIds) throw new Error('預覽期間資料已更新，請重新選取備份並確認還原差異');
  const before = snapshot(S.ws.events, S.dataset);
  await repo.safety(S.key, S.dataset, before, '還原／匯入前');
  if (cloud) { await S.engine.backup({ force: true, label: '還原前安全備份' }); }
  await repo.restore(S.key, S.dataset, actor(), saved.state, { expectedIds: previewIds });
  S.dirty.record = false; S.dirty.period = false; S.dirty.profile = false;
  await refresh({ notify: true }); resetRecord(false); resetPeriod(false); populateProfile(true); await flushDraft();
  if (S.engine && auth.valid) await performSync(true);
  toast('已還原成新的目前版本，原版本仍保留');
}

function conflictCount() { return S.view.conflicts.length + S.view.stale.length + (S.view.restoreConflict ? 1 : 0); }
function renderConflictsBanner() { const count = conflictCount(); $('conflict-banner').hidden = !count; $('conflict-banner-text').textContent = `${count} 項資料差異待處理，雙方版本皆已保留。`; }
function valueDescription(type, value) {
  if (value === null) return '此版本已刪除這個項目';
  if (type === 'record') return `${prettyDate(value.date)} ${value.time} · ${tempText(value.temp10)}°C\n${value.basal ? '基礎體溫' : '其他時間量測'}${value.conditions.length ? ' · ' + value.conditions.join('、') : ''}${value.notes ? '\n' + value.notes : ''}`;
  if (type === 'period') return `${prettyDate(value.start)} — ${value.end ? prettyDate(value.end) : '進行中'}`;
  if (type === 'profile') return `${value.name} · 平均週期 ${value.cycleLength} 天 · ${value.timeZone}`;
  const record = S.view.records.find(r => r.id === value.recordId); return record ? `${record.date} ${record.time} · ${tempText(record.temp10)}°C` : '選取一筆當日主要量測';
}
function conflictsHTML() {
  let html = '<p class="field-help">同筆資料同時修改時，請選擇要保留的內容。選擇會建立新版本，並保留原始異動。</p>';
  if (S.view.restoreConflict) html += `<article class="conflict-item"><h3>不同裝置同時還原了不同版本</h3>${S.view.restoreHeads.map(e => `<div class="conflict-choice"><small>${h(e.actor)} · ${formatStamp(e.at, S.view.profile.timeZone)}</small><p>${e.state.filter(s => s.type === 'record').length} 筆體溫的還原版本</p><button type="button" class="button secondary compact" data-take-restore="${h(e.id)}">使用此還原版本</button></div>`).join('')}</article>`;
  for (const entity of S.view.conflicts) html += `<article class="conflict-item"><h3>${({ record: '體溫記錄', period: '月經記錄', primary: '當日主要量測', profile: '個人設定' })[entity.type]}版本不同</h3>${entity.heads.map(head => `<div class="conflict-choice"><small>${h(head.actor || '原始版本')} · ${formatStamp(head.at, S.view.profile.timeZone)}</small><p>${h(valueDescription(entity.type, head.value))}</p><button type="button" class="button secondary compact" data-resolve-key="${h(entityKey(entity.type, entity.id))}" data-resolve-rev="${h(head.rev)}">保留這個版本</button></div>`).join('')}</article>`;
  for (const event of S.view.stale) html += `<article class="conflict-item"><h3>還原後，收到舊裝置補傳資料</h3><div class="conflict-choice"><small>${h(event.actor)} · ${formatStamp(event.at, S.view.profile.timeZone)}</small>${event.changes.map(c => `<p>${h(valueDescription(c.type, c.value))}</p>`).join('')}</div><div class="button-row"><button type="button" class="button secondary compact" data-accept-stale="${h(event.id)}">套用這份修改</button><button type="button" class="text-button" data-ignore-stale="${h(event.id)}">保留目前資料</button></div></article>`;
  if (!conflictCount()) html += '<div class="empty-state">所有資料差異已處理完成。</div>';
  return html;
}
function showConflicts() { openModal('資料差異', conflictsHTML(), [{ label: '關閉', value: null }]); }
async function resolveConflict(key, rev) {
  const entity = S.view.entities.get(key); const chosen = entity?.heads.find(e => e.rev === rev); if (!chosen) throw new Error('此差異已變更，請重新開啟');
  await repo.change(S.key, S.dataset, actor(), [{ type: entity.type, id: entity.id, value: chosen.value, parents: entity.heads.map(e => e.rev) }]);
  await refresh({ notify: true }); $('modal-body').innerHTML = conflictsHTML(); queueSync();
}
async function handleStale(id, accept) {
  const event = S.view.stale.find(e => e.id === id); if (!event) return;
  if (S.view.restoreConflict) throw new Error('請先決定要使用的還原版本');
  await repo.change(S.key, S.dataset, actor(), accept ? event.changes.map(c => ({ type: c.type, id: c.id, value: c.value })) : [], [id]);
  await refresh({ notify: true }); $('modal-body').innerHTML = conflictsHTML(); queueSync();
}
async function takeRestore(id) {
  const event = S.view.restoreHeads.find(e => e.id === id); if (!event) return;
  await repo.restore(S.key, S.dataset, actor(), event.state); await refresh({ notify: true }); $('modal-body').innerHTML = conflictsHTML(); queueSync();
}

async function saveProfile(event) {
  event.preventDefault(); if (!$('profile-form').reportValidity()) return;
  if (S.view.restoreConflict) throw new Error('請先處理還原版本差異');
  const value = { name: $('profile-name').value.trim(), cycleLength: Number($('cycle-length').value), timeZone: $('time-zone').value };
  await repo.change(S.key, S.dataset, actor(), [{ type: 'profile', id: 'main', value, parents: profileContext?.parents || [] }], [], { barrier: profileContext?.barrier || S.view.barrier });
  S.dirty.profile = false; await refresh({ notify: true }); if (!S.dirty.record) resetRecord(false); if (!S.dirty.period) resetPeriod(false); await flushDraft(); toast('個人設定已儲存'); queueSync();
}
function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function exportJSON() { const saved = snapshot(S.ws.events, S.dataset); download(`BBT-${today()}-${localNow(S.view.profile.timeZone).time.replace(':', '')}.json`, JSON.stringify(saved, null, 2)); }
async function importJSON(event) {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  if (file.size > 25 * 1024 * 1024) throw new Error('備份檔大於 25 MB，請確認選擇的檔案');
  let saved; try { saved = JSON.parse(await file.text()); } catch { throw new Error('JSON 檔案格式不正確'); }
  validateSnapshot(saved);
  if (S.engine && auth.valid) await performSync(true);
  await restoreSnapshot(saved, false);
}

const compareVersion = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0;
};
async function workerVersion(worker) {
  return new Promise(resolve => { const message = new MessageChannel(); const timeout = setTimeout(() => resolve(null), 2500); message.port1.onmessage = e => { clearTimeout(timeout); resolve(e.data?.version); }; worker.postMessage({ type: 'VERSION' }, [message.port2]); });
}
async function applyUpdate(worker) {
  clearTimeout(activationTimer);
  if (S.saving || S.syncing || auth.pending || $('modal').open) {
    $('update-status').textContent = '新版已下載，待目前操作結束後自動更新。';
    activationTimer = setTimeout(() => applyUpdate(worker).catch(fail), 2000); return;
  }
  await flushDraft(); $('update-status').textContent = '新版已下載，草稿已保存，正在切換版本…';
  worker.postMessage({ type: 'ACTIVATE' });
}
async function checkUpdate(manual = false) {
  if (updateBusy) return; updateBusy = true; busy($('check-update'), true);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (!navigator.onLine) throw new Error('目前離線，將繼續使用現有版本，連線後再檢查');
    const url = new URL('version.json', BASE); url.searchParams.set('t', String(Date.now()));
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`版本檔讀取失敗（${response.status}），目前程式仍可使用`);
    const data = await response.json(); if (!/^\d+\.\d+\.\d+$/.test(data.version || '')) throw new Error('版本檔格式不正確，請確認 version.json');
    currentUpdate = data; $('latest-version').textContent = data.version;
    const stamp = new Date().toISOString(); $('last-update-check').textContent = formatStamp(stamp, S.view.profile.timeZone); await kv.set('update-check', { at: stamp, version: data.version });
    if (compareVersion(data.version, VERSION) <= 0) { $('update-status').textContent = '目前已是最新版本。更新不會清除體溫記錄。'; if (manual) toast('目前已是最新版本'); return; }
    $('update-status').textContent = `發現 ${data.version}，正在下載完整更新…`;
    if (!swRegistration) throw new Error('瀏覽器尚未啟用離線更新，請確認使用 HTTPS 並重新開啟頁面');
    await swRegistration.update();
    const started = Date.now();
    while (!swRegistration.waiting && Date.now() - started < 12000) await new Promise(resolve => setTimeout(resolve, 250));
    const worker = swRegistration.waiting;
    if (!worker || await workerVersion(worker) !== data.version) throw new Error('新版檔案尚未完整發佈，保留目前版本，稍後會再次檢查');
    await applyUpdate(worker);
  } catch (e) {
    const message = e.name === 'AbortError' ? '更新檢查逾時，繼續使用目前版本' : e.message;
    $('update-status').textContent = message; if (!currentUpdate) $('latest-version').textContent = '暫時無法確認'; if (manual) toast(message, true);
  } finally { clearTimeout(timeout); updateBusy = false; busy($('check-update'), false); }
}
async function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !isSecureContext) { $('update-status').textContent = '離線與自動更新需要 HTTPS（或 localhost）環境。'; return; }
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!hadController) { hadController = true; return; }
    if (reloadInProgress) return;
    reloadInProgress = true;
    try { await flushDraft(); location.reload(); } catch (e) { reloadInProgress = false; $('update-status').textContent = '草稿尚未保存，請先儲存記錄，再重新開啟程式完成更新。'; fail(e); }
  });
  try {
    swRegistration = await navigator.serviceWorker.register(new URL('sw.js', BASE), { scope: BASE.pathname, updateViaCache: 'none' });
    if (swRegistration.waiting) { const v = await workerVersion(swRegistration.waiting); if (v && compareVersion(v, VERSION) > 0) await applyUpdate(swRegistration.waiting); }
  } catch { $('update-status').textContent = '離線快取建立失敗，目前仍可線上使用，請稍後重新檢查。'; }
}

function bind() {
  $('close-modal').addEventListener('click', () => closeModal());
  $('modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
  $('record-form').addEventListener('submit', saveRecord);
  $('period-form').addEventListener('submit', savePeriod);
  $('profile-form').addEventListener('submit', e => { saveProfile(e).catch(fail); });
  $('cloud-form').addEventListener('submit', e => { e.preventDefault(); saveConnection(e).catch(fail); });
  for (const [id, type] of [['record-form', 'record'], ['period-form', 'period'], ['profile-form', 'profile'], ['cloud-form', 'cloud']]) $(id).addEventListener('input', () => markDirty(type));
  $('record-date').addEventListener('change', () => { if (!S.recordContext?.id) $('record-primary').checked = !dailyValues(S.view).has($('record-date').value); markDirty('record'); });
  $('reset-record').addEventListener('click', () => { newRecord().catch(fail); }); $('cancel-edit').addEventListener('click', () => { resetRecord(); toast('已離開編輯'); });
  $('reset-period').addEventListener('click', async () => { if (!S.dirty.period || await confirmAction('清空月經表單', '<p>將清除尚未儲存的月經表單內容。</p>', '清空表單')) resetPeriod(); });
  $('history-date').addEventListener('change', () => { S.historyLimit = 40; renderHistory(); });
  $('clear-history-filter').addEventListener('click', () => { $('history-date').value = ''; S.historyLimit = 40; renderHistory(); });
  $('more-records').addEventListener('click', () => { S.historyLimit += 40; renderHistory(); });
  $('chart-range').addEventListener('change', () => { S.prefs.range = $('chart-range').value; S.scrollToSelection = true; renderChart(); savePrefs().catch(fail); });
  $('apply-range').addEventListener('click', () => { const start = $('range-start').value, end = $('range-end').value; try { dailySeries(S.view, start, end); S.prefs.start = start; S.prefs.end = end; S.prefs.range = 'custom'; S.scrollToSelection = true; renderChart(); savePrefs().catch(fail); } catch (e) { fail(e); } });
  const selectPoint = target => { const hit = target.closest('[data-chart-index]'); if (!hit) return; const point = S.series[Number(hit.dataset.chartIndex)]; if (point) { S.selection = point.date; renderChart(); } };
  $('temperature-chart').addEventListener('click', e => selectPoint(e.target));
  $('temperature-chart').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPoint(e.target); } });
  $('theme-select').addEventListener('change', () => { S.prefs.theme = $('theme-select').value; theme(S.prefs.theme); savePrefs().catch(fail); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.prefs.theme === 'system') theme('system'); });
  const actions = { 'disconnect-google': disconnectGoogle, 'sync-now': () => performSync(true), 'test-connection': async () => { if (!S.engine || !auth.valid) throw new Error('請先登入 Google'); const info = await S.engine.drive.verifyFolder(); toast(`「${info.name}」可正常讀寫`); }, 'refresh-backups': refreshBackups, 'manual-backup': manualBackup, 'restore-backup': restoreSelectedBackup, 'export-json': exportJSON, 'export-csv': async () => download(`BBT-${today()}.csv`, csv(S.view), 'text/csv;charset=utf-8'), 'check-update': () => checkUpdate(true) };
  for (const [id, action] of Object.entries(actions)) $(id).addEventListener('click', () => Promise.resolve().then(() => action()).catch(fail));
  // OAuth starts directly in the click handler, preserving Safari's user gesture.
  $('connect-google').addEventListener('click', () => { connectGoogle().catch(fail); });
  $('switch-account').addEventListener('click', () => { connectGoogle(true).catch(fail); });
  $('more-backups').addEventListener('click', () => { S.backupLimit += 5; renderBackups(); });
  $('backup-list').addEventListener('change', e => { if (e.target.name === 'backup') S.selectedBackup = e.target.value; });
  $('import-json').addEventListener('click', () => $('import-file').click()); $('import-file').addEventListener('change', e => { importJSON(e).catch(fail); });
  $('status-pill').addEventListener('click', () => navigate('settings'));
  document.addEventListener('click', e => {
    const button = e.target.closest('button,a'); if (!button) return;
    if (button.dataset.page) { e.preventDefault(); navigate(button.dataset.page); }
    if (button.dataset.editor) setEditor(button.dataset.editor);
    if (button.dataset.mode) { S.prefs.mode = button.dataset.mode; S.selection = ''; S.scrollToSelection = true; renderChart(); savePrefs().catch(fail); }
    if (button.dataset.action === 'new-record') newRecord().catch(fail);
    if (button.dataset.action === 'conflicts') showConflicts();
    if (button.dataset.action === 'version') { navigate('settings'); $('version-settings').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    if (button.dataset.action === 'selected-day') { $('history-date').value = S.selection; S.historyLimit = 40; renderHistory(); navigate('records'); }
    if (button.dataset.editRecord) editRecord(button.dataset.editRecord).catch(fail);
    if (button.dataset.deleteRecord) deleteRecord(button.dataset.deleteRecord).catch(fail);
    if (button.dataset.editPeriod) editPeriod(button.dataset.editPeriod).catch(fail);
    if (button.dataset.deletePeriod) deletePeriod(button.dataset.deletePeriod).catch(fail);
    if (button.dataset.resolveKey) resolveConflict(button.dataset.resolveKey, button.dataset.resolveRev).catch(fail);
    if (button.dataset.acceptStale) handleStale(button.dataset.acceptStale, true).catch(fail);
    if (button.dataset.ignoreStale) handleStale(button.dataset.ignoreStale, false).catch(fail);
    if (button.dataset.takeRestore) takeRestore(button.dataset.takeRestore).catch(fail);
    if (button.dataset.downloadSafety) { const b = S.ws.safetyBackups.find(b => b.id === button.dataset.downloadSafety); if (b) download(`BBT-safety-${b.at.slice(0, 10)}.json`, JSON.stringify(b.saved, null, 2)); }
  });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  window.addEventListener('online', () => { loadGoogle().catch(() => {}); queueSync(0); checkUpdate(false); });
  window.addEventListener('offline', () => renderStatus());
  window.addEventListener('pagehide', () => { emergencyDraft(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.ready) { refresh().then(() => queueSync(0)).catch(fail); if (!updateBusy) checkUpdate(false); } else if (S.ready) flushDraft().catch(() => {}); });
  channel?.addEventListener('message', e => { if (e.data.type === 'data' && e.data.key === S.key) refresh().catch(fail); });
  if (window.visualViewport) { const resize = () => { document.body.classList.toggle('keyboard-open', visualViewport.height < innerHeight * .77 && /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)); }; visualViewport.addEventListener('resize', resize); document.addEventListener('focusout', () => setTimeout(resize, 100)); }
  window.addEventListener('resize', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (S.page === 'chart') renderChart(); }, 150); });
}

async function init() {
  $('current-version').textContent = VERSION;
  document.querySelector('.version-pill').textContent = `v${VERSION}`;
  $('condition-options').innerHTML = CONDITIONS.map(c => `<label><input type="checkbox" name="condition" value="${h(c)}">${h(c)}</label>`).join('');
  bind();
  try {
    const [preferences, config, active, update] = await Promise.all([kv.get('preferences'), kv.get('connection'), kv.get('active-workspace'), kv.get('update-check')]);
    S.prefs = { ...S.prefs, ...preferences };
    // Apply the requested light default once; later explicit theme choices remain persistent.
    if (S.prefs.themeDefaultsVersion !== 1) { S.prefs.theme = 'light'; S.prefs.themeDefaultsVersion = 1; }
    S.config = { clientId: config?.clientId || '', folderId: config?.folderId || '', lastEmail: config?.lastEmail || '' };
    await savePrefs(); await kv.set('connection', S.config); theme(S.prefs.theme);
    if (active?.key && active.dataset === `drive:${active.folderId}`) { S.key = active.key; S.dataset = active.dataset; S.meta = active; }
    if (update) { $('latest-version').textContent = update.version; $('last-update-check').textContent = formatStamp(update.at); }
    await refresh(); await loadDraft(); await flushDraft(); S.ready = true; renderAll(); navigate(location.hash.slice(1) || 'chart');
    if (navigator.onLine) loadGoogle().catch(() => {});
    setupServiceWorker().then(() => checkUpdate(false)).catch(() => {});
    setInterval(() => { if (document.visibilityState === 'visible') queueSync(0); }, 60000);
  } catch (e) { fatal(e); }
}
init();
