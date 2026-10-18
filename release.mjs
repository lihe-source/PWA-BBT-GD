/* Maintenance helper: node release.mjs 1.0.1 */
import { readFile, writeFile } from 'node:fs/promises';
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next || '')) { console.error('用法：node release.mjs 1.0.1'); process.exit(1); }
const root = new URL('./', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const old = pkg.version;
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
if (compare(next, old) <= 0) { console.error(`新版本必須高於目前的 ${old}`); process.exit(1); }
const outputs = new Map();
for (const file of ['core.js', 'sw.js']) {
  const text = await readFile(new URL(file, root), 'utf8');
  if (!text.includes(`const VERSION = '${old}'`)) throw new Error(`${file} 的版本不同步，請先檢查`);
  outputs.set(file, text.replace(`const VERSION = '${old}'`, `const VERSION = '${next}'`));
}
pkg.version = next; outputs.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
const version = JSON.parse(await readFile(new URL('version.json', root), 'utf8'));
version.version = next; version.build = new Date().toISOString(); version.notes = `更新至 ${next}`; outputs.set('version.json', JSON.stringify(version, null, 2) + '\n');
const html = await readFile(new URL('index.html', root), 'utf8'); outputs.set('index.html', html.replaceAll(`v${old}`, `v${next}`).replaceAll(`V${old}`, `V${next}`).replace(`id="current-version">${old}`, `id="current-version">${next}`));
for (const [file, text] of outputs) await writeFile(new URL(file, root), text);
console.log(`版本已由 ${old} 更新為 ${next}。請執行 npm test，並將完整程式檔案一起上傳。`);
