import { APP, SCHEMA, clone, mergeEvents, project, buildChange, buildRestore, uuid } from './core.js';

export class IndexedKV {
  constructor(name) { this.name = name; this.promise = null; }
  async open() {
    if (!this.promise) this.promise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('此瀏覽器無法使用本機資料庫，請改用 Safari 或 Chrome 的一般模式'));
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(new Error('本機資料庫無法開啟；請確認儲存空間及瀏覽器權限'));
      req.onblocked = () => reject(new Error('資料庫更新被其他視窗阻擋，請關閉其他溫序分頁後重試'));
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    });
    return this.promise;
  }
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => { const req = db.transaction('kv').objectStore('kv').get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  }
  async update(key, updater) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      let result, failure;
      const req = store.get(key);
      req.onsuccess = () => { try { result = updater(req.result); store.put(result, key); } catch (e) { failure = e; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('本機儲存失敗；請檢查裝置剩餘空間'));
    });
  }
  set(key, value) { return this.update(key, () => value); }
}
export class MemoryKV {
  constructor() { this.data = new Map(); this.tail = Promise.resolve(); }
  async get(key) { await this.tail; const v = this.data.get(key); return v === undefined ? undefined : clone(v); }
  update(key, fn) {
    const next = this.tail.then(() => { const old = this.data.get(key); const value = fn(old === undefined ? undefined : clone(old)); this.data.set(key, clone(value)); return clone(value); });
    this.tail = next.catch(() => {}); return next;
  }
  set(key, value) { return this.update(key, () => value); }
}
export function workspace(dataset = 'local') {
  return { app: APP, schema: SCHEMA, dataset, events: [], outbox: [], cloudFiles: [], uploads: {}, lastSync: '', lastBackupSignature: '', lastError: '', safetyBackups: [] };
}
export class Repository {
  constructor(kv) { this.kv = kv; }
  async read(key, dataset) {
    const value = await this.kv.get(`ws:${key}`);
    if (value && value.dataset !== dataset) throw new Error('本機資料夾識別不相符，請重新連線');
    return value || workspace(dataset);
  }
  update(key, dataset, fn) {
    return this.kv.update(`ws:${key}`, old => { const value = old || workspace(dataset); if (value.dataset !== dataset) throw new Error('資料夾識別不相符'); return fn(value); });
  }
  change(key, dataset, actor, changes, ack = [], options = {}) {
    return this.update(key, dataset, value => {
      const event = buildChange(value.events, dataset, actor, changes, ack, options);
      value.events = mergeEvents(value.events, [event], dataset);
      value.outbox.push(event.id); return value;
    });
  }
  restore(key, dataset, actor, state, options = {}) {
    return this.update(key, dataset, value => {
      if (options.expectedIds !== undefined && value.events.map(e => e.id).sort().join('|') !== options.expectedIds) throw new Error('資料在還原前已更新，請重新預覽差異後再還原');
      const event = buildRestore(value.events, dataset, actor, state, options);
      value.events = mergeEvents(value.events, [event], dataset); value.outbox.push(event.id); return value;
    });
  }
  merge(key, dataset, events, files = []) {
    return this.update(key, dataset, value => { value.events = mergeEvents(value.events, events, dataset); value.cloudFiles = [...new Set([...value.cloudFiles, ...files])]; return value; });
  }
  ack(key, dataset, eventId, fileId) {
    return this.update(key, dataset, value => { value.outbox = value.outbox.filter(id => id !== eventId); value.cloudFiles = [...new Set([...value.cloudFiles, fileId])]; delete value.uploads[eventId]; return value; });
  }
  async reserve(key, dataset, operation, reserve) {
    let value = await this.read(key, dataset);
    if (value.uploads[operation]) return value.uploads[operation];
    const id = await reserve();
    value = await this.update(key, dataset, ws => { ws.uploads[operation] ||= id; return ws; });
    return value.uploads[operation];
  }
  safety(key, dataset, saved, label) {
    return this.update(key, dataset, ws => { ws.safetyBackups.unshift({ id: uuid(), at: new Date().toISOString(), label, saved }); ws.safetyBackups = ws.safetyBackups.slice(0, 10); return ws; });
  }
  async view(key, dataset) { return project((await this.read(key, dataset)).events); }
}
