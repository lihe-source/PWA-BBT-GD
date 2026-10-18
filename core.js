/* 溫序 BBT — domain logic, independent of the browser. */
export const APP = 'bbt-gd';
export const VERSION = '1.0.0';
export const SCHEMA = 1;
export const CONDITIONS = ['發燒', '睡眠不足', '飲酒', '量測時間不同', '其他干擾'];
export const DEFAULT_PROFILE = { name: '我的體溫', cycleLength: 28, timeZone: 'Asia/Taipei' };
export const clone = value => JSON.parse(JSON.stringify(value));
export const uuid = () => globalThis.crypto.randomUUID();
export const entityKey = (type, id) => `${type}:${id}`;
export const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2199-12-31';
}
export function addDays(value, n) {
  if (!validDate(value)) throw new Error('日期格式不正確');
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export function datesBetween(start, end, max = 366) {
  if (!validDate(start) || !validDate(end) || end < start) throw new Error('請選擇正確的起訖日期');
  const n = daysBetween(start, end) + 1;
  if (n > max) throw new Error(`一次最多顯示 ${max} 天，請縮小日期範圍`);
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}
export function weekStart(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
export function localNow(timeZone = 'Asia/Taipei', date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, timeZone };
}
export function formatStamp(value, zone = 'Asia/Taipei') {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '尚無';
  const p = localNow(zone, new Date(value));
  return `${p.date.slice(2).replaceAll('-', '/')} ${p.time}`;
}
export function parseTemperature(input) {
  const text = String(input).trim().replace(',', '.');
  if (!/^\d{2}(?:\.\d)?$/.test(text)) throw new Error('請輸入小數第一位的攝氏體溫，例如 36.5');
  const value = Math.round(Number(text) * 10);
  if (value < 200 || value > 500) throw new Error('體溫需介於 20.0～50.0°C，請檢查輸入');
  return value;
}
export const tempText = temp10 => Number.isFinite(temp10) ? (temp10 / 10).toFixed(1) : '—';

function requireId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw new Error('資料識別碼不正確');
}
export function validateValue(type, value) {
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('資料內容不正確');
  if (type === 'record') {
    if (!validDate(value.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '')) throw new Error('量測日期或時間不正確');
    if (!Number.isInteger(value.temp10) || value.temp10 < 200 || value.temp10 > 500) throw new Error('體溫資料不正確');
    if (typeof value.basal !== 'boolean' || !Array.isArray(value.conditions) || value.conditions.some(x => !CONDITIONS.includes(x))) throw new Error('量測分類不正確');
    if (typeof value.notes !== 'string' || value.notes.length > 2000) throw new Error('備註最多 2000 字');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { throw new Error('量測時區不正確'); }
  } else if (type === 'period') {
    if (!validDate(value.start) || (value.end && (!validDate(value.end) || value.end < value.start))) throw new Error('月經結束日期不能早於開始日期');
  } else if (type === 'primary') {
    requireId(value.recordId);
  } else if (type === 'profile') {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60 || !Number.isInteger(value.cycleLength) || value.cycleLength < 15 || value.cycleLength > 90) throw new Error('請填寫名稱及 15～90 天的週期長度');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { throw new Error('顯示時區不正確'); }
  } else throw new Error('不支援的資料類型');
}
function validateEntity(item) {
  if (!item || !['record', 'period', 'primary', 'profile'].includes(item.type)) throw new Error('不支援的資料類型');
  requireId(item.id);
  if (item.type === 'primary' && !validDate(item.id)) throw new Error('每日主要量測日期不正確');
  if (item.type === 'profile' && item.id !== 'main') throw new Error('個人設定識別碼不正確');
  validateValue(item.type, item.value);
}
export function validateEvent(event, dataset) {
  if (!event || event.app !== APP || event.schema !== SCHEMA || event.dataset !== dataset) throw new Error('資料夾或資料格式不相符，已停止同步');
  requireId(event.id);
  if (!['change', 'restore'].includes(event.kind) || !Number.isFinite(new Date(event.at).getTime()) || typeof event.actor !== 'string' || event.actor.length > 254) throw new Error('異動格式不正確');
  if (event.kind === 'change') {
    if (typeof event.barrier !== 'string' || !Array.isArray(event.changes) || event.changes.length > 50000 || !Array.isArray(event.ack || [])) throw new Error('異動內容不正確');
    const keys = new Set();
    for (const item of event.changes) {
      validateEntity(item);
      const key = entityKey(item.type, item.id);
      if (keys.has(key)) throw new Error('異動包含重複項目');
      keys.add(key);
      if (!Array.isArray(item.parents) || item.parents.some(p => typeof p !== 'string') || item.parents.includes(event.id)) throw new Error('版本關聯不正確');
    }
    if ((event.ack || []).some(x => typeof x !== 'string')) throw new Error('舊版異動確認格式不正確');
  } else {
    if (!Array.isArray(event.state) || event.state.length > 50000 || !Array.isArray(event.restoreParents) || !Array.isArray(event.observedIds)) throw new Error('還原內容不正確');
    if (event.restoreParents.includes(event.id)) throw new Error('還原版本關聯不正確');
    const keys = new Set();
    for (const item of event.state) {
      validateEntity(item);
      const key = entityKey(item.type, item.id);
      if (keys.has(key)) throw new Error('還原包含重複項目');
      keys.add(key);
    }
    if ([...event.restoreParents, ...event.observedIds].some(x => typeof x !== 'string')) throw new Error('還原版本關聯不正確');
  }
  return event;
}
export function mergeEvents(current, incoming, dataset) {
  const map = new Map();
  for (const event of [...current, ...incoming]) {
    validateEvent(event, dataset);
    if (map.has(event.id) && stable(map.get(event.id)) !== stable(event)) throw new Error('相同異動識別碼包含不同內容，已停止同步');
    map.set(event.id, event);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function project(events) {
  const restoreEvents = events.filter(e => e.kind === 'restore');
  const replaced = new Set(restoreEvents.flatMap(e => e.restoreParents));
  const restoreHeads = restoreEvents.filter(e => !replaced.has(e.id)).sort((a, b) => a.id.localeCompare(b.id));
  const active = restoreHeads[0] || null;
  const barrier = active?.id || 'root';
  const visible = events.filter(e => e.kind === 'change' && e.barrier === barrier);
  const acked = new Set(visible.flatMap(e => e.ack || []));
  const observed = new Set(active?.observedIds || []);
  const stale = events.filter(e => e.kind === 'change' && e.barrier !== barrier && !observed.has(e.id) && !acked.has(e.id));
  const grouped = new Map();
  const add = (item, rev, parents = [], at = '', actor = '') => {
    const key = entityKey(item.type, item.id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...item, rev, parents, at, actor });
  };
  for (const item of active?.state || []) add(item, active.id, [], active.at, active.actor);
  for (const event of visible) for (const item of event.changes) add(item, event.id, item.parents, event.at, event.actor);
  const entities = new Map();
  const conflicts = [];
  for (const [key, nodes] of grouped) {
    const hidden = new Set(nodes.flatMap(n => n.parents));
    const heads = nodes.filter(n => !hidden.has(n.rev)).sort((a, b) => a.rev.localeCompare(b.rev));
    if (!heads.length) throw new Error('資料版本形成循環，請保留資料並檢查雲端檔案');
    const conflict = new Set(heads.map(n => stable(n.value))).size > 1;
    const entity = { ...heads[0], heads, conflict };
    entities.set(key, entity);
    if (conflict) conflicts.push(entity);
  }
  const records = [], periods = [], primaries = new Map();
  let profile = clone(DEFAULT_PROFILE);
  for (const entity of entities.values()) {
    if (entity.value === null) continue;
    const value = { ...entity.value, id: entity.id, conflict: entity.conflict };
    if (entity.type === 'record') records.push(value);
    if (entity.type === 'period') periods.push(value);
    if (entity.type === 'primary') primaries.set(entity.id, { ...value, conflict: entity.conflict });
    if (entity.type === 'profile') profile = { ...DEFAULT_PROFILE, ...entity.value };
  }
  records.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  periods.sort((a, b) => a.start.localeCompare(b.start));
  return { entities, records, periods, primaries, profile, conflicts, restoreHeads, restoreConflict: restoreHeads.length > 1, stale, barrier };
}
export function currentState(view) {
  return [...view.entities.values()].filter(e => e.value !== null).map(e => ({ type: e.type, id: e.id, value: clone(e.value) })).sort((a, b) => entityKey(a.type, a.id).localeCompare(entityKey(b.type, b.id)));
}
export function buildChange(events, dataset, actor, changes, ack = [], options = {}) {
  const view = project(events);
  const prepared = changes.map(item => ({ type: item.type, id: item.id, value: clone(item.value), parents: item.parents ?? (view.entities.get(entityKey(item.type, item.id))?.heads.map(h => h.rev) || []) }));
  const event = { app: APP, schema: SCHEMA, dataset, id: options.id || uuid(), kind: 'change', barrier: options.barrier ?? view.barrier, at: options.at || new Date().toISOString(), actor, changes: prepared, ack };
  return validateEvent(event, dataset);
}
export function buildRestore(events, dataset, actor, state, options = {}) {
  const view = project(events);
  const event = { app: APP, schema: SCHEMA, dataset, id: options.id || uuid(), kind: 'restore', at: options.at || new Date().toISOString(), actor, restoreParents: view.restoreHeads.map(e => e.id), observedIds: events.map(e => e.id), state: clone(state) };
  return validateEvent(event, dataset);
}
export function dailyValues(view) {
  const groups = new Map();
  for (const r of view.records) {
    if (!groups.has(r.date)) groups.set(r.date, []);
    groups.get(r.date).push(r);
  }
  const result = new Map();
  for (const [date, records] of groups) {
    const choice = view.primaries.get(date);
    const chosen = records.find(r => r.id === choice?.recordId) || records.find(r => r.basal && !r.conditions.length && !r.conflict) || records[0];
    result.set(date, { ...chosen, conflict: chosen.conflict || Boolean(choice?.conflict), count: records.length });
  }
  return result;
}
export function dailySeries(view, start, end) {
  const daily = dailyValues(view);
  return datesBetween(start, end).map(date => ({ date, record: daily.get(date) || null, temp10: daily.get(date)?.temp10 ?? null }));
}
export function weeklySeries(view, start, end) {
  const days = dailySeries(view, start, end);
  const groups = new Map();
  for (const day of days) {
    const week = weekStart(day.date);
    if (!groups.has(week)) groups.set(week, { date: week, end: addDays(week, 6), values: [], records: [], count: 0, temp10: null });
    const group = groups.get(week);
    if (day.record) { group.values.push(day.record.temp10); group.records.push(day.record); group.count++; }
  }
  return [...groups.values()].map(g => ({ ...g, temp10: g.count ? g.values.reduce((a, b) => a + b, 0) / g.count : null }));
}
export function statistics(view) {
  const days = [...new Set(view.records.map(r => r.date))].sort();
  return { days: days.length, records: view.records.length, start: days[0] || '', end: days.at(-1) || '', periods: view.periods.length };
}
const median = values => { const v = [...values].sort((a, b) => a - b); const i = Math.floor(v.length / 2); return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
export function predict(view, today) {
  const periods = view.periods.filter(p => !p.conflict && p.start <= today);
  const last = periods.at(-1);
  const result = { cycleDay: last ? daysBetween(last.start, today) + 1 : null, estimate: null, trend: null, reason: '' };
  if (view.restoreConflict || view.stale.length || view.conflicts.some(e => ['profile', 'period'].includes(e.type))) {
    result.reason = '資料有待處理差異，暫停推估'; return result;
  }
  if (last) {
    const lengths = [];
    for (let i = 1; i < periods.length; i++) lengths.push(daysBetween(periods[i - 1].start, periods[i].start));
    const recent = lengths.slice(-6);
    const irregular = recent.some(n => n < 21 || n > 35) || (recent.length >= 3 && Math.max(...recent) - Math.min(...recent) > 7);
    if (irregular) result.reason = '週期變動較大，暫不提供日期推估';
    else {
      const learned = recent.length >= 3;
      const length = learned ? Math.round(median(recent)) : view.profile.cycleLength;
      const variation = learned ? Math.ceil((Math.max(...recent) - Math.min(...recent)) / 2) : 0;
      const next = addDays(last.start, length);
      if (today > addDays(next, 7)) result.reason = '請補登新的月經開始日';
      else result.estimate = { start: addDays(next, -16 - variation), end: addDays(next, -10 + variation), next, length, learned };
    }
  } else result.reason = '加入月經開始日後，才能提供日期推估';
  const daily = dailyValues(view);
  const end = daily.get(today) ? today : addDays(today, -1);
  const window = Array.from({ length: 9 }, (_, i) => daily.get(addDays(end, i - 8)));
  const valid = r => r && r.basal && !r.conditions.length && !r.conflict && r.temp10 >= 350 && r.temp10 <= 400;
  if (window.every(valid)) {
    const before = window.slice(0, 6), after = window.slice(6);
    const base = median(before.map(r => r.temp10));
    const precedingMax = Math.max(...before.map(r => r.temp10));
    if (after.every(r => r.temp10 > precedingMax) && after.at(-1).temp10 >= base + 2) result.trend = { start: after[0].date, end, rise10: after.reduce((sum, r) => sum + r.temp10, 0) / 3 - base };
  }
  return result;
}
export function snapshot(events, dataset, options = {}) {
  const view = project(events);
  if (view.conflicts.length || view.stale.length || view.restoreConflict) throw new Error('請先處理資料差異，再建立完整備份');
  return { app: APP, schema: SCHEMA, kind: 'backup', dataset, exportedAt: options.at || new Date().toISOString(), appVersion: VERSION, state: currentState(view), eventIds: events.map(e => e.id).sort(), stats: statistics(view) };
}
export function validateSnapshot(value, dataset = null) {
  if (!value || value.app !== APP || value.schema !== SCHEMA || value.kind !== 'backup' || (dataset && value.dataset !== dataset) || !Array.isArray(value.state) || value.state.length > 50000 || !Array.isArray(value.eventIds)) throw new Error('不是可用的溫序 BBT 備份檔，或資料夾不相符');
  const keys = new Set();
  for (const item of value.state) {
    validateEntity(item);
    if (item.value === null) throw new Error('備份內含不正確項目');
    const key = entityKey(item.type, item.id);
    if (keys.has(key)) throw new Error('備份內含重複項目');
    keys.add(key);
  }
  return value;
}
export function snapshotDiff(view, saved) {
  validateSnapshot(saved);
  const current = new Map(currentState(view).map(e => [entityKey(e.type, e.id), e.value]));
  const target = new Map(saved.state.map(e => [entityKey(e.type, e.id), e.value]));
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const [key, value] of target) {
    if (!current.has(key)) counts.added++;
    else if (stable(value) !== stable(current.get(key))) counts.changed++;
  }
  for (const key of current.keys()) if (!target.has(key)) counts.removed++;
  return counts;
}
export function csv(view) {
  const quote = value => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  const daily = dailyValues(view);
  const rows = [['日期', '時間', '體溫(°C)', '基礎體溫', '當日主要量測', '干擾因素', '備註', '量測時區', '資料差異']];
  for (const r of view.records) rows.push([r.date, r.time, tempText(r.temp10), r.basal ? '是' : '否', daily.get(r.date)?.id === r.id ? '是' : '否', r.conditions.join('、'), r.notes, r.timeZone, r.conflict ? '待處理' : '']);
  return '\ufeff' + rows.map(row => row.map(quote).join(',')).join('\r\n');
}
