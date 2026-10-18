import { APP, SCHEMA, VERSION, project, snapshot, validateSnapshot, stable } from './core.js';

export class DriveError extends Error {
  constructor(message, status = 0, reason = '') { super(message); this.name = 'DriveError'; this.status = status; this.reason = reason; }
}
export function folderId(input) {
  const text = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{10,200}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') throw new Error();
    const id = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] || url.searchParams.get('id');
    if (id && /^[A-Za-z0-9_-]{10,200}$/.test(id)) return id;
  } catch { /* user-facing validation below */ }
  throw new Error('請貼上 Google Drive 資料夾連結，或填入正確的資料夾 ID');
}
export async function loadGoogle() {
  if (globalThis.google?.accounts?.oauth2) return;
  if (!globalThis.document) throw new Error('需要瀏覽器才能登入 Google');
  const existing = document.querySelector('#google-identity');
  if (existing?.dataset.failed) existing.remove();
  let script = document.querySelector('#google-identity');
  if (!script) {
    script = document.createElement('script'); script.id = 'google-identity'; script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true; document.head.append(script);
  }
  await new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.oauth2) return resolve();
    const timeout = setTimeout(() => reject(new Error('Google 登入元件載入逾時，請檢查網路後重試')), 15000);
    script.addEventListener('load', () => { clearTimeout(timeout); globalThis.google?.accounts?.oauth2 ? resolve() : reject(new Error('Google 登入元件未正常載入')); }, { once: true });
    script.addEventListener('error', () => { clearTimeout(timeout); script.dataset.failed = 'true'; reject(new Error('無法載入 Google 登入元件；請檢查網路或內容阻擋設定')); }, { once: true });
  });
}
export class GoogleAuth {
  constructor() { this.token = ''; this.expiresAt = 0; this.account = null; this.pending = false; }
  get valid() { return Boolean(this.token && Date.now() < this.expiresAt - 30000); }
  clear() { this.token = ''; this.expiresAt = 0; this.account = null; }
  connect(clientId, loginHint = '') {
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) return Promise.reject(new Error('請先填入 OAuth Web Client ID')); 
    if (!globalThis.google?.accounts?.oauth2) {
      loadGoogle().catch(() => {});
      return Promise.reject(new Error('正在準備 Google 登入，請稍候再按一次「登入並同步」'));
    }
    if (this.pending) return Promise.reject(new Error('登入視窗已開啟，請先完成或關閉該視窗'));
    this.pending = true;
    return new Promise((resolve, reject) => {
      const finish = (error, response) => { clearTimeout(timeout); this.pending = false; error ? reject(error) : resolve(response); };
      const timeout = setTimeout(() => finish(new Error('登入未完成，請重新按登入按鈕')), 90000);
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive openid email profile',
        include_granted_scopes: true,
        hint: loginHint || undefined,
        callback: response => {
          if (response.error) return finish(new Error(response.error === 'access_denied' ? '你尚未同意 Google Drive 存取，資料仍保留在本機' : `Google 授權未完成：${response.error}`));
          if (!google.accounts.oauth2.hasGrantedAllScopes(response, 'https://www.googleapis.com/auth/drive')) return finish(new Error('請同意 Google Drive 讀寫權限後再連線'));
          this.token = response.access_token; this.expiresAt = Date.now() + Number(response.expires_in || 3600) * 1000; finish(null, response);
        },
        error_callback: error => finish(new Error(error.type === 'popup_closed' ? '登入視窗已關閉，尚未連線' : '登入視窗被瀏覽器阻擋，請允許彈出視窗後再試'))
      });
      try { client.requestAccessToken({ prompt: loginHint ? '' : 'select_account' }); } catch (e) { finish(e); }
    });
  }
}
export class Drive {
  constructor({ auth, apiKey, folder, fetcher = globalThis.fetch.bind(globalThis) }) { this.auth = auth; this.apiKey = apiKey; this.folder = folder; this.fetcher = fetcher; }
  async request(path, options = {}, upload = false) {
    if (!this.auth.valid) throw new DriveError('Google 授權已過期，請按「重新連線」；尚未同步的記錄仍保留在本機', 401);
    const base = upload ? 'https://www.googleapis.com/upload/drive/v3/' : 'https://www.googleapis.com/drive/v3/';
    const url = new URL(path, base); if (this.apiKey) url.searchParams.set('key', this.apiKey);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await this.fetcher(url.href, { ...options, cache: 'no-store', headers: { Authorization: `Bearer ${this.auth.token}`, ...options.headers }, signal: controller.signal });
    } catch (e) { throw new DriveError(e.name === 'AbortError' ? '雲端連線逾時，資料已保留，稍後會重試' : '雲端目前無法連線，資料已保留，請檢查網路'); }
    finally { clearTimeout(timeout); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const reason = body.error?.errors?.[0]?.reason || body.error?.status || '';
      let message = `Google Drive 回應 ${response.status}，請稍後重試`;
      if (response.status === 401) { this.auth.clear?.(); message = 'Google 授權已失效，請重新連線；本機資料不受影響'; }
      else if (reason === 'storageQuotaExceeded') message = 'Google Drive 空間不足，請釋放空間後重新同步';
      else if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') message = 'Google Cloud 專案尚未啟用 Google Drive API';
      else if (/API_KEY|keyInvalid|ipRefererBlocked|forbidden/i.test(reason + ' ' + (body.error?.message || '')) && /key|refer/i.test(body.error?.message || '')) message = 'API Key 無效或網站限制不符，請檢查 Key 的 API 與網站限制';
      else if (response.status === 403 && /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reason)) message = 'Google Drive 暫時限制請求頻率，資料已保留，稍後重試';
      else if (response.status === 403) message = '目前帳號沒有資料夾讀寫權限，或 Google 專案限制了存取；請檢查共用權限及 OAuth 設定';
      else if (response.status === 404) message = '找不到資料夾或資料檔；也可能目前帳號沒有存取權限';
      throw new DriveError(message, response.status, reason);
    }
    return response;
  }
  async account() {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await this.fetcher('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${this.auth.token}` }, signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('無法確認 Google 帳號，請重新登入');
      const data = await res.json();
      if (!data.sub || !data.email) throw new Error('無法讀取 Google 帳號資訊');
      return { sub: String(data.sub), email: String(data.email), name: String(data.name || data.email) };
    } catch (e) { if (e.name === 'AbortError') throw new Error('確認 Google 帳號逾時，請重試'); throw e; }
    finally { clearTimeout(timeout); }
  }
  async verifyFolder() {
    const fields = 'id,name,mimeType,trashed,capabilities(canAddChildren,canListChildren)';
    const response = await this.request(`files/${encodeURIComponent(this.folder)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`);
    const data = await response.json();
    if (data.trashed || data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('這個連結不是可用的 Google Drive 資料夾');
    if (!data.capabilities?.canAddChildren || data.capabilities?.canListChildren === false) throw new Error('此帳號無法讀寫資料夾，請請擁有者給予「編輯者」權限');
    return data;
  }
  async list() {
    const files = []; let token = '';
    do {
      const query = new URLSearchParams({ q: `'${this.folder}' in parents and trashed = false and properties has { key='bbtApp' and value='${APP}' }`, pageSize: '1000', spaces: 'drive', fields: 'nextPageToken,incompleteSearch,files(id,name,createdTime,modifiedTime,size,properties)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (token) query.set('pageToken', token);
      const page = await (await this.request(`files?${query}`)).json();
      if (page.incompleteSearch) throw new Error('Google Drive 未回傳完整資料，為避免遺漏，本次同步已停止，請重試');
      files.push(...(page.files || [])); token = page.nextPageToken || '';
    } while (token);
    return files;
  }
  async read(id) {
    const response = await this.request(`files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    const text = await response.text();
    if (text.length > 25 * 1024 * 1024) throw new Error('雲端檔案過大，已停止讀取');
    try { return JSON.parse(text); } catch { throw new Error('雲端 JSON 檔案損壞，請保留檔案並使用較早備份'); }
  }
  async reserveId() {
    const data = await (await this.request('files/generateIds?count=1&space=drive')).json();
    if (!data.ids?.[0]) throw new Error('無法建立雲端檔案識別碼');
    return data.ids[0];
  }
  async create(id, data, properties) {
    const boundary = `bbt_${crypto.randomUUID().replaceAll('-', '')}`;
    const kind = properties.bbtKind;
    const metadata = { id, name: `bbt-${kind}-${data.id || id}.json`, mimeType: 'application/json', parents: [this.folder], properties: { bbtApp: APP, bbtSchema: String(SCHEMA), ...properties } };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
    try {
      return await (await this.request('files?uploadType=multipart&supportsAllDrives=true&fields=id,name,createdTime,modifiedTime,properties', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, true)).json();
    } catch (error) {
      if (error.status !== 409) throw error;
      const existing = await this.read(id);
      if (stable(existing) !== stable(data)) throw new Error('雲端檔案識別碼衝突，已停止寫入');
      // The backup list must use Google's server timestamp, including after a lost response.
      return await (await this.request(`files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,createdTime,modifiedTime,properties`)).json();
    }
  }
}
export async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function backupFiles(files) {
  return files.filter(f => f.properties?.bbtKind === 'backup').sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || '') || b.id.localeCompare(a.id));
}
export class SyncEngine {
  constructor({ repo, drive, key, dataset, onStatus = () => {} }) { this.repo = repo; this.drive = drive; this.key = key; this.dataset = dataset; this.onStatus = onStatus; this.files = []; this.running = null; }
  async pull() {
    this.files = await this.drive.list();
    const ws = await this.repo.read(this.key, this.dataset);
    const known = new Set(ws.cloudFiles);
    const unknown = this.files.filter(f => f.properties?.bbtKind === 'event' && !known.has(f.id));
    const incoming = new Array(unknown.length); let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, unknown.length) }, async () => {
      while (index < unknown.length) {
        const slot = index++; incoming[slot] = await this.drive.read(unknown[slot].id);
        if (incoming[slot]?.id !== unknown[slot].properties?.bbtOp) throw new Error('雲端異動檔的識別資訊不一致，已停止同步');
      }
    }));
    await this.repo.merge(this.key, this.dataset, incoming, unknown.map(f => f.id));
  }
  sync({ backup = true } = {}) {
    if (this.running) return this.running;
    const run = async () => {
      this.onStatus('syncing');
      try {
        await this.pull();
        let ws = await this.repo.read(this.key, this.dataset);
        const uploadedIds = new Map(this.files.filter(f => f.properties?.bbtKind === 'event').map(f => [f.properties.bbtOp, f.id]));
        for (const eventId of [...ws.outbox]) {
          const event = ws.events.find(e => e.id === eventId);
          if (!event) throw new Error('待上傳異動缺少內容，已停止同步');
          if (uploadedIds.has(eventId)) { await this.repo.ack(this.key, this.dataset, eventId, uploadedIds.get(eventId)); continue; }
          const id = await this.repo.reserve(this.key, this.dataset, eventId, () => this.drive.reserveId());
          const file = await this.drive.create(id, event, { bbtKind: 'event', bbtOp: event.id });
          this.files.push(file); uploadedIds.set(eventId, id); await this.repo.ack(this.key, this.dataset, eventId, id);
        }
        await this.pull();
        ws = await this.repo.read(this.key, this.dataset);
        const view = project(ws.events);
        if (backup && ws.events.length && !ws.outbox.length && !view.conflicts.length && !view.stale.length && !view.restoreConflict) await this.backup();
        await this.repo.update(this.key, this.dataset, state => { state.lastSync = new Date().toISOString(); state.lastError = ''; return state; });
        this.onStatus('done'); return await this.repo.read(this.key, this.dataset);
      } catch (e) {
        await this.repo.update(this.key, this.dataset, state => { state.lastError = e.message; return state; });
        this.onStatus('error', e); throw e;
      }
    };
    this.running = (globalThis.navigator?.locks ? navigator.locks.request(`bbt-sync:${this.key}`, run) : run()).finally(() => { this.running = null; });
    return this.running;
  }
  async backup({ force = false, label = '自動備份' } = {}) {
    const ws = await this.repo.read(this.key, this.dataset);
    if (ws.outbox.length) throw new Error('尚有待上傳資料，請先完成同步');
    const signature = await digest([...ws.events.map(e => e.id)].sort().join('|'));
    const existing = backupFiles(this.files).find(f => f.properties?.bbtState === signature);
    if (existing && !force) return existing;
    const operation = force ? `backup:${signature}:${crypto.randomUUID()}` : `backup:${signature}`;
    // Persist the exact payload before uploading: retries with an allocated file ID must be byte-equivalent.
    let payload;
    const saved = await this.repo.kv.get(`backup-payload:${this.key}:${operation}`);
    if (saved) payload = saved;
    else { payload = { ...snapshot(ws.events, this.dataset), label }; await this.repo.kv.set(`backup-payload:${this.key}:${operation}`, payload); }
    const id = await this.repo.reserve(this.key, this.dataset, operation, () => this.drive.reserveId());
    const file = await this.drive.create(id, payload, { bbtKind: 'backup', bbtState: signature, bbtDays: String(payload.stats.days), bbtRecords: String(payload.stats.records), bbtStart: payload.stats.start, bbtEnd: payload.stats.end });
    this.files.push(file);
    await this.repo.update(this.key, this.dataset, state => { state.lastBackupSignature = signature; delete state.uploads[operation]; return state; });
    await this.repo.kv.set(`backup-payload:${this.key}:${operation}`, null);
    return file;
  }
  async readBackup(id) {
    if (!this.files.some(f => f.id === id && f.properties?.bbtKind === 'backup')) throw new Error('此備份不屬於目前資料夾');
    return validateSnapshot(await this.drive.read(id), this.dataset);
  }
}
