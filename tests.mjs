/* Run: node --test tests.mjs. No packages, network, credentials, or real health data required. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
import * as Core from './core.js';
import * as DB from './db.js';
import * as Cloud from './drive.js';
import { APP, VERSION, clone, stable, validDate, addDays, daysBetween, datesBetween, weekStart, localNow, parseTemperature, project, mergeEvents, buildChange, buildRestore, currentState, dailyValues, dailySeries, weeklySeries, statistics, predict, snapshot, validateSnapshot, snapshotDiff, csv, escapeHTML } from './core.js';
import { Repository, MemoryKV } from './db.js';
import { Drive, DriveError, SyncEngine, folderId, backupFiles } from './drive.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const D = 'drive:folder123456789';
const record = (date = '2026-10-18', temp10 = 365, extra = {}) => ({ date, time: '07:10', temp10, basal: true, conditions: [], notes: '', timeZone: 'Asia/Taipei', ...extra });
const change = (events, id, value, options = {}) => buildChange(events, D, options.actor || 'test@example.invalid', [{ type: 'record', id, value, ...(options.parents ? { parents: options.parents } : {}) }], [], options);
const recordsView = records => project([buildChange([], D, 'test', records.map((value, i) => ({ type: 'record', id: `record-${i}`, value })))]);

test('dates: leap years, invalid dates and timezone-independent date math', () => {
  assert.equal(validDate('2024-02-29'), true); assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2026-2-03'), false); assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-03-07', '2026-03-10'), 3);
  assert.deepEqual(datesBetween('2026-12-31', '2027-01-02'), ['2026-12-31', '2027-01-01', '2027-01-02']);
  assert.throws(() => datesBetween('2025-01-01', '2026-01-02'), /最多/);
  assert.throws(() => datesBetween('2026-10-19', '2026-10-18'));
});
test('measurement defaults use the selected time zone, including midnight', () => {
  assert.deepEqual(localNow('Asia/Taipei', new Date('2026-10-17T16:05:00Z')), { date: '2026-10-18', time: '00:05', timeZone: 'Asia/Taipei' });
  assert.equal(localNow('America/Los_Angeles', new Date('2026-10-18T01:00:00Z')).date, '2026-10-17');
});
test('temperature input preserves tenths and rejects extra precision or nonnumeric formats', () => {
  assert.equal(parseTemperature('36.5'), 365); assert.equal(parseTemperature('36,6'), 366); assert.equal(parseTemperature('40'), 400);
  for (const value of ['', 'NaN', '36.55', '3e1', '0x24', '-36.5', '100', '19.9']) assert.throws(() => parseTemperature(value));
});
test('same-day primary selection, missing days and real recorded-day count', () => {
  const events = [buildChange([], D, 'test', [
    { type: 'record', id: 'first', value: record('2026-10-16', 366, { time: '06:30' }) },
    { type: 'record', id: 'second', value: record('2026-10-16', 368, { time: '07:30' }) },
    { type: 'record', id: 'third', value: record('2026-10-18', 365) },
    { type: 'primary', id: '2026-10-16', value: { recordId: 'second' } }
  ])];
  const view = project(events), points = dailySeries(view, '2026-10-16', '2026-10-18');
  assert.equal(points[0].temp10, 368); assert.equal(points[1].temp10, null); assert.equal(points[2].temp10, 365);
  assert.equal(statistics(view).days, 2); assert.equal(statistics(view).records, 3);
  assert.equal(dailyValues(view).get('2026-10-16').count, 2);
});
test('weekly average weights each recorded day once, never missing days or extra readings', () => {
  const view = recordsView([record('2026-10-12', 360), record('2026-10-12', 390, { time: '20:00', basal: false }), record('2026-10-14', 370)]);
  const weeks = weeklySeries(view, '2026-10-12', '2026-10-18');
  assert.equal(weeks[0].temp10, 365); assert.equal(weeks[0].count, 2);
  assert.equal(weeks[0].date, '2026-10-12'); assert.equal(weeks[0].end, '2026-10-18');
});
test('week starts Monday and crosses a year correctly', () => {
  assert.equal(weekStart('2027-01-01'), '2026-12-28'); assert.equal(weekStart('2026-10-18'), '2026-10-12');
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
});
test('empty weeks retain null rather than drawing a zero temperature', () => {
  const view = recordsView([record('2026-10-01', 365)]);
  const week = weeklySeries(view, '2026-10-12', '2026-10-18')[0]; assert.equal(week.temp10, null); assert.equal(week.count, 0);
});
test('independent concurrent changes merge without loss and independently of arrival order', () => {
  const a = change([], 'a', record()), b = change([], 'b', record('2026-10-17', 366));
  assert.equal(project(mergeEvents([a], [b], D)).records.length, 2);
  assert.deepEqual(currentState(project([a, b])), currentState(project([b, a])));
});
test('logical duplicate uploads are idempotent; conflicting reuse of an operation ID is rejected', () => {
  const a = change([], 'a', record(), { id: 'op-1' });
  assert.equal(mergeEvents([a], [clone(a)], D).length, 1);
  const tampered = clone(a); tampered.changes[0].value.temp10 = 369;
  assert.throws(() => mergeEvents([a], [tampered], D), /不同內容/);
});
test('same-record concurrent edits retain both versions and require resolution', () => {
  const base = change([], 'r', record(), { id: 'base' });
  const a = change([base], 'r', record('2026-10-18', 366), { id: 'edit-a' });
  const b = change([base], 'r', record('2026-10-18', 368), { id: 'edit-b' });
  const view = project([base, a, b]); assert.equal(view.conflicts.length, 1); assert.equal(view.conflicts[0].heads.length, 2);
  const resolve = buildChange([base, a, b], D, 'test', [{ type: 'record', id: 'r', value: a.changes[0].value }]);
  assert.equal(project([base, a, b, resolve]).conflicts.length, 0); assert.equal(project([base, a, b, resolve]).records[0].temp10, 366);
});
test('concurrent identical edits do not show a false conflict', () => {
  const base = change([], 'r', record()); const a = change([base], 'r', record('2026-10-18', 366)); const b = change([base], 'r', record('2026-10-18', 366));
  assert.equal(project([base, a, b]).conflicts.length, 0);
});
test('deletions are tombstones and stale versions cannot resurrect data', () => {
  const a = change([], 'r', record()); const deleted = change([a], 'r', null);
  assert.equal(project(mergeEvents([a, deleted], [a], D)).records.length, 0);
  const concurrent = change([a], 'r', record('2026-10-18', 367));
  assert.equal(project([a, deleted, concurrent]).conflicts.length, 1);
});
test('a restore is a new barrier; an offline edit made before it is held for review', () => {
  const base = change([], 'r', record()); const oldEdit = change([base], 'r', record('2026-10-18', 369));
  const restored = buildRestore([base], D, 'test', currentState(project([base])));
  const view = project([base, restored, oldEdit]); assert.equal(view.records[0].temp10, 365); assert.equal(view.stale.length, 1);
  const accepted = buildChange([base, restored, oldEdit], D, 'test', oldEdit.changes.map(c => ({ type: c.type, id: c.id, value: c.value })), [oldEdit.id]);
  const after = project([base, restored, oldEdit, accepted]); assert.equal(after.stale.length, 0); assert.equal(after.records[0].temp10, 369);
});
test('new records from a pre-restore offline device are not silently inserted', () => {
  const base = change([], 'r', record()); const offlineNew = change([base], 'new', record('2026-10-17', 364));
  const restored = buildRestore([base], D, 'test', []); const list = [base, restored, offlineNew];
  assert.equal(project(list).records.length, 0); assert.equal(project(list).stale.length, 1);
  const ignore = buildChange(list, D, 'test', [], [offlineNew.id]);
  assert.equal(project([...list, ignore]).stale.length, 0); assert.equal(project([...list, ignore]).records.length, 0);
});
test('concurrent restores remain visible until explicitly selecting a new restore', () => {
  const base = change([], 'r', record());
  const a = buildRestore([base], D, 'A', [], { id: 'restore-a' }); const b = buildRestore([base], D, 'B', currentState(project([base])), { id: 'restore-b' });
  assert.equal(project([base, a, b]).restoreConflict, true);
  const resolve = buildRestore([base, a, b], D, 'test', b.state);
  assert.equal(project([base, a, b, resolve]).restoreConflict, false); assert.equal(project([base, a, b, resolve]).records.length, 1);
});
test('folder boundaries reject foreign events and foreign cloud backups', () => {
  const a = change([], 'r', record()); assert.throws(() => mergeEvents([], [a], 'drive:other'));
  const saved = snapshot([a], D); assert.throws(() => validateSnapshot(saved, 'drive:other'));
});
test('backup counts, content validation and restore differences', () => {
  const a = change([], 'r', record()); const saved = snapshot([a], D);
  assert.equal(saved.stats.days, 1); assert.equal(saved.state.length, 1); assert.equal(saved.apiKey, undefined);
  const b = change([a], 'r', record('2026-10-18', 369));
  assert.deepEqual(snapshotDiff(project([a, b]), saved), { added: 0, changed: 1, removed: 0 });
  const bad = clone(saved); bad.state[0].value.temp10 = 365.5; assert.throws(() => validateSnapshot(bad));
  const duplicate = clone(saved); duplicate.state.push(duplicate.state[0]); assert.throws(() => validateSnapshot(duplicate));
});
test('conflicted datasets cannot be exported as an apparently complete backup', () => {
  const base = change([], 'r', record()), a = change([base], 'r', record('2026-10-18', 366)), b = change([base], 'r', record('2026-10-18', 367));
  assert.throws(() => snapshot([base, a, b], D), /差異/);
});
test('basic trend uses consecutive daily basal readings and excludes fever or general readings', () => {
  const list = [363, 364, 363, 364, 363, 364, 366, 367, 367].map((v, i) => record(addDays('2026-10-10', i), v));
  assert.equal(predict(recordsView(list), '2026-10-18').trend.start, '2026-10-16');
  const fever = clone(list); fever[7].conditions = ['發燒']; assert.equal(predict(recordsView(fever), '2026-10-18').trend, null);
  const general = clone(list); general[8].basal = false; assert.equal(predict(recordsView(general), '2026-10-18').trend, null);
  assert.equal(predict(recordsView(list.filter((_, i) => i !== 4)), '2026-10-18').trend, null);
});
test('cycle prediction requires a period, uses history when available and stops on irregular history', () => {
  assert.equal(predict(project([]), '2026-10-18').estimate, null);
  const periodEvents = starts => [buildChange([], D, 'test', starts.map((start, i) => ({ type: 'period', id: `period-${i}`, value: { start, end: '' } })))];
  const learned = predict(project(periodEvents(['2026-07-17', '2026-08-14', '2026-09-11', '2026-10-09'])), '2026-10-18');
  assert.equal(learned.estimate.learned, true); assert.equal(learned.estimate.length, 28); assert.equal(learned.cycleDay, 10);
  assert.equal(learned.estimate.start, '2026-10-21'); assert.equal(learned.estimate.end, '2026-10-27');
  const irregular = predict(project(periodEvents(['2026-07-01', '2026-07-25', '2026-08-28', '2026-09-21'])), '2026-10-01');
  assert.equal(irregular.estimate, null); assert.match(irregular.reason, /變動/);
});
test('CSV safely escapes quotes, newlines and spreadsheet formula injection', () => {
  const text = csv(recordsView([record('2026-10-18', 365, { notes: '=HYPERLINK("bad")\n第二行' })]));
  assert.ok(text.startsWith('\ufeff')); assert.ok(text.includes("'=HYPERLINK")); assert.ok(text.includes('""bad""'));
  assert.equal(escapeHTML('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
});
test('folder links accept real folder IDs and reject arbitrary hosts or query injection', () => {
  assert.equal(folderId('https://drive.google.com/drive/u/0/folders/abc_123456789?usp=sharing'), 'abc_123456789');
  assert.equal(folderId('abc_123456789'), 'abc_123456789');
  assert.throws(() => folderId('https://evil.invalid/folders/abc_123456789')); assert.throws(() => folderId("abc' or trashed=false"));
});
test('cloud backup order is server creation time, never record count or client time', () => {
  const rows = [{ id: 'older', createdTime: '2026-10-17T01:00:00Z', properties: { bbtKind: 'backup', bbtRecords: '100' } }, { id: 'newer', createdTime: '2026-10-18T01:00:00Z', properties: { bbtKind: 'backup', bbtRecords: '2' } }];
  assert.equal(backupFiles(rows)[0].id, 'newer');
});
test('repository updates are atomic across concurrent local operations', async () => {
  const repo = new Repository(new MemoryKV());
  await Promise.all(Array.from({ length: 20 }, (_, i) => repo.change('a', D, 'test', [{ type: 'record', id: `r-${i}`, value: record() }])));
  const ws = await repo.read('a', D); assert.equal(ws.events.length, 20); assert.equal(ws.outbox.length, 20);
  assert.equal((await repo.read('other-account', D)).events.length, 0);
});
test('failed atomic merges do not acknowledge or erase pending local work', async () => {
  const repo = new Repository(new MemoryKV()); await repo.change('a', D, 'test', [{ type: 'record', id: 'local', value: record() }]);
  const foreign = buildChange([], 'drive:other', 'test', []);
  await assert.rejects(repo.merge('a', D, [foreign], ['bad-file']));
  const ws = await repo.read('a', D); assert.equal(ws.outbox.length, 1); assert.equal(ws.cloudFiles.length, 0);
});
test('restore transaction refuses to discard a local change made after the user preview', async () => {
  const repo = new Repository(new MemoryKV());
  await repo.change('a', D, 'test', [{ type: 'record', id: 'first', value: record() }]);
  const preview = (await repo.read('a', D)).events.map(e => e.id).sort().join('|');
  await repo.change('a', D, 'test', [{ type: 'record', id: 'later', value: record('2026-10-17', 364) }]);
  await assert.rejects(repo.restore('a', D, 'test', [], { expectedIds: preview }), /重新預覽/);
  assert.equal((await repo.view('a', D)).records.length, 2);
});

class FakeDrive {
  constructor() { this.files = new Map(); this.content = new Map(); this.counter = 0; this.failNext = ''; this.uploads = 0; }
  async list() { return clone([...this.files.values()]); }
  async read(id) { if (!this.content.has(id)) throw new Error('missing'); return clone(this.content.get(id)); }
  async reserveId() { return `file-${++this.counter}`; }
  async create(id, data, properties) {
    if (this.failNext === 'before') { this.failNext = ''; throw new Error('simulated offline'); }
    if (this.content.has(id)) { assert.equal(stable(this.content.get(id)), stable(data)); return clone(this.files.get(id)); }
    this.uploads++;
    const file = { id, name: `bbt-${id}.json`, createdTime: new Date(Date.UTC(2026, 9, 18, 0, 0, this.counter)).toISOString(), properties: { bbtApp: APP, ...properties } };
    this.files.set(id, clone(file)); this.content.set(id, clone(data));
    if (this.failNext === 'after') { this.failNext = ''; throw new Error('response lost after successful upload'); }
    return file;
  }
}
const device = drive => { const repo = new Repository(new MemoryKV()); return { repo, sync: new SyncEngine({ repo, drive, key: 'device', dataset: D }) }; };
test('end-to-end simulated two-device sync merges records, backs up and does not duplicate on repeat', async () => {
  const drive = new FakeDrive(), a = device(drive), b = device(drive);
  await a.repo.change('device', D, 'A', [{ type: 'record', id: 'a', value: record() }]);
  await b.repo.change('device', D, 'B', [{ type: 'record', id: 'b', value: record('2026-10-17', 366) }]);
  await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
  assert.equal((await a.repo.view('device', D)).records.length, 2); assert.equal((await b.repo.view('device', D)).records.length, 2);
  const uploads = drive.uploads; await a.sync.sync(); assert.equal(drive.uploads, uploads);
  assert.equal((await a.repo.read('device', D)).outbox.length, 0);
  const latest = backupFiles(await drive.list())[0]; const saved = await a.sync.readBackup(latest.id); assert.equal(saved.stats.days, 2);
});
test('network failure before upload retains pending work, then retries successfully', async () => {
  const drive = new FakeDrive(), a = device(drive); await a.repo.change('device', D, 'A', [{ type: 'record', id: 'a', value: record() }]);
  drive.failNext = 'before'; await assert.rejects(a.sync.sync()); assert.equal((await a.repo.read('device', D)).outbox.length, 1);
  await a.sync.sync(); assert.equal((await a.repo.read('device', D)).outbox.length, 0); assert.equal((await a.repo.view('device', D)).records.length, 1);
});
test('lost upload response reuses the persisted remote ID and never inserts a second event', async () => {
  const drive = new FakeDrive(), a = device(drive); await a.repo.change('device', D, 'A', [{ type: 'record', id: 'a', value: record() }]);
  drive.failNext = 'after'; await assert.rejects(a.sync.sync()); await a.sync.sync();
  assert.equal((await drive.list()).filter(f => f.properties.bbtKind === 'event').length, 1);
  assert.equal((await a.repo.read('device', D)).outbox.length, 0);
});
test('simultaneous conflicting writes synchronize without losing either version and skip misleading backups', async () => {
  const drive = new FakeDrive(), a = device(drive), b = device(drive);
  await a.repo.change('device', D, 'A', [{ type: 'record', id: 'r', value: record() }]); await a.sync.sync(); await b.sync.sync();
  await a.repo.change('device', D, 'A', [{ type: 'record', id: 'r', value: record('2026-10-18', 366) }]);
  await b.repo.change('device', D, 'B', [{ type: 'record', id: 'r', value: record('2026-10-18', 368) }]);
  await Promise.all([a.sync.sync(), b.sync.sync()]); await a.sync.sync(); await b.sync.sync();
  const view = await a.repo.view('device', D); assert.equal(view.conflicts.length, 1); assert.equal(view.conflicts[0].heads.length, 2);
  assert.equal((await b.repo.view('device', D)).conflicts.length, 1);
});
test('cloud restore followed by an old offline device creates a review item instead of resurrecting data', async () => {
  const drive = new FakeDrive(), a = device(drive), b = device(drive);
  await a.repo.change('device', D, 'A', [{ type: 'record', id: 'r', value: record() }]); await a.sync.sync(); await b.sync.sync();
  await b.repo.change('device', D, 'B', [{ type: 'record', id: 'offline', value: record('2026-10-17', 363) }]);
  await a.repo.restore('device', D, 'A', []); await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
  const view = await a.repo.view('device', D); assert.equal(view.records.length, 0); assert.equal(view.stale.length, 1);
});
test('corrupted foreign remote data cannot partially merge into the local store', async () => {
  const drive = new FakeDrive(), a = device(drive);
  const bad = buildChange([], 'drive:other', 'B', []); await drive.create('bad-file', bad, { bbtKind: 'event', bbtOp: bad.id });
  await assert.rejects(a.sync.sync()); assert.equal((await a.repo.read('device', D)).events.length, 0);
});
test('REST client refuses expired auth without sending any network request', async () => {
  let called = false; const drive = new Drive({ auth: { valid: false }, apiKey: 'test', folder: 'folder123456789', fetcher: async () => { called = true; } });
  await assert.rejects(drive.list(), e => e instanceof DriveError && e.status === 401); assert.equal(called, false);
});
test('REST list follows every page, limits queries to the selected folder and sends tokens only as headers', async () => {
  const urls = [];
  const drive = new Drive({ auth: { valid: true, token: 'test-token' }, apiKey: 'test-key', folder: 'folder123456789', fetcher: async (url, init) => {
    urls.push(url); assert.equal(init.headers.Authorization, 'Bearer test-token'); assert.ok(!url.includes('test-token'));
    const next = new URL(url).searchParams.get('pageToken'); return new Response(JSON.stringify(next ? { files: [{ id: 'two' }] } : { files: [{ id: 'one' }], nextPageToken: 'next' }));
  } });
  const files = await drive.list(); assert.equal(files.length, 2); assert.equal(urls.length, 2); assert.ok(new URL(urls[0]).searchParams.get('q').includes("'folder123456789' in parents"));
});
test('REST client surfaces Drive storage quota errors distinctly', async () => {
  const drive = new Drive({ auth: { valid: true, token: 't' }, apiKey: '', folder: 'folder123456789', fetcher: async () => new Response(JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }), { status: 403 }) });
  await assert.rejects(drive.list(), /空間不足/);
});
test('REST upload retries a preallocated ID after HTTP 409 and checks the existing content', async () => {
  const payload = change([], 'r', record());
  const drive = new Drive({ auth: { valid: true, token: 't' }, apiKey: '', folder: 'folder123456789', fetcher: async (url, init) => {
    if (init.method === 'POST') { assert.match(init.body, /"id":"preallocated"/); return new Response('{}', { status: 409 }); }
    return new Response(JSON.stringify(new URL(url).searchParams.get('alt') === 'media' ? payload : { id: 'preallocated', createdTime: '2026-10-18T01:00:00Z', properties: { bbtKind: 'event' } }));
  } });
  assert.equal((await drive.create('preallocated', payload, { bbtKind: 'event' })).id, 'preallocated');
});
test('backup upload response loss recovers one usable server-timestamped snapshot', async () => {
  const drive = new FakeDrive(), a = device(drive);
  await a.repo.change('device', D, 'A', [{ type: 'record', id: 'r', value: record() }]);
  await a.sync.sync({ backup: false });
  drive.failNext = 'after'; await assert.rejects(a.sync.backup());
  await a.sync.sync();
  const backups = backupFiles(await drive.list()); assert.equal(backups.length, 1);
  assert.equal((await a.sync.readBackup(backups[0].id)).stats.records, 1);
});
test('mismatching operation metadata is rejected before acknowledging pending work', async () => {
  const drive = new FakeDrive(), a = device(drive); const event = change([], 'r', record());
  await drive.create('bad-meta', event, { bbtKind: 'event', bbtOp: 'not-the-event-id' });
  await assert.rejects(a.sync.sync(), /識別資訊/);
  assert.equal((await a.repo.read('device', D)).events.length, 0);
});
test('all app icon PNGs contain the sizes declared for PWA and iOS installation', async () => {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const bytes = await readFile(new URL(file, import.meta.url)); assert.equal(bytes.toString('ascii', 1, 4), 'PNG'); assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
  }
});
test('shipped page references existing assets and has every JavaScript-addressed element exactly once', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8'); const js = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id');
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `missing #${match[1]}`);
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"#]+)"/g)) await access(new URL(match[1], import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './'); for (const icon of manifest.icons) await access(new URL(icon.src, import.meta.url));
  assert.equal(JSON.parse(await readFile(new URL('./version.json', import.meta.url))).version, VERSION);
});
test('service worker never intercepts Google APIs, version.json or another repository and only deletes its own caches', async () => {
  const code = await readFile(new URL('./sw.js', import.meta.url), 'utf8'); const handlers = new Map(), deleted = [];
  const cacheNames = ['bbt-gd:/PWA-BBT-GD/:0.9.0', 'bbt-gd:/other/:0.9.0', 'unrelated-cache'];
  const context = { URL, Request, Response, caches: { keys: async () => cacheNames, delete: async name => deleted.push(name) }, self: { registration: { scope: 'https://example.github.io/PWA-BBT-GD/' }, addEventListener: (name, fn) => handlers.set(name, fn), clients: { claim: async () => {} } } };
  vm.runInNewContext(code, context);
  for (const url of ['https://www.googleapis.com/drive/v3/files', 'https://example.github.io/other/app.js', 'https://example.github.io/PWA-BBT-GD/version.json?t=1']) {
    let intercepted = false; handlers.get('fetch')({ request: { url, method: 'GET', mode: 'cors' }, respondWith: () => { intercepted = true; } }); assert.equal(intercepted, false);
  }
  let wait; handlers.get('activate')({ waitUntil: promise => { wait = promise; } }); await wait;
  assert.deepEqual(deleted, ['bbt-gd:/PWA-BBT-GD/:0.9.0']);
});

// Template/lifecycle unit harness. This is not a real browser or a layout/screenshot test.
async function appHarness() {
  const elements = new Map(), handlers = new Map(); let reloads = 0;
  const element = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', value: '', checked: false, hidden: false, open: false, clientWidth: 340, scrollLeft: 0, dataset: {}, setAttribute() {}, querySelector: selector => element(`${key}:${selector}`), querySelectorAll: () => [] });
    return elements.get(key);
  };
  const document = { getElementById: element, querySelector: element, querySelectorAll: () => [], documentElement: { dataset: {} }, activeElement: null };
  const navigator = { onLine: true, serviceWorker: { controller: null, addEventListener: (name, fn) => handlers.set(name, fn), register: async () => ({ waiting: null }) } };
  const context = { ...Core, ...DB, ...Cloud, h: Core.escapeHTML, URL, Date, Intl, Map, Set, Array, Object, Math, Number, String, JSON, Promise, console, crypto: globalThis.crypto, document, navigator, innerWidth: 390, isSecureContext: true, localStorage: { setItem() {} }, location: { reload: () => { reloads++; } }, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, fetch, matchMedia: () => ({ matches: true, addEventListener() {} }) };
  let source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  source = source.replace(/^import .+;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('./app.js', import.meta.url).href)).replace(/\ninit\(\);\s*$/, '\n');
  source += '\nglobalThis.__app = { S, kv, renderChart, setupServiceWorker };';
  vm.runInNewContext(source, context); context.__app.kv.set = async () => {};
  return { app: context.__app, element, handlers, get reloads() { return reloads; } };
}
test('daily chart template displays persistent point labels and selected date/time/temperature above the chart', async () => {
  const ui = await appHarness();
  ui.app.S.view = recordsView([record('2026-10-16', 364, { time: '06:45' }), record('2026-10-18', 366)]);
  ui.app.S.prefs = { mode: 'day', range: 'custom', start: '2026-10-16', end: '2026-10-18' }; ui.app.S.selection = '2026-10-16';
  ui.app.renderChart();
  const header = ui.element('selection-info').innerHTML, chart = ui.element('temperature-chart').innerHTML;
  assert.match(header, /26\/10\/16/); assert.match(header, /06:45/); assert.match(header, /36\.4/);
  assert.match(chart, /class="point-value">36\.4°C/); assert.match(chart, /class="point-value">36\.6°C/);
  assert.match(chart, /縱軸35至40/); assert.equal((chart.match(/class="chart-path"/g) || []).length, 2);
});
test('weekly chart template shows weekly average and day count without inventing a measurement time', async () => {
  const ui = await appHarness(); ui.app.S.view = recordsView([record('2026-10-12', 360), record('2026-10-14', 370)]);
  ui.app.S.prefs = { mode: 'week', range: 'custom', start: '2026-10-12', end: '2026-10-18' }; ui.app.S.selection = '2026-10-12';
  ui.app.renderChart();
  const header = ui.element('selection-info').innerHTML;
  assert.match(header, /當週平均/); assert.match(header, /2／7/); assert.match(header, /36\.5/); assert.doesNotMatch(header, /07:10/);
});
test('first service-worker install does not reload, but a subsequent update in the same session does', async () => {
  const ui = await appHarness(); await ui.app.setupServiceWorker();
  const changed = ui.handlers.get('controllerchange');
  await changed(); assert.equal(ui.reloads, 0);
  await changed(); assert.equal(ui.reloads, 1);
  await changed(); assert.equal(ui.reloads, 1);
});
