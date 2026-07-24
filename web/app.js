'use strict';

/* arbhar library editor — front-end. Vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);

// Name the OS file manager in UI hints (Finder / File Explorer / …).
(() => {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  const name = /win/i.test(p) ? 'File Explorer' : /mac/i.test(p) ? 'Finder' : 'your file manager';
  document.querySelectorAll('.file-mgr').forEach((el) => { el.textContent = name; });
})();
// Default reserve hint (captured after the file-manager name is filled in).
const RESERVE_HINT_DEFAULT = document.querySelector('.staging-drop-hint').innerHTML;

/* ===================== File System Access data layer =====================
 * No server: the browser reads/writes the chosen folders directly.
 * `api.get/post` keep the exact shapes the old Node server returned, so the
 * rendering/editor/drag-drop code below is unchanged.
 */
let rootHandle = null;      // the arbhar library root
let reserveHandle = null;   // the reserve folder (optional)

const RESERVE_TRASH = null; // web undo is in-memory (bytes kept in the restore token)

function extOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i); }
function baseOf(p) { return p.slice(p.lastIndexOf('/') + 1); }
// Strip all whitespace from a filename stem (arbhar library files use spaceless CamelCase names).
function cleanStem(s) { return s.replace(/\s+/g, ''); }
function slotRelPath(kind, lib, bank, cell) {
  return kind === 'scene' ? `_arbhar_scenes/${bank}_${cell}_scene`
    : `${LIB_FOLDERS[(lib || 1) - 1]}/${bank}_${cell}_sample`;
}

// Parse a WAV header (first bytes) → { sampleRate, bits, channels } | null
function wavInfo(buf) {
  try {
    const v = new DataView(buf);
    const s = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (v.byteLength < 44 || s(0) !== 'RIFF') return null;
    let off = 12;
    while (off + 8 <= v.byteLength) {
      const id = s(off), size = v.getUint32(off + 4, true);
      if (id === 'fmt ') return { channels: v.getUint16(off + 10, true), sampleRate: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
      off += 8 + size + (size % 2);
    }
  } catch { /* ignore */ }
  return null;
}

async function dirByPath(root, p, create = false) {
  let h = root;
  for (const seg of String(p || '').split('/').filter(Boolean)) h = await h.getDirectoryHandle(seg, { create });
  return h;
}
async function tryDir(root, p) { try { return await dirByPath(root, p, false); } catch { return null; } }
async function fileAt(root, rel) {
  const i = rel.lastIndexOf('/');
  const dir = await dirByPath(root, i < 0 ? '' : rel.slice(0, i), false);
  const fh = await dir.getFileHandle(i < 0 ? rel : rel.slice(i + 1));
  return fh.getFile();
}
const fileByRootRel = (rel) => fileAt(rootHandle, rel);
const fileByReservePath = (rel) => fileAt(reserveHandle, rel);

async function writeBytes(scope, rel, bytes) {
  const root = scope === 'reserve' ? reserveHandle : rootHandle;
  const i = rel.lastIndexOf('/');
  const dir = await dirByPath(root, i < 0 ? '' : rel.slice(0, i), true);
  const fh = await dir.getFileHandle(i < 0 ? rel : rel.slice(i + 1), { create: true });
  const w = await fh.createWritable(); await w.write(bytes); await w.close();
}
async function removeAt(scope, rel) {
  const root = scope === 'reserve' ? reserveHandle : rootHandle;
  const i = rel.lastIndexOf('/');
  const dir = await dirByPath(root, i < 0 ? '' : rel.slice(0, i), false);
  await dir.removeEntry(i < 0 ? rel : rel.slice(i + 1), { recursive: true });
}
async function hasEntry(dir, name) { try { await dir.getFileHandle(name); return true; } catch { return false; } }
async function uniqueName(dir, name) {
  const ext = extOf(name), stem = name.slice(0, name.length - ext.length);
  let cand = name, n = 2;
  while (await hasEntry(dir, cand)) { cand = `${stem}_${n}${ext}`; n++; }
  return cand;
}
async function listAudio(dir) {
  const out = [];
  if (!dir) return out;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || name.startsWith('.') || !AUDIO_RE.test(name)) continue;
    const f = await h.getFile();
    let info = null;
    if (/\.wav$/i.test(name)) { try { info = wavInfo(await f.slice(0, 8192).arrayBuffer()); } catch { /* */ } }
    out.push({ name, size: f.size, info });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}
async function nextIndex(dir) {
  let max = 0;
  for (const f of await listAudio(dir)) { const m = f.name.match(/^(\d+)_/); if (m) max = Math.max(max, +m[1]); }
  return max + 1;
}
async function clearAudio(dir, prefix) {
  for (const f of await listAudio(dir)) {
    if (!prefix || new RegExp(`^${prefix}_`).test(f.name)) await dir.removeEntry(f.name);
  }
}
async function copyInto(src, destDir, newName) {
  if (src.kind === 'file') {
    const f = await src.getFile();
    const fh = await destDir.getFileHandle(newName, { create: true });
    const w = await fh.createWritable(); await w.write(await f.arrayBuffer()); await w.close();
  } else {
    const nd = await destDir.getDirectoryHandle(newName, { create: true });
    for await (const [n, h] of src.entries()) await copyInto(h, nd, n);
  }
}

// ---- endpoint implementations (return the server's JSON shapes) ----
async function apiGrid(kind, lib) {
  const cells = [];
  for (let bank = 1; bank <= 6; bank++) for (let cell = 1; cell <= 6; cell++) {
    const dir = await tryDir(rootHandle, slotRelPath(kind, lib, bank, cell));
    const files = dir ? await listAudio(dir) : [];
    const slot = { bank, cell, files, exists: !!dir };
    if (kind === 'scene') slot.hasPreset = dir ? !!(await findPresetName(dir)) : false;
    cells.push(slot);
  }
  return { kind, lib, cells };
}
async function apiStagingList(p) {
  if (!reserveHandle) return { entries: [], parent: null, noReserve: true };
  const dir = await tryDir(reserveHandle, p);
  const dirs = [], files = [];
  if (dir) for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') dirs.push(name);
    else if (AUDIO_RE.test(name)) { const f = await h.getFile(); files.push({ name, isDir: false, size: f.size, info: /\.wav$/i.test(name) ? wavInfo(await f.slice(0, 8192).arrayBuffer()) : null }); }
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const entries = [...dirs.map((n) => ({ name: n, isDir: true })), ...files];
  const parent = p === '' ? null : (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  return { entries, parent };
}
async function apiCopyFromStaging(b) {
  const srcFile = await fileByReservePath(b.path);
  const dir = await dirByPath(rootHandle, slotRelPath(b.kind, b.lib, b.bank, b.cell), true);
  const stem = cleanStem(baseOf(b.path).replace(/^\d+_/, '').replace(/\.[^.]+$/, ''));
  const ing = await ingest(await srcFile.arrayBuffer(), `${stem}${extOf(b.path)}`);
  const ext = extOf(ing.name);
  let name;
  if (b.kind === 'scene' && b.layer) { await clearAudio(dir, b.layer); name = `${b.layer}_${stem}${ext}`; }
  else if (b.replace) { await clearAudio(dir); name = `1_${stem}${ext}`; }
  else { name = `${await nextIndex(dir)}_${stem}${ext}`; }
  name = await uniqueName(dir, name);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(ing.bytes); await w.close();
  return { ok: true, name };
}
async function apiCopyToStaging(b) {
  const f = await fileByRootRel(b.rel);
  const dir = await dirByPath(reserveHandle, b.to || '', true);
  const ext = extOf(b.rel), stem = baseOf(b.rel).replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
  const name = await uniqueName(dir, `${stem}${ext}`);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(await f.arrayBuffer()); await w.close();
  return { ok: true, name };
}
async function apiFillScene(b) {
  const srcDir = await tryDir(reserveHandle, b.folder);
  if (!srcDir) throw new Error('Folder not found.');
  const files = (await listAudio(srcDir)).slice(0, 6);
  if (!files.length) throw new Error('No audio in that folder.');
  const dir = await dirByPath(rootHandle, slotRelPath('scene', 1, b.bank, b.cell), true);
  const restore = [];
  for (const f of await listAudio(dir)) {
    const rel = `${slotRelPath('scene', 1, b.bank, b.cell)}/${f.name}`;
    restore.push({ scope: 'root', rel, bytes: await (await fileByRootRel(rel)).arrayBuffer() });
    await dir.removeEntry(f.name);
  }
  let layer = 1;
  for (const f of files) {
    const stem = cleanStem(f.name.replace(/^\d+_/, '').replace(/\.[^.]+$/, ''));
    const ing = await ingest(await (await srcDir.getFileHandle(f.name)).getFile().then((x) => x.arrayBuffer()), `${stem}${extOf(f.name)}`);
    const name = await uniqueName(dir, `${layer}_${stem}${extOf(ing.name)}`);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(ing.bytes); await w.close();
    layer++;
  }
  return { ok: true, count: files.length, restore };
}
async function apiRename(b) {
  const dir = await dirByPath(rootHandle, slotRelPath(b.kind, b.lib, b.bank, b.cell), false);
  const ext = extOf(b.from), pref = (b.from.match(/^(\d+_)/) || ['', ''])[1];
  const stem = cleanStem(String(b.to).replace(/\.[^.]+$/, '').replace(/^\d+_/, ''));
  const name = await uniqueName(dir, `${pref}${stem}${ext}`);
  const bytes = await (await dir.getFileHandle(b.from)).getFile().then((f) => f.arrayBuffer());
  const nh = await dir.getFileHandle(name, { create: true });
  const w = await nh.createWritable(); await w.write(bytes); await w.close();
  await dir.removeEntry(b.from);
  return { ok: true, name };
}
async function apiDelete(b) {
  const scope = b.staging ? 'reserve' : 'root';
  const rel = b.staging ? b.path : `${slotRelPath(b.kind, b.lib, b.bank, b.cell)}/${b.name}`;
  let bytes = null;
  try { bytes = await (scope === 'reserve' ? fileByReservePath(rel) : fileByRootRel(rel)).then((f) => f.arrayBuffer()); }
  catch { bytes = null; }           // a folder → no in-memory undo
  await removeAt(scope, rel);
  return { ok: true, restore: bytes ? { scope, rel, bytes } : null };
}
async function apiClearSlot(b) {
  const dir = await dirByPath(rootHandle, slotRelPath(b.kind, b.lib, b.bank, b.cell), true);
  const restore = [];
  for (const f of await listAudio(dir)) {
    const rel = `${slotRelPath(b.kind, b.lib, b.bank, b.cell)}/${f.name}`;
    restore.push({ scope: 'root', rel, bytes: await (await fileByRootRel(rel)).arrayBuffer() });
    await dir.removeEntry(f.name);
  }
  return { ok: true, restore };
}
async function apiRestore(b) {
  for (const it of (b.items || []).filter(Boolean)) await writeBytes(it.scope, it.rel, it.bytes);
  return { ok: true };
}
async function apiMkdir(b) {
  const parent = await dirByPath(reserveHandle, b.path || '', true);
  await parent.getDirectoryHandle(String(b.name).trim(), { create: true });
  return { ok: true };
}
async function apiMove(b) {
  const srcParentPath = b.from.includes('/') ? b.from.slice(0, b.from.lastIndexOf('/')) : '';
  const srcName = baseOf(b.from);
  const srcParent = await dirByPath(reserveHandle, srcParentPath, false);
  const src = await srcParent.getDirectoryHandle(srcName).catch(() => srcParent.getFileHandle(srcName));
  const destDir = await dirByPath(reserveHandle, b.to || '', true);
  if (srcParentPath === (b.to || '')) return { ok: true, moved: false };   // already there
  await copyInto(src, destDir, await uniqueName(destDir, srcName));
  await srcParent.removeEntry(srcName, { recursive: true });
  return { ok: true, moved: true };
}

// Read every audio file of a slot folder as {name, bytes}.
async function readSlotAudio(dir) {
  const out = [];
  for (const f of await listAudio(dir)) {
    out.push({ name: f.name, bytes: await (await dir.getFileHandle(f.name)).getFile().then((x) => x.arrayBuffer()) });
  }
  return out;
}
// Swap the audio content of two library slots (all files, names kept — indices are slot-local).
async function apiSwapSlots(b) {
  const dirA = await dirByPath(rootHandle, slotRelPath(b.kind, b.lib, b.a.bank, b.a.cell), true);
  const dirB = await dirByPath(rootHandle, slotRelPath(b.kind, b.lib, b.b.bank, b.b.cell), true);
  const filesA = await readSlotAudio(dirA), filesB = await readSlotAudio(dirB);
  for (const f of filesA) await dirA.removeEntry(f.name);
  for (const f of filesB) await dirB.removeEntry(f.name);
  for (const f of filesB) { const h = await dirA.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.bytes); await w.close(); }
  for (const f of filesA) { const h = await dirB.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.bytes); await w.close(); }
  return { ok: true };
}
// Swap two layers within one scene folder (re-index the numeric prefix; preset.txt untouched).
async function apiSwapLayers(b) {
  const dir = await dirByPath(rootHandle, slotRelPath('scene', 1, b.bank, b.cell), true);
  const files = await listAudio(dir);
  const pick = (n) => files.find((f) => new RegExp(`^${n}_`).test(f.name)) || null;
  const read = async (f) => (f ? { name: f.name, bytes: await (await dir.getFileHandle(f.name)).getFile().then((x) => x.arrayBuffer()) } : null);
  const A = await read(pick(b.a)), B = await read(pick(b.b));
  const reindex = (name, n) => name.replace(/^\d+_/, `${n}_`);
  if (A) await dir.removeEntry(A.name);
  if (B) await dir.removeEntry(B.name);
  if (A) { const nm = reindex(A.name, b.b); const h = await dir.getFileHandle(nm, { create: true }); const w = await h.createWritable(); await w.write(A.bytes); await w.close(); }
  if (B) { const nm = reindex(B.name, b.a); const h = await dir.getFileHandle(nm, { create: true }); const w = await h.createWritable(); await w.write(B.bytes); await w.close(); }
  return { ok: true };
}
// Exchange all files (audio + preset.txt) between two folders.
async function swapDirContents(pathA, pathB) {
  const dirA = await dirByPath(rootHandle, pathA, true);
  const dirB = await dirByPath(rootHandle, pathB, true);
  const grab = async (dir) => {
    const out = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && !name.startsWith('.')) out.push({ name, bytes: await (await h.getFile()).arrayBuffer() });
    return out;
  };
  const A = await grab(dirA), B = await grab(dirB);
  for (const f of A) await dirA.removeEntry(f.name);
  for (const f of B) await dirB.removeEntry(f.name);
  for (const f of B) { const h = await dirA.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.bytes); await w.close(); }
  for (const f of A) { const h = await dirB.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.bytes); await w.close(); }
}
// Swap two scenes within a bank (whole folders).
async function apiSwapScenes(b) {
  await swapDirContents(`_arbhar_scenes/${b.bank}_${b.a}_scene`, `_arbhar_scenes/${b.bank}_${b.b}_scene`);
  return { ok: true };
}
// Swap two banks: exchange all 6 scenes between them.
async function apiSwapBanks(b) {
  for (let s = 1; s <= 6; s++) await swapDirContents(`_arbhar_scenes/${b.a}_${s}_scene`, `_arbhar_scenes/${b.b}_${s}_scene`);
  return { ok: true };
}
// Reindex a slot's files to the given order (rewrites the N_ prefixes = the load order).
async function apiReorderSlot(b) {
  const dir = await dirByPath(rootHandle, slotRelPath(b.kind, b.lib, b.bank, b.cell), true);
  const bytes = new Map();
  for (const f of await listAudio(dir)) bytes.set(f.name, await (await dir.getFileHandle(f.name)).getFile().then((x) => x.arrayBuffer()));
  for (const name of bytes.keys()) await dir.removeEntry(name);
  let i = 1;
  for (const name of b.order) {
    if (!bytes.has(name)) continue;
    const nn = `${i}_${name.replace(/^\d+_/, '')}`; i++;
    const h = await dir.getFileHandle(nn, { create: true });
    const w = await h.createWritable(); await w.write(bytes.get(name)); await w.close();
  }
  return { ok: true };
}

const api = {
  async get(url) {
    const [path, qs] = url.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs || ''));
    if (path === '/api/grid') return apiGrid(q.kind === 'scene' ? 'scene' : 'library', parseInt(q.lib || '1', 10));
    if (path === '/api/staging') return apiStagingList(q.path || '');
    throw new Error('Unknown GET ' + path);
  },
  async post(url, body) {
    const path = url.split('?')[0];
    const map = {
      '/api/copy-from-staging': apiCopyFromStaging, '/api/copy-to-staging': apiCopyToStaging,
      '/api/fill-scene': apiFillScene, '/api/rename': apiRename, '/api/delete': apiDelete,
      '/api/clear-slot': apiClearSlot, '/api/restore': apiRestore,
      '/api/staging/mkdir': apiMkdir, '/api/staging/move': apiMove,
      '/api/swap-slots': apiSwapSlots, '/api/swap-layers': apiSwapLayers,
      '/api/swap-scenes': apiSwapScenes, '/api/swap-banks': apiSwapBanks,
      '/api/reorder-slot': apiReorderSlot,
    };
    if (map[path]) return map[path](body);
    throw new Error('Unknown POST ' + path);
  },
};

// ---- persist the chosen folders across sessions (IndexedDB) ----
const idb = {
  db: null,
  open() { return this.db || (this.db = new Promise((res, rej) => { const r = indexedDB.open('arbhar', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('handles', 'readwrite'); t.objectStore('handles').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('handles', 'readonly'); const rq = t.objectStore('handles').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); },
};

const state = {
  root: null,
  present: {},
  kind: 'library',   // 'library' | 'scene'
  lib: 1,            // 1..6 (library index)
  cells: [],
  selected: null,    // {bank, cell}  (library grid)
  sceneBank: 1,      // scenes: selected bank 1..6
  sceneCell: 1,      // scenes: selected scene 1..6
  sceneLayer: 1,     // scenes: selected layer tile 1..6
  sceneTab: 'layers', // scenes sub-view: 'layers' | 'preset'
  expanded: new Set(), // expanded folder paths in the reserve tree
};

function toast(msg, isErr = false, undo = null) {
  const t = $('#toast');
  t.textContent = msg;
  if (undo) {
    const b = document.createElement('button');
    b.className = 'toast-undo';
    b.textContent = 'Undo';
    b.onclick = () => { t.classList.add('hidden'); undo(); };
    t.appendChild(b);
  }
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), undo ? 6000 : 2600);
}

async function undoRestore(restore) {
  const items = Array.isArray(restore) ? restore : [restore];
  try {
    await api.post('/api/restore', { items });
    await loadGrid();
    if (state.kind !== 'scene') renderInspector();
    toast('Restored.');
  } catch (e) { toast(e.message, true); }
}
function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'; }

/* ===================== FOLDER PICKER (File System Access) ===================== */
function setupStatus(msg, err) {
  const s = $('#setup-status'); s.textContent = msg; s.className = 'picker-status' + (err ? '' : ' good');
}
async function computePresent() {
  const present = {};
  for (const f of [...LIB_FOLDERS, '_arbhar_scenes']) present[f] = !!(await tryDir(rootHandle, f));
  return present;
}
async function ensurePermission(handle) {
  if (!handle || !handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function isBrave() {
  try { return !!(navigator.brave && await navigator.brave.isBrave()); } catch { return false; }
}

async function chooseRoot() {
  if (!window.showDirectoryPicker) { setupStatus('This browser lacks the File System Access API — use Chrome, Edge, or Brave (in Brave, enable it in brave://flags).', true); return; }
  try {
    rootHandle = await window.showDirectoryPicker({ id: 'arbhar-root', mode: 'readwrite' });
    await idb.set('root', rootHandle);
    state.present = await computePresent();
    $('#root-name').textContent = rootHandle.name; $('#root-name').classList.add('set');
    if (Object.values(state.present).some(Boolean)) setupStatus('◆ arbhar structure detected — ready.', false);
    else setupStatus('⚠︎ No _arbhar_* folders here — pick the folder that contains them.', true);
    $('#enter').disabled = false;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
}
async function chooseReserve() {
  if (!window.showDirectoryPicker) return;
  try {
    reserveHandle = await window.showDirectoryPicker({ id: 'arbhar-reserve', mode: 'readwrite' });
    await idb.set('reserve', reserveHandle);
    $('#reserve-name').textContent = reserveHandle.name; $('#reserve-name').classList.add('set');
    if (!$('#app').classList.contains('hidden')) loadStaging();
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
}
$('#pick-root').onclick = chooseRoot;
$('#pick-reserve').onclick = chooseReserve;
$('#stg-open').onclick = chooseReserve;   // pick / change the reserve folder from inside the app
// (#enter handler is wired in boot() so it can re-grant folder permission first)

// Auto-convert dropped audio to 48 kHz / 24-bit (opt-in, persisted).
let autoConvert = localStorage.getItem('arbhar-autoconv') === '1';
$('#autoconv').checked = autoConvert;
$('#autoconv').onchange = (e) => { autoConvert = e.target.checked; localStorage.setItem('arbhar-autoconv', autoConvert ? '1' : '0'); };

/* ===================== APP ===================== */
function enterApp() {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const name = rootHandle ? rootHandle.name : '';
  state.root = name;
  $('#root-path').textContent = name;
  $('#root-path').title = 'Selected library folder: ' + name + '\n(browsers show the folder/volume name only, not the full path)';
  buildTabs();
  loadStaging();
  selectTab('library', 1);
}

$('#change-root').onclick = () => {
  stopPlayback();
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#pk-close').classList.remove('hidden');
  $('#enter').disabled = !rootHandle;
};

// Close the picker and return to the current library (only shown when one is open).
$('#pk-close').onclick = () => {
  if (!rootHandle) return;
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
};

function buildTabs() {
  const tabs = $('#lib-tabs');
  tabs.innerHTML = '';
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = 'Library ' + i;
    b.onclick = () => selectTab('library', i);
    b.dataset.key = 'library' + i;
    tabs.appendChild(b);
  }
  const s = document.createElement('button');
  s.className = 'tab scenes';
  s.textContent = 'Scenes';
  s.onclick = () => selectTab('scene', 1);
  s.dataset.key = 'scene';
  tabs.appendChild(s);
}

async function selectTab(kind, lib) {
  state.kind = kind; state.lib = lib; state.selected = null;
  stopPlayback();                         // leaving a tab stops its audio
  clearEditor();
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  const key = kind === 'scene' ? 'scene' : 'library' + lib;
  const el = document.querySelector(`.tab[data-key="${key}"]`);
  if (el) el.classList.add('active');
  // Toggle the two center views + drop the inspector column in scenes mode.
  document.querySelector('.workspace').classList.toggle('scenes-mode', kind === 'scene');
  $('#grid').classList.toggle('hidden', kind === 'scene');
  $('#scene-view').classList.toggle('hidden', kind !== 'scene');
  await loadGrid();
}

async function loadGrid() {
  const q = `/api/grid?kind=${state.kind}&lib=${state.lib}`;
  const data = await api.get(q);
  state.cells = data.cells;
  renderCurrent();
}

// Render whichever center view matches the active tab.
function renderCurrent() {
  renderBanner();
  if (state.kind === 'scene') { renderSceneView(); }
  else { renderGrid(); renderInspector(); }
}

// Shared warning banner when the tab's backing folder is missing at the root.
function renderBanner() {
  const banner = $('#grid-banner');
  const folder = currentFolderName();
  if (state.present && state.present[folder] === false) {
    banner.innerHTML = `⚠︎ Folder <code>${folder}</code> does not exist in the chosen root
      (<span>${escapeHtml(state.root || '')}</span>).<br />
      You may have opened the wrong folder level, or this library does not exist here.
      <button id="banner-change" class="btn sm">Change folder</button>`;
    banner.classList.remove('hidden');
    const b = $('#banner-change'); if (b) b.onclick = () => $('#change-root').click();
  } else {
    banner.classList.add('hidden');
  }
}

function cellAt(bank, cell) { return state.cells.find((c) => c.bank === bank && c.cell === cell); }

const LIB_FOLDERS = ['_arbhar_library', '_arbhar_library_2', '_arbhar_library_3', '_arbhar_library_4', '_arbhar_library_5', '_arbhar_library_6'];
function currentFolderName() { return state.kind === 'scene' ? '_arbhar_scenes' : LIB_FOLDERS[state.lib - 1]; }

function renderGrid() {
  $('#grid-title').textContent = 'Library ' + state.lib;
  const grid = $('#grid');
  grid.innerHTML = '';
  for (let bank = 1; bank <= 6; bank++) {
    for (let cell = 1; cell <= 6; cell++) {
      const c = cellAt(bank, cell) || { bank, cell, files: [] };
      const pad = document.createElement('div');
      const filled = c.files.length > 0;
      pad.className = 'pad' + (filled ? ' filled' : ' empty');
      if (state.selected && state.selected.bank === bank && state.selected.cell === cell) pad.classList.add('selected');
      const label = filled ? prettyName(c.files[0].name) : '— empty —';
      const count = c.files.length > 1 ? `<span class="pad-count">${c.files.length} samples</span>` : '';
      pad.innerHTML = `<span class="pad-id">${bank}.${cell}</span>
        <span class="pad-name">${escapeHtml(label)}</span>${count}`;
      pad.onclick = () => selectSlot(bank, cell);
      if (filled) {
        const del = document.createElement('button');
        del.className = 'tile-del'; del.title = 'Clear slot'; del.textContent = '✕';
        del.onclick = (e) => { e.stopPropagation(); clearSlotWithUndo(bank, cell); };
        pad.appendChild(del);
        // Drag a filled pad out to the reserve (copies its first sample).
        pad.draggable = true;
        pad.addEventListener('dragstart', (e) => {
          const rel = slotRel(bank, cell) + '/' + c.files[0].name;
          e.dataTransfer.setData('application/x-arbhar-file', JSON.stringify({ path: rel, name: c.files[0].name, swap: { kind: state.kind, lib: state.lib, bank, cell } }));
          e.dataTransfer.effectAllowed = 'copyMove';
        });
      }
      wireExternalDrop(pad, { bank, cell });
      wireStagingDrop(pad, { bank, cell });
      wireSwapDrop(pad, { bank, cell });
      grid.appendChild(pad);
    }
  }
}

/* ---------- scenes view ---------- */
// The file whose numeric prefix maps to a scene layer (1..6).
function layerFile(cell, layer) {
  return (cell.files || []).find((f) => new RegExp(`^${layer}_`).test(f.name)) || null;
}

function selRow(label, active, onPick, filledFn, swap) {
  const row = document.createElement('div');
  row.className = 'sel-row';
  row.innerHTML = `<span class="sel-label">${label}</span>`;
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button');
    b.className = 'sel-btn' + (i === active ? ' active' : '') + (filledFn(i) ? ' filled' : '');
    b.textContent = i;
    b.onclick = () => onPick(i);
    if (swap) {                                     // drag one selector onto another to swap them
      b.draggable = true;
      b.title = `drag onto another ${swap.type} to swap`;
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-arbhar-sel', JSON.stringify({ type: swap.type, index: i }));
        e.dataTransfer.effectAllowed = 'move';
      });
      b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-arbhar-sel')) { e.preventDefault(); b.classList.add('over'); } });
      b.addEventListener('dragleave', () => b.classList.remove('over'));
      b.addEventListener('drop', (e) => {
        b.classList.remove('over');
        const d = e.dataTransfer.getData('application/x-arbhar-sel');
        if (!d) return;
        let it; try { it = JSON.parse(d); } catch { return; }
        if (it.type !== swap.type || it.index === i) return;
        e.preventDefault(); e.stopPropagation();
        swap.onSwap(it.index, i);
      });
    }
    row.appendChild(b);
  }
  return row;
}

function renderSceneView() {
  $('#grid-title').textContent = `Scene ${state.sceneBank}.${state.sceneCell}`;
  const cur = cellAt(state.sceneBank, state.sceneCell) || { files: [] };
  const bankFilled = (b) => state.cells.some((c) => c.bank === b && c.files.length);
  const sceneFilled = (s) => { const c = cellAt(state.sceneBank, s); return !!(c && c.files.length); };

  const controls = $('#scene-controls');
  controls.innerHTML = '';
  controls.appendChild(selRow('Bank', state.sceneBank, (v) => { stopPlayback(); clearEditor(); state.sceneBank = v; state.sceneLayer = 1; renderSceneView(); }, bankFilled, { type: 'bank', onSwap: swapBanks }));
  controls.appendChild(selRow('Scene', state.sceneCell, (v) => { stopPlayback(); clearEditor(); state.sceneCell = v; state.sceneLayer = 1; renderSceneView(); }, sceneFilled, { type: 'scene', onSwap: swapScenes }));

  // Layers | Preset sub-tabs (both share the Bank+Scene selection above).
  const onPreset = state.sceneTab === 'preset';
  $('#sst-layers').classList.toggle('active', !onPreset);
  $('#sst-preset').classList.toggle('active', onPreset);
  $('#sst-preset').classList.toggle('has-preset', !!cur.hasPreset);
  $('#sst-clear').classList.toggle('hidden', onPreset || !cur.files.length);
  $('#scene-grid').classList.toggle('hidden', onPreset);
  $('#preset-panel').classList.toggle('hidden', !onPreset);
  if (onPreset) { renderPreset(); return; }

  const grid = $('#scene-grid');
  grid.innerHTML = '';
  for (let L = 1; L <= 6; L++) {
    const f = layerFile(cur, L);
    const tile = document.createElement('div');
    tile.className = 'layer-tile' + (f ? '' : ' empty') + (state.sceneLayer === L ? ' selected' : '');
    const info = f && f.info ? `${(f.info.sampleRate / 1000).toFixed(f.info.sampleRate % 1000 ? 1 : 0)}k · ${f.info.bits}bit` : '';
    tile.innerHTML = `
      <div class="lt-head">
        <span class="lt-layer">LAYER ${L}</span>
        <span class="lt-actions">${f ? '<button class="mini rn" title="Rename">✎</button><button class="mini del" title="Delete">✕</button>' : ''}</span>
      </div>
      <div class="lt-name">${f ? escapeHtml(prettyName(f.name)) : '— empty —'}</div>
      <div class="lt-meta">${f ? (info ? info + ' · ' : '') + fmtSize(f.size) : 'drop a .wav here'}</div>`;
    tile.onclick = () => selectLayer(L);
    if (f) {
      tile.querySelector('.rn').onclick = (e) => { e.stopPropagation(); startRename(tile, f, state.sceneBank, state.sceneCell); };
      tile.querySelector('.del').onclick = (e) => { e.stopPropagation(); deleteFile(f, state.sceneBank, state.sceneCell); };
      tile.draggable = true;
      tile.addEventListener('dragstart', (e) => {
        const rel = slotRel(state.sceneBank, state.sceneCell) + '/' + f.name;
        e.dataTransfer.setData('application/x-arbhar-file', JSON.stringify({ path: rel, name: f.name, swapLayer: { bank: state.sceneBank, cell: state.sceneCell, layer: L } }));
        e.dataTransfer.effectAllowed = 'copyMove';
      });
    }
    wireLayerDrop(tile, L);
    grid.appendChild(tile);
  }
}

/* ===================== SCENE PRESET EDITOR (preset.txt) ===================== */
// A curated selection of the arbhar V2 preset parameters. Only these lines are
// patched in preset.txt; every other parameter and all documentation are kept as-is.
// All 24 arbhar V2 preset parameters (per the firmware 2.0 manual). Only these lines
// are patched in preset.txt; documentation and any other content is preserved.
const OFF_ON = [['0', 'Disable'], ['1', 'Enable']];
const PRESET_FIELDS = [
  { group: 'Identity' },
  { key: 'PRESET_NAME', label: 'Preset name', type: 'text', ph: '(optional)', full: true },
  { group: 'Loading' },
  { key: 'LoadConfiguration', label: 'Load configuration', type: 'select', opts: [['0', 'Load nothing'], ['1', 'Load preset'], ['2', 'Load layers'], ['3', 'Load scene (preset + layers)']] },
  { group: 'Input & routing' },
  { key: 'InputMode', label: 'Input mode', type: 'select', opts: [['0', 'Mono'], ['1', 'Stereo']] },
  { key: 'AnalogEmulation', label: 'Analogue emulation (Onset in)', type: 'select', opts: OFF_ON },
  { key: 'PhaseSwitch', label: 'Phase', type: 'select', opts: [['0', 'Phase-inverted'], ['1', 'Phase-corrected']] },
  { key: 'ModCV', label: 'Mod CV target', type: 'select', opts: [['0', 'None'], ['1', 'Panning'], ['2', 'Hold'], ['3', 'Reverb'], ['4', 'Delay']] },
  { group: 'Capture' },
  { key: 'CaptureCVMode', label: 'Capture CV mode', type: 'select', opts: [['0', 'Latching'], ['1', 'Momentary'], ['2', 'Retrigger']] },
  { key: 'CaptureButtonMode', label: 'Capture button mode', type: 'select', opts: [['0', 'Latching'], ['1', 'Momentary']] },
  { key: 'ActivateCaptureOnButtonUp', label: 'Capture on button up', type: 'select', opts: OFF_ON },
  { key: 'AccumulativeCaptureMode', label: 'Accumulative capture', type: 'select', opts: OFF_ON },
  { key: 'LinkAccumulativeRecordingCaptureAsGate', label: 'Link accumulative ↔ button mode', type: 'select', opts: OFF_ON },
  { group: 'Onset / Strike' },
  { key: 'OnsetMode', label: 'Onset mode', type: 'select', opts: [['1', 'alpha'], ['2', 'beta'], ['3', 'gamma'], ['4', 'delta'], ['5', 'epsilon'], ['6', 'zeta']] },
  { key: 'StrikeButtonToTrigger', label: 'Strike button → trigger out', type: 'select', opts: OFF_ON },
  { key: 'StrikeCVDelay', label: 'Strike input trigger delay', type: 'number', step: '1', min: '0', unit: 'ms' },
  { group: 'Grain randomisation' },
  { key: 'RandomTimingWithRandomIntensity', label: 'Random grain timing', type: 'select', opts: OFF_ON },
  { key: 'RandomAmpWithRandomIntensity', label: 'Random grain amplitude', type: 'select', opts: OFF_ON },
  { group: 'Follow / Scan' },
  { key: 'FollowMode', label: 'Follow mode', type: 'select', opts: [['0', 'Scan'], ['1', 'Follow']] },
  { key: 'FollowSpeedDirection', label: 'Follow speed direction', type: 'select', opts: [['0', 'Unidirectional'], ['1', 'Bidirectional'], ['2', 'Inverted unidirectional']] },
  { key: 'FollowScanOffset', label: 'Follow scan offset', type: 'number', step: '1', min: '0', unit: 'ms' },
  { key: 'FollowPositionOffsetWithScanCV', label: 'Scan CV in Follow', type: 'select', opts: [['0', 'Controls speed'], ['1', 'Controls offset']] },
  { key: 'FollowLoop', label: 'Follow loop', type: 'select', opts: OFF_ON },
  { key: 'FollowSetLoopLengthWithHold', label: 'Follow loop length = Hold', type: 'select', opts: OFF_ON },
  { group: 'Wavetable / Pitch' },
  { key: 'WavetableCentreFrequency', label: 'Wavetable centre freq', type: 'number', step: '0.001', min: '0', unit: 'Hz' },
  { key: 'QuantiseTable', label: 'Quantise table (semitone pairs)', type: 'text', full: true, ph: '1 -2 2 -1 3 -4 …' },
];

// Read the current value of a preset key, or null if absent. Leading whitespace tolerated.
function presetGet(text, key) {
  const re = key === 'PRESET_NAME'
    ? /^\s*PRESET_NAME:\s*"([^"]*)"/m
    : new RegExp(`^\\s*PARAMETER:\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = text.match(re);
  return m ? m[1] : null;
}
// Replace a value in place, preserving the line's exact prefix (indent + label). No-op if absent.
function presetSet(text, key, val) {
  if (key === 'PRESET_NAME') {
    return text.replace(/^(\s*PRESET_NAME:\s*).*$/m, (_, p1) => p1 + '"' + val + '"');
  }
  const re = new RegExp(`^(\\s*PARAMETER:\\s*${key}\\s*:\\s*).*$`, 'm');
  return text.replace(re, (_, p1) => p1 + val);
}

function sceneDirRel(bank, cell) { return `_arbhar_scenes/${bank}_${cell}_scene`; }

// The arbhar identifies a config by the #ARB header, not the file name — it may be
// preset.txt or a renamed one (arbharClassic.txt, MidSide.txt…). Return the config
// file name in a scene folder (any .txt starting with #ARB; preset.txt preferred), or null.
async function findPresetName(dir) {
  if (!dir) return null;
  const txts = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file' && !name.startsWith('.') && /\.txt$/i.test(name)) txts.push(name);
  }
  txts.sort((a, b) => (/^preset\.txt$/i.test(a) ? -1 : /^preset\.txt$/i.test(b) ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  for (const name of txts) {
    try {
      const head = await (await dir.getFileHandle(name)).getFile().then((f) => f.slice(0, 16).text());
      if (head.replace(/^\uFEFF/, '').trimStart().startsWith('#ARB')) return name;
    } catch { /* skip unreadable */ }
  }
  return null;
}

// Read the scene's config file → { name, text }; name is null when the scene has none yet.
async function readPresetFile(bank, cell) {
  const dir = await tryDir(rootHandle, sceneDirRel(bank, cell));
  const name = await findPresetName(dir);
  if (!name) return { name: null, text: null };
  try { const f = await dir.getFileHandle(name).then((h) => h.getFile()); return { name, text: await f.text() }; }
  catch { return { name: null, text: null }; }
}
let presetTemplate = null;
async function loadPresetTemplate() {
  if (presetTemplate != null) return presetTemplate;
  try { presetTemplate = await (await fetch('preset-template.txt')).text(); }
  catch { presetTemplate = '#ARB\n{\n}\n'; }
  return presetTemplate;
}

async function renderPreset() {
  const panel = $('#preset-panel');
  panel.innerHTML = '<p class="preset-loading">Loading preset…</p>';
  const bank = state.sceneBank, cell = state.sceneCell;
  const { name: cfgName, text: existingText } = await readPresetFile(bank, cell);
  const exists = existingText != null;
  const fileName = cfgName || 'preset.txt';           // create preset.txt when the scene has none
  const text = exists ? existingText : await loadPresetTemplate();
  // The user may have moved to another scene / sub-tab while we were reading.
  if (state.sceneBank !== bank || state.sceneCell !== cell || state.sceneTab !== 'preset') return;

  panel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'preset-head';
  head.innerHTML = exists
    ? `<span class="preset-status good">⬥ ${escapeHtml(fileName)} present — edited in place, other parameters preserved</span>`
    : '<span class="preset-status">no config file yet — Create will write preset.txt from the arbhar template</span>';
  panel.appendChild(head);

  // Straight from the manual: parameters only take effect if Load configuration = Load scene.
  const note = document.createElement('p');
  note.className = 'preset-loadhint';
  note.innerHTML = 'For the module to apply these parameters, set <b>Load configuration</b> to <b>Load scene</b> (preset + audio) or <b>Load preset</b> (preset only). Factory scenes ship as <b>Load layers</b>, which loads the audio but ignores the preset.';
  panel.appendChild(note);

  const form = document.createElement('div');
  form.className = 'preset-form';
  const inputs = {};
  for (const f of PRESET_FIELDS) {
    if (f.group) { const g = document.createElement('div'); g.className = 'preset-group'; g.textContent = f.group; form.appendChild(g); continue; }
    const row = document.createElement('label'); row.className = 'preset-field' + (f.full ? ' preset-field--full' : '');
    const lab = document.createElement('span'); lab.className = 'pf-label'; lab.textContent = f.label; row.appendChild(lab);
    const val = presetGet(text, f.key);
    let el;
    if (f.type === 'select') {
      el = document.createElement('select');
      for (const [v, l] of f.opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; el.appendChild(o); }
      if (val != null && !f.opts.some((o) => o[0] === val)) { const o = document.createElement('option'); o.value = val; o.textContent = val + ' (current)'; el.appendChild(o); }
      el.value = val != null ? val : f.opts[0][0];
    } else {
      el = document.createElement('input'); el.type = f.type === 'number' ? 'number' : 'text';
      if (f.step) el.step = f.step;
      if (f.min != null) el.min = f.min;
      if (f.ph) el.placeholder = f.ph;
      el.value = val != null ? val : '';
    }
    el.className = 'pf-input';
    const wrap = document.createElement('span'); wrap.className = 'pf-control'; wrap.appendChild(el);
    if (f.unit) { const u = document.createElement('span'); u.className = 'pf-unit'; u.textContent = f.unit; wrap.appendChild(u); }
    row.appendChild(wrap);
    form.appendChild(row);
    inputs[f.key] = el;
  }
  panel.appendChild(form);

  const actions = document.createElement('div'); actions.className = 'preset-actions';
  const hint = document.createElement('span'); hint.className = 'preset-hint';
  hint.textContent = 'Only the parameters above are changed; the rest of the file is left untouched.';
  const save = document.createElement('button'); save.className = 'btn sm primary'; save.textContent = exists ? 'Save preset' : 'Create preset';
  actions.appendChild(hint); actions.appendChild(save);
  panel.appendChild(actions);

  save.onclick = async () => {
    let out = text;
    for (const f of PRESET_FIELDS) {
      if (f.group) continue;
      const v = inputs[f.key].value.trim();
      if (f.key === 'PRESET_NAME') out = presetSet(out, f.key, v.replace(/"/g, "'"));
      else if (v !== '') out = presetSet(out, f.key, v);
    }
    try {
      await writeBytes('root', `${sceneDirRel(bank, cell)}/${fileName}`, new TextEncoder().encode(out));
      await loadGrid();                 // refresh hasPreset dot + re-render the panel from disk
      toast(exists ? `${fileName} saved ✓` : 'Preset created ✓');
    } catch (e) { toast(e.message, true); }
  };
}

// Sub-tab switching (wired once; the buttons live in the static markup).
$('#sst-layers').onclick = () => { if (state.sceneTab === 'layers') return; state.sceneTab = 'layers'; renderSceneView(); };
$('#sst-preset').onclick = () => { if (state.sceneTab === 'preset') return; state.sceneTab = 'preset'; stopPlayback(); renderSceneView(); };
$('#sst-clear').onclick = clearSceneLayers;

function selectLayer(layer, { play = true } = {}) {
  const cur = cellAt(state.sceneBank, state.sceneCell) || { files: [] };
  const f = layerFile(cur, layer);
  const relCur = f ? slotRel(state.sceneBank, state.sceneCell) + '/' + f.name : null;
  // Re-clicking the layer tile that is already playing pauses it (and vice-versa).
  if (play && relCur && toggledCurrent('/api/audio?path=' + encodeURIComponent(relCur))) return;
  state.sceneLayer = layer;
  renderSceneView();
  const sel = $('#scene-grid .layer-tile.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (f) {
    const rel = slotRel(state.sceneBank, state.sceneCell) + '/' + f.name;
    if (play) playAudio('/api/audio?path=' + encodeURIComponent(rel), `${state.sceneBank}.${state.sceneCell} · L${layer} · ${prettyName(f.name)}`, sel);
    setEditor(rel, f.name);
  } else {
    clearEditor();
    $('#insp-sub').textContent = `Layer ${layer} empty`;
  }
}

// Drop an external file or a staged sample onto a scene layer (replaces it).
function wireLayerDrop(el, layer) {
  el.addEventListener('dragover', (e) => {
    const t = e.dataTransfer.types;
    if (t.includes('Files') || t.includes('application/x-arbhar-staging') || t.includes('application/x-arbhar-file')) {
      e.preventDefault(); el.classList.add('over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('over');
    // Another layer tile dropped here → swap the two layers.
    const fileData = e.dataTransfer.getData('application/x-arbhar-file');
    if (fileData) {
      let item; try { item = JSON.parse(fileData); } catch { item = null; }
      if (item && item.swapLayer && item.swapLayer.bank === state.sceneBank && item.swapLayer.cell === state.sceneCell) {
        e.preventDefault(); e.stopPropagation();
        if (item.swapLayer.layer !== layer) await swapLayers(item.swapLayer.layer, layer);
        return;
      }
    }
    const stg = e.dataTransfer.getData('application/x-arbhar-staging');
    if (stg) {
      e.preventDefault(); e.stopPropagation();
      const item = JSON.parse(stg);
      if (item.isDir) { fillSceneFromFolder(item.path); return; }   // folder → fill the 6 layers
      try {
        await api.post('/api/copy-from-staging', { path: item.path, kind: 'scene', bank: state.sceneBank, cell: state.sceneCell, layer });
        toast(`Layer ${layer} ← “${item.name}”`); await loadGrid();
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault(); e.stopPropagation();
      const q = `dest=slot&kind=scene&bank=${state.sceneBank}&cell=${state.sceneCell}&layer=${layer}`;
      const n = await uploadFiles(e.dataTransfer.files, q);
      if (n) { toast(`Layer ${layer} imported.`); await loadGrid(); }
    }
  });
}

async function swapLayers(a, b) {
  const bank = state.sceneBank, cell = state.sceneCell;
  const body = { bank, cell, a, b };
  try {
    await api.post('/api/swap-layers', body);
    await loadGrid();
    selectLayer(b, { play: false });
    toast(`Swapped layer ${a} ↔ ${b}`, false, async () => {
      try { await api.post('/api/swap-layers', body); await loadGrid(); selectLayer(a, { play: false }); toast('Swap undone.'); }
      catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
}

async function swapScenes(a, b) {
  const bank = state.sceneBank, body = { bank, a, b };
  try {
    stopPlayback(); clearEditor();
    await api.post('/api/swap-scenes', body);
    await loadGrid();
    toast(`Swapped scene ${bank}.${a} ↔ ${bank}.${b}`, false, async () => {
      try { await api.post('/api/swap-scenes', body); await loadGrid(); toast('Swap undone.'); } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
}

async function swapBanks(a, b) {
  const body = { a, b };
  try {
    stopPlayback(); clearEditor();
    await api.post('/api/swap-banks', body);
    await loadGrid();
    toast(`Swapped bank ${a} ↔ bank ${b} (all scenes)`, false, async () => {
      try { await api.post('/api/swap-banks', body); await loadGrid(); toast('Swap undone.'); } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
}

// Empty all 6 layers of the current scene (audio only; preset.txt is preserved).
async function clearSceneLayers() {
  const bank = state.sceneBank, cell = state.sceneCell;
  const cur = cellAt(bank, cell);
  if (!cur || !cur.files.length) { toast('Scene already empty.'); return; }
  const n = cur.files.length;
  try {
    const r = await api.post('/api/clear-slot', { kind: 'scene', lib: 1, bank, cell });
    stopIfPlaying(slotRel(bank, cell), { folder: true });
    clearEditor();
    await loadGrid();
    toast(`Scene ${bank}.${cell} cleared (${n} layer${n > 1 ? 's' : ''}).`, false, () => undoRestore(r.restore));
  } catch (e) { toast(e.message, true); }
}

// Fill the current scene's 6 layers from a reserve folder's first 6 audio files.
async function fillSceneFromFolder(folderPath) {
  try {
    const r = await api.post('/api/fill-scene', { bank: state.sceneBank, cell: state.sceneCell, folder: folderPath });
    await loadGrid();
    state.sceneLayer = 1; renderSceneView();
    toast(`Scene ${state.sceneBank}.${state.sceneCell} filled (${r.count} layer${r.count > 1 ? 's' : ''}).`, false,
      () => undoRestore(r.restore));
  } catch (e) { toast(e.message, true); }
}

// Dropping a folder anywhere on the scene sub-grid fills the whole scene.
(function initSceneGridDrop() {
  const grid = $('#scene-grid');
  grid.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-arbhar-staging')) { e.preventDefault(); grid.classList.add('over'); }
  });
  grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('over'); });
  grid.addEventListener('drop', (e) => {
    grid.classList.remove('over');
    const stg = e.dataTransfer.getData('application/x-arbhar-staging');
    if (!stg) return;
    const item = JSON.parse(stg);
    if (!item.isDir) return;                 // single samples are handled by the layer tiles
    e.preventDefault();
    fillSceneFromFolder(item.path);
  });
})();

// Clear a whole slot (× on a pad) with an undo toast.
async function clearSlotWithUndo(bank, cell) {
  try {
    const r = await api.post('/api/clear-slot', { kind: state.kind, lib: state.lib, bank, cell });
    stopIfPlaying(slotRel(bank, cell), { folder: true });
    if (state.selected && state.selected.bank === bank && state.selected.cell === cell) {
      state.selected = null; clearEditor();
    }
    await loadGrid();
    toast(`Slot ${bank}.${cell} cleared.`, false, () => undoRestore(r.restore));
  } catch (e) { toast(e.message, true); }
}

// Select a slot (shared by click + keyboard) and audition its first sample.
function selectSlot(bank, cell, { play = true } = {}) {
  const cc = cellAt(bank, cell);
  const multi = !!(cc && cc.files.length > 1);
  const relFirst = cc && cc.files.length ? slotRel(bank, cell) + '/' + cc.files[0].name : null;
  // Re-clicking the tile that is already playing pauses it (combined key for a stack, file key for one).
  if (play) {
    const key = multi ? 'combined:' + slotRel(bank, cell) : '/api/audio?path=' + encodeURIComponent(relFirst);
    if (relFirst && toggledCurrent(key)) return;
  }
  state.selected = { bank, cell };
  renderGrid();
  renderInspector();
  const sel = $('#grid .pad.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (cc && cc.files.length) {
    if (multi) {
      setEditorCombined(bank, cell, cc.files, play);   // combined preview + chained playback
    } else {
      const first = cc.files[0];
      const rel = slotRel(bank, cell) + '/' + first.name;
      if (play) playAudio('/api/audio?path=' + encodeURIComponent(rel), prettyName(first.name), $('#insp-list .file-row'));
      setEditor(rel, first.name);
    }
  } else {
    clearEditor();
  }
}

function prettyName(fn) { return fn.replace(/^\d+_/, '').replace(/\.[^.]+$/, ''); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- inspector (library file list, under the editor) ---------- */
function renderInspector() {
  const empty = $('#insp-empty');
  const list = $('#insp-list');
  list.innerHTML = '';
  if (!state.selected) {
    empty.classList.remove('hidden');
    clearEditor();
    return;
  }
  empty.classList.add('hidden');
  const { bank, cell } = state.selected;
  const c = cellAt(bank, cell) || { files: [] };
  const rows = slotLoadRows(c.files);
  if (c.files.length > 1) {
    const loaded = rows.filter((r) => r.loads).length;
    const total = rows.filter((r) => r.loads).reduce((s, r) => s + (r.dur || 0), 0);
    const head = document.createElement('div');
    head.className = 'slot-stack-head';
    const ignored = c.files.length - loaded;
    head.innerHTML = `<span>Stacked layer · ${loaded}/${c.files.length} load · ~${total.toFixed(1)} s</span>`
      + (ignored ? `<span class="slot-stack-warn">${ignored} ignored (past 10 s)</span>` : '');
    list.appendChild(head);
  }
  rows.forEach((r) => list.appendChild(fileRow(r.f, bank, cell, { count: rows.length, loads: r.loads, dur: r.dur })));
  if (!c.files.length) {
    const p = document.createElement('p');
    p.className = 'empty-note'; p.style.marginTop = '20px';
    p.textContent = 'Empty slot. Drop a sample on the tile, or drag one from the reserve.';
    list.appendChild(p);
  }
}

function fileRow(f, bank, cell, ctx = {}) {
  const { count = 1, loads = true, dur = null } = ctx;
  const li = document.createElement('li');
  li.className = 'file-row' + (loads ? '' : ' ignored');
  li.draggable = true;
  const relPath = slotRel(bank, cell) + '/' + f.name;
  const info = f.info ? `${(f.info.sampleRate / 1000).toFixed(f.info.sampleRate % 1000 ? 1 : 0)}k · ${f.info.bits}bit · ${f.info.channels === 2 ? 'stereo' : 'mono'}` : '';
  const ideal = f.info && f.info.sampleRate === 48000 && f.info.bits === 24;
  const multi = count > 1;
  const durTxt = dur != null ? `${dur.toFixed(1)} s · ` : '';
  li.innerHTML = `<span class="play">▶</span>
    <div class="file-main">
      <div class="file-name">${escapeHtml(prettyName(f.name))}${loads || !multi ? '' : ' <span class="ignored-tag">ignored (past 10 s)</span>'}</div>
      <div class="file-meta">
        ${durTxt}${info ? `<span class="badge ${ideal ? 'ok' : ''}">${info}</span>` : ''}
        ${fmtSize(f.size)} · <span style="opacity:.6">${escapeHtml(f.name)}</span>
      </div>
    </div>
    <button class="mini rn" title="Rename">✎</button>
    <button class="mini del" title="Delete">✕</button>`;

  li.querySelector('.play').onclick = (e) => { e.stopPropagation(); playAudio('/api/audio?path=' + encodeURIComponent(relPath), prettyName(f.name), li); setEditor(relPath, f.name); };
  li.querySelector('.file-main').onclick = () => { playAudio('/api/audio?path=' + encodeURIComponent(relPath), prettyName(f.name), li); setEditor(relPath, f.name); };
  li.querySelector('.rn').onclick = (e) => { e.stopPropagation(); startRename(li, f, bank, cell); };
  li.querySelector('.del').onclick = (e) => { e.stopPropagation(); deleteFile(f, bank, cell); };

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-arbhar-file', JSON.stringify({ path: relPath, name: f.name, slotFile: { bank, cell, name: f.name } }));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  // Drag another file of the SAME slot onto this row → reorder.
  if (multi) {
    li.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-arbhar-file')) return;
      e.preventDefault(); li.classList.add('reorder-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('reorder-over'));
    li.addEventListener('drop', (e) => {
      li.classList.remove('reorder-over');
      const d = e.dataTransfer.getData('application/x-arbhar-file');
      if (!d) return;
      let it; try { it = JSON.parse(d); } catch { return; }
      if (!it.slotFile || it.slotFile.bank !== bank || it.slotFile.cell !== cell || it.slotFile.name === f.name) return;
      e.preventDefault(); e.stopPropagation();
      dropReorderSlot(bank, cell, it.slotFile.name, f.name);
    });
  }
  return li;
}

function slotRel(bank, cell) {
  if (state.kind === 'scene') return `_arbhar_scenes/${bank}_${cell}_scene`;
  return `${LIB_FOLDERS[state.lib - 1]}/${bank}_${cell}_sample`;
}

// Estimate a PCM WAV's duration from its header (sampleRate/channels/bits) + file size — no decode.
function estDur(f) {
  const i = f.info;
  if (!i || !i.sampleRate || !i.bits || !i.channels) return null;
  const byteRate = i.sampleRate * i.channels * (i.bits / 8);
  return byteRate > 0 ? Math.max(0, (f.size - 44) / byteRate) : null;
}
// Which files of a library slot the module actually loads: it stacks them in order and
// stops once the cumulative length has reached 10 s (the crossing file is included).
function slotLoadRows(files) {
  let running = 0;
  return files.map((f) => {
    const dur = estDur(f);
    const loads = running < 10;
    if (loads && dur != null) running += dur;
    return { f, dur, loads };
  });
}

// Move a file up/down within its slot (rewrites the N_ prefixes) and reselect the slot.
async function commitSlotOrder(bank, cell, order) {
  try {
    await api.post('/api/reorder-slot', { kind: state.kind, lib: state.lib, bank, cell, order });
    stopPlayback();                          // prefixes changed → old playing/editor refs are stale
    await loadGrid();
    selectSlot(bank, cell, { play: false });
  } catch (e) { toast(e.message, true); }
}
// Drop file `fromName` at `toName`'s position (drag-to-reorder within a slot).
async function dropReorderSlot(bank, cell, fromName, toName) {
  const c = cellAt(bank, cell); if (!c) return;
  const order = c.files.map((f) => f.name);
  const fi = order.indexOf(fromName), ti = order.indexOf(toName);
  if (fi < 0 || ti < 0 || fi === ti) return;
  order.splice(fi, 1);
  order.splice(ti, 0, fromName);
  await commitSlotOrder(bank, cell, order);
}

function startRename(row, f, bank, cell) {
  if (row.querySelector('.name-edit')) return;
  const box = document.createElement('div');
  box.className = 'name-edit';
  box.innerHTML = `<input value="${escapeHtml(prettyName(f.name))}" />
    <button class="btn sm primary">OK</button><button class="btn sm ghost">✕</button>`;
  row.appendChild(box);
  const input = box.querySelector('input');
  input.focus(); input.select();
  const commit = async () => {
    const to = input.value.trim();
    if (!to) return;
    try {
      await api.post('/api/rename', { kind: state.kind, lib: state.lib, bank, cell, from: f.name, to });
      toast('Renamed.');
      await loadGrid(); renderInspector();
    } catch (e) { toast(e.message, true); }
  };
  box.querySelector('.primary').onclick = commit;
  box.querySelector('.ghost').onclick = () => box.remove();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') box.remove(); });
}

async function deleteFile(f, bank, cell) {
  try {
    const r = await api.post('/api/delete', { kind: state.kind, lib: state.lib, bank, cell, name: f.name });
    stopIfPlaying(slotRel(bank, cell) + '/' + f.name);
    await loadGrid();
    if (state.kind === 'scene') {
      if (editor.name === f.name) clearEditor();
    } else {
      // Rebuild the slot's editor view (combined / solo / empty) so the waveform reflects the delete.
      selectSlot(bank, cell, { play: false });
    }
    toast('Removed to trash.', false, () => undoRestore(r.restore));
  } catch (e) { toast(e.message, true); }
}

/* ===================== RESERVE (accordion tree) ===================== */
async function loadStaging() {
  const scroller = $('#staging-drop');          // keep the scroll position across rebuilds
  const prevScroll = scroller ? scroller.scrollTop : 0;
  const ul = $('#staging-list');
  ul.innerHTML = '';
  $('#stg-path').textContent = reserveHandle ? reserveHandle.name : 'no folder';
  $('#stg-open').classList.toggle('hidden', !!reserveHandle);   // only offer the picker when none is set
  const hint = document.querySelector('.staging-drop-hint');
  if (!reserveHandle) {                       // optional feature: make that clear, don't look broken
    hint.textContent = 'Optional. Choose a folder below to stage and organise samples before dropping them into the library.';
    $('#staging-panel').classList.remove('has-items');
    return;
  }
  hint.innerHTML = RESERVE_HINT_DEFAULT;
  const total = await renderNode('', 0, ul);
  $('#staging-panel').classList.toggle('has-items', total > 0);
  if (scroller) scroller.scrollTop = prevScroll;
}

// Render a folder level. Children are NESTED inside their folder's <li> so the folder's
// drop zone covers its whole (open) subtree, and indentation is structural.
async function renderNode(pathRel, depth, container) {
  let data;
  try { data = await api.get('/api/staging?path=' + encodeURIComponent(pathRel)); }
  catch { return 0; }

  for (const entry of data.entries) {
    const name = entry.name;
    const rel = pathRel ? pathRel + '/' + name : name;

    if (entry.isDir) {
      const expanded = state.expanded.has(rel);
      const li = document.createElement('li');
      li.className = 'dir-item';
      const row = document.createElement('div');
      row.className = 'row-line';
      row.draggable = true;
      row.innerHTML = `<span class="caret">${expanded ? '▾' : '▸'}</span><span class="fic">📁</span>
        <span class="nm">${escapeHtml(name)}</span>
        <button class="mini sub" title="New subfolder">＋</button>
        <button class="mini x" title="Remove">✕</button>`;
      row.onclick = (e) => { if (e.target.closest('.mini')) return; toggleFolder(rel); };
      row.querySelector('.sub').onclick = (e) => { e.stopPropagation(); mkdirIn(rel); };
      row.querySelector('.x').onclick = (e) => { e.stopPropagation(); delStaged(rel, true, name); };
      row.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('application/x-arbhar-staging', JSON.stringify({ path: rel, name, isDir: true }));
        e.dataTransfer.effectAllowed = 'move';
      });
      li.appendChild(row);
      wireFolderDrop(li, rel, row);            // drop anywhere in this folder's subtree → into it
      container.appendChild(li);
      if (expanded) {
        const sub = document.createElement('ul');
        sub.className = 'stage-sublist';
        li.appendChild(sub);
        await renderNode(rel, depth + 1, sub);
      }
    } else {
      const li = document.createElement('li');
      li.className = 'stage-item';
      li.draggable = true;
      li.innerHTML = `<span class="play">▶</span><span class="nm">${escapeHtml(name)}</span>
        <button class="mini x" title="Remove">✕</button>`;
      li.onclick = (e) => {
        if (e.target.closest('.mini')) return;
        // Re-clicking the reserve item that is already playing pauses it (and vice-versa).
        if (toggledCurrent('/api/staging-audio?path=' + encodeURIComponent(rel))) return;
        playAudio('/api/staging-audio?path=' + encodeURIComponent(rel), name, li);
        playingStagingPath = rel;                 // remember it's a reserve sample
        setEditor(rel, name, 'reserve');          // open the editor on this reserve sample
      };
      li.querySelector('.x').onclick = (e) => { e.stopPropagation(); delStaged(rel, false, name); };
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-arbhar-staging', JSON.stringify({ path: rel, name, isDir: false }));
        e.dataTransfer.effectAllowed = 'copyMove';
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      container.appendChild(li);
    }
  }
  return data.entries.length;
}

function toggleFolder(rel) {
  if (state.expanded.has(rel)) {
    state.expanded.delete(rel);
    // collapsing a folder that holds the currently playing reserve sample → stop it
    if (playingStagingPath && (playingStagingPath === rel || playingStagingPath.startsWith(rel + '/'))) stopPlayback();
  } else {
    state.expanded.add(rel);
  }
  loadStaging();
}
// Create one or several folders (comma- or newline-separated) under `parent`.
async function createFolders(parent, raw) {
  const names = (raw || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  let ok = 0;
  for (const name of names) {
    try { await api.post('/api/staging/mkdir', { path: parent, name }); ok++; }
    catch (e) { toast(e.message, true); }
  }
  if (parent) state.expanded.add(parent);
  loadStaging();
  if (ok) toast(ok === 1 ? 'Folder created.' : `${ok} folders created.`);
}
async function mkdirIn(parent) {
  createFolders(parent, prompt('New subfolder name(s) — separate several with commas:'));
}
async function delStaged(rel, isDir, name) {
  try {
    const r = await api.post('/api/delete', { staging: true, path: rel });
    loadStaging();
    toast('Removed from reserve.', false, async () => { await api.post('/api/restore', { items: [r.restore] }); loadStaging(); });
  } catch (e) { toast(e.message, true); }
}

// Drop anywhere in a folder's subtree → into that folder (move / copy / import).
function wireFolderDrop(el, folderRel, hl) {
  const mark = hl || el;
  el.addEventListener('dragover', (e) => {
    const t = e.dataTransfer.types;
    if (!(t.includes('application/x-arbhar-staging') || t.includes('application/x-arbhar-file') || t.includes('Files'))) return;
    e.preventDefault();
    e.stopPropagation();                          // nearest folder wins; no ancestor/panel highlight
    mark.classList.add('over');
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) mark.classList.remove('over'); });
  el.addEventListener('drop', async (e) => {
    mark.classList.remove('over');
    const fileData = e.dataTransfer.getData('application/x-arbhar-file');
    if (fileData) {
      e.preventDefault(); e.stopPropagation();
      const item = JSON.parse(fileData);
      try { await api.post('/api/copy-to-staging', { rel: item.path, to: folderRel }); state.expanded.add(folderRel); toast('Copied to reserve.'); loadStaging(); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const stg = e.dataTransfer.getData('application/x-arbhar-staging');
    if (stg) {
      e.preventDefault(); e.stopPropagation();
      const item = JSON.parse(stg);
      if (item.path === folderRel) return;
      try { const r = await api.post('/api/staging/move', { from: item.path, to: folderRel }); state.expanded.add(folderRel); if (r.moved) toast('Moved.'); loadStaging(); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (e.dataTransfer.items && e.dataTransfer.items.length) {
      e.preventDefault(); e.stopPropagation();
      const n = await importDropped(e.dataTransfer, folderRel);
      if (n) { state.expanded.add(folderRel); toast(`${n} file(s) imported.`); loadStaging(); }
    }
  });
}

$('#stg-mkdir').onclick = () => {
  createFolders('', prompt('New folder name(s) — separate several with commas:'));
};

/* ===================== DRAG & DROP ===================== */
const AUDIO_RE = /\.(wav|aif|aiff)$/i;

// External files (from the OS) → write into the chosen folders via FSA.
// destQuery mirrors the old server params: dest=staging&path=… OR
// dest=slot&kind=&lib=&bank=&cell=[&layer=][&replace=1]
async function uploadFiles(fileList, destQuery) {
  const q = Object.fromEntries(new URLSearchParams(destQuery));
  let ok = 0;
  for (const file of [...fileList]) {
    if (!AUDIO_RE.test(file.name)) { toast(`Skipped ${file.name} (not .wav/.aif).`, true); continue; }
    try {
      const ext = extOf(file.name), stem = cleanStem(file.name.replace(/^\d+_/, '').replace(/\.[^.]+$/, ''));
      if (q.dest === 'staging') {
        const dir = await dirByPath(reserveHandle, q.path || '', true);
        const name = await uniqueName(dir, file.name);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(await file.arrayBuffer()); await w.close();
      } else {
        const dir = await dirByPath(rootHandle, slotRelPath(q.kind, +q.lib, +q.bank, +q.cell), true);
        const ing = await ingest(await file.arrayBuffer(), `${stem}${ext}`);   // convert on tile ingest if enabled
        const ext2 = extOf(ing.name);
        let name;
        if (q.kind === 'scene' && q.layer) { await clearAudio(dir, +q.layer); name = `${q.layer}_${stem}${ext2}`; }
        else if (q.replace) { await clearAudio(dir); name = `1_${stem}${ext2}`; }
        else { name = `${await nextIndex(dir)}_${stem}${ext2}`; }
        name = await uniqueName(dir, name);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(ing.bytes); await w.close();
      }
      ok++;
    } catch (e) { toast(e.message, true); }
  }
  return ok;
}

// Import dropped Finder items into the reserve — supports whole folders (recursion).
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, dir: prefix });
  } else if (entry.isDirectory) {
    const childPrefix = prefix ? prefix + '/' + entry.name : entry.name;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const c of batch) await walkEntry(c, childPrefix, out);
    } while (batch.length);
  }
}
async function importDropped(dt, basePath) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  const collected = [];
  if (entries.length) { for (const en of entries) await walkEntry(en, '', collected); }
  else { for (const f of [...(dt.files || [])]) collected.push({ file: f, dir: '' }); }
  let ok = 0;
  for (const { file, dir } of collected) {
    if (!AUDIO_RE.test(file.name)) continue;                 // skip non-audio silently
    const target = dir ? (basePath ? basePath + '/' + dir : dir) : basePath;
    ok += await uploadFiles([file], 'dest=staging&path=' + encodeURIComponent(target));
  }
  return ok;
}

// Drop onto a grid pad (library) → REPLACE the slot with the dropped sample.
function wireExternalDrop(el, slot) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-arbhar-staging')) {
      e.preventDefault(); el.classList.add('over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('over');
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      // Add to the slot's stack (kept separate; arbhar layers them in order). Replace = clear (✕) then drop.
      const n = await uploadFiles(e.dataTransfer.files, `dest=slot&kind=${state.kind}&lib=${state.lib}&bank=${slot.bank}&cell=${slot.cell}`);
      if (n) toast(`Slot ${slot.bank}.${slot.cell} · ${n} sample${n > 1 ? 's' : ''} added.`);
      await loadGrid();
      selectSlot(slot.bank, slot.cell, { play: false });
    }
  });
}

// Drop a staged sample onto a pad (library) → add it to the slot's stack.
function wireStagingDrop(el, slot) {
  el.addEventListener('drop', async (e) => {
    const stg = e.dataTransfer.getData('application/x-arbhar-staging');
    if (!stg) return;
    e.preventDefault(); el.classList.remove('over');
    const item = JSON.parse(stg);
    if (item.isDir) return;
    try {
      await api.post('/api/copy-from-staging', { path: item.path, kind: state.kind, lib: state.lib, bank: slot.bank, cell: slot.cell });
      toast(`Slot ${slot.bank}.${slot.cell} ← “${item.name}” added.`);
      await loadGrid();
      selectSlot(slot.bank, slot.cell, { play: false });
    } catch (err) { toast(err.message, true); }
  });
}

// Drag one library pad onto another → swap their contents.
function wireSwapDrop(el, slot) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-arbhar-file')) return;
    e.preventDefault(); el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    const data = e.dataTransfer.getData('application/x-arbhar-file');
    if (!data) return;
    let item; try { item = JSON.parse(data); } catch { return; }
    if (!item.swap) return;                                          // not a grid-internal drag
    e.preventDefault(); e.stopPropagation(); el.classList.remove('over');
    const s = item.swap;
    if (s.kind !== state.kind || s.lib !== state.lib) return;        // different library grid
    if (s.bank === slot.bank && s.cell === slot.cell) return;        // dropped on itself
    await swapSlots(s, slot);
  });
}

async function swapSlots(a, b) {
  const body = { kind: a.kind, lib: a.lib, a: { bank: a.bank, cell: a.cell }, b: { bank: b.bank, cell: b.cell } };
  try {
    await api.post('/api/swap-slots', body);
    await loadGrid();
    selectSlot(b.bank, b.cell, { play: false });
    toast(`Swapped ${a.bank}.${a.cell} ↔ ${b.bank}.${b.cell}`, false, async () => {
      try { await api.post('/api/swap-slots', body); await loadGrid(); selectSlot(a.bank, a.cell, { play: false }); toast('Swap undone.'); }
      catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
}

// The WHOLE reserve panel is a drop target for the root level. Drops that land on a
// folder row are handled there (stopPropagation); anything else falls through to here.
const reservePanel = $('#staging-panel');
const reserveAccepts = (dt) => dt.types.includes('Files') ||
  dt.types.includes('application/x-arbhar-staging') || dt.types.includes('application/x-arbhar-file');
['dragover', 'dragenter'].forEach((ev) => reservePanel.addEventListener(ev, (e) => {
  if (!reserveAccepts(e.dataTransfer)) return;
  e.preventDefault();
  // Only the external-file import shows the dashed/background highlight;
  // moving an existing element (internal drag) stays quiet.
  if (e.dataTransfer.types.includes('Files')) reservePanel.classList.add('drop-active');
}));
reservePanel.addEventListener('dragleave', (e) => {
  if (!reservePanel.contains(e.relatedTarget)) reservePanel.classList.remove('drop-active');
});
reservePanel.addEventListener('drop', async (e) => {
  reservePanel.classList.remove('drop-active');
  if (!reserveHandle) {                       // nowhere to put them yet
    e.preventDefault();
    toast('Choose a reserve folder first (button at the bottom of the Reserve panel).', true);
    return;
  }
  const fileData = e.dataTransfer.getData('application/x-arbhar-file');
  if (fileData) {
    e.preventDefault();
    const item = JSON.parse(fileData);
    try { await api.post('/api/copy-to-staging', { rel: item.path, to: '' }); loadStaging(); toast('Copied to reserve.'); }
    catch (err) { toast(err.message, true); }
    return;
  }
  const stg = e.dataTransfer.getData('application/x-arbhar-staging');
  if (stg) {
    e.preventDefault();
    const item = JSON.parse(stg);
    try { await api.post('/api/staging/move', { from: item.path, to: '' }); loadStaging(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (!e.dataTransfer.items || !e.dataTransfer.items.length) return;
  e.preventDefault();
  const n = await importDropped(e.dataTransfer, '');
  if (n) toast(`${n} file(s) added to the reserve.`);
  loadStaging();
});

// (Slot replacement is done by dropping directly on the grid pads / scene tiles.)

// prevent the browser from opening files dropped outside dropzones
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* ===================== KEYBOARD ===================== */
const TAB_ORDER = [
  { kind: 'library', lib: 1 }, { kind: 'library', lib: 2 }, { kind: 'library', lib: 3 },
  { kind: 'library', lib: 4 }, { kind: 'library', lib: 5 }, { kind: 'library', lib: 6 },
  { kind: 'scene', lib: 1 },
];
function cycleTab(dir) {
  let idx = TAB_ORDER.findIndex((o) => o.kind === state.kind && (state.kind === 'scene' || o.lib === state.lib));
  if (idx < 0) idx = 0;
  const t = TAB_ORDER[(idx + dir + TAB_ORDER.length) % TAB_ORDER.length];
  selectTab(t.kind, t.lib);
}
function moveSelection(key) {
  if (state.kind === 'scene') {
    // Navigate the 6 layer tiles (3 columns × 2 rows).
    let L = state.sceneLayer || 1;
    if (key === 'ArrowLeft') L = Math.max(1, L - 1);
    else if (key === 'ArrowRight') L = Math.min(6, L + 1);
    else if (key === 'ArrowUp') L = Math.max(1, L - 3);
    else if (key === 'ArrowDown') L = Math.min(6, L + 3);
    selectLayer(L);
    return;
  }
  let bank = 1, cell = 1;
  if (state.selected) {
    ({ bank, cell } = state.selected);
    if (key === 'ArrowUp') bank = Math.max(1, bank - 1);
    else if (key === 'ArrowDown') bank = Math.min(6, bank + 1);
    else if (key === 'ArrowLeft') cell = Math.max(1, cell - 1);
    else if (key === 'ArrowRight') cell = Math.min(6, cell + 1);
  }
  selectSlot(bank, cell);
}
document.addEventListener('keydown', (e) => {
  if ($('#app').classList.contains('hidden')) return;        // still on the picker
  const t = e.target;
  const typing = /^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable;
  if (typing) return;                                         // don't hijack while editing a name / field
  if (state.kind === 'scene' && state.sceneTab === 'preset') return;  // preset form is open

  if (e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
  else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key.startsWith('Arrow')) { e.preventDefault(); moveSelection(e.key); }
});

/* ===================== AUDIO PLAYER ===================== */
const audio = $('#audio');
let currentRow = null;
let playingStagingPath = null;   // reserve path of the playing sample, if it came from the reserve
let lastAudioURL = null;         // object URL to revoke
let currentSrcKey = null;        // logical src of the loaded sample (stable across re-renders)

// Re-clicking the tile that is already loaded toggles play/pause instead of restarting.
function toggledCurrent(srcKey) {
  if (!audio.src || currentSrcKey !== srcKey) return false;
  if (audio.paused || audio.ended) {
    if (audio.ended) audio.currentTime = 0;
    audio.play().catch(() => {}); $('#pl-toggle').textContent = '❚❚';
  } else { audio.pause(); $('#pl-toggle').textContent = '▶'; }
  return true;
}

// Turn the old server audio URLs into blob URLs from the chosen folders.
async function resolveAudioURL(src) {
  if (lastAudioURL) { URL.revokeObjectURL(lastAudioURL); lastAudioURL = null; }
  let m;
  if ((m = src.match(/^\/api\/audio\?path=(.+)$/))) { const f = await fileByRootRel(decodeURIComponent(m[1])); return (lastAudioURL = URL.createObjectURL(f)); }
  if ((m = src.match(/^\/api\/staging-audio\?path=(.+)$/))) { const f = await fileByReservePath(decodeURIComponent(m[1])); return (lastAudioURL = URL.createObjectURL(f)); }
  return src;
}

async function playAudio(src, name, row) {
  if (currentRow) currentRow.classList.remove('playing');
  currentRow = row; if (row) row.classList.add('playing');
  currentSrcKey = src;
  playingStagingPath = null;     // reset; the reserve caller sets it right after (sync, before await)
  $('#pl-name').textContent = name;
  $('#pl-toggle').disabled = false;
  $('#pl-toggle').textContent = '❚❚';
  try {
    audio.src = await resolveAudioURL(src);
    audio.play().catch(() => {});
  } catch (e) { toast(e.message, true); }
}

// Stop and reset the persistent player (used when leaving the audio's context).
function stopPlayback() {
  audio.pause();
  audio.removeAttribute('src');
  try { audio.load(); } catch { /* ignore */ }
  if (lastAudioURL) { URL.revokeObjectURL(lastAudioURL); lastAudioURL = null; }
  if (currentRow) currentRow.classList.remove('playing');
  currentRow = null;
  currentSrcKey = null;
  playingStagingPath = null;
  $('#pl-toggle').textContent = '▶';
  $('#pl-toggle').disabled = true;
  $('#pl-name').textContent = '—';
  $('#pl-progress').style.width = '0%';
  $('#pl-time').textContent = '0:00';
}

// Stop playback if the sample being removed is the one currently playing.
// rel is a root-relative path; folder:true matches any file inside that folder.
function stopIfPlaying(rel, { folder = false } = {}) {
  if (!currentSrcKey) return;
  const base = '/api/audio?path=' + encodeURIComponent(rel);
  if (folder ? currentSrcKey.startsWith(base + '%2F') : currentSrcKey === base) stopPlayback();
}

function togglePlay() {
  // With nothing loaded yet, space starts the selected slot.
  if (!audio.src && state.selected) { selectSlot(state.selected.bank, state.selected.cell); return; }
  if (audio.paused) { audio.play().catch(() => {}); $('#pl-toggle').textContent = '❚❚'; }
  else { audio.pause(); $('#pl-toggle').textContent = '▶'; }
}
$('#pl-toggle').onclick = togglePlay;
audio.addEventListener('ended', () => {
  $('#pl-toggle').textContent = '▶';
  if (currentRow) currentRow.classList.remove('playing');
});
audio.addEventListener('timeupdate', () => {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  $('#pl-progress').style.width = pct + '%';
  $('#pl-time').textContent = fmtTime(audio.currentTime) + (audio.duration ? ' / ' + fmtTime(audio.duration) : '');
});
$('.pl-track').onclick = (e) => {
  if (!audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
};
function fmtTime(s) { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

/* ===================== SAMPLE EDITOR (waveform · trim · fades) ===================== */
const editor = { rel: null, name: null, buf: null, combined: null, sel: { start: 0, end: 1 }, fadeIn: 0, fadeOut: 0, ac: null, previewSrc: null, drag: null, normalize: false, normDb: parseFloat(localStorage.getItem('arbhar-norm-db') || '-1') };

// Peak-normalize gain to reach the target dBFS over the current selection.
function normGain() {
  if (!editor.normalize || !editor.buf) return 1;
  const buf = editor.buf;
  const startF = Math.floor(editor.sel.start * buf.length);
  const endF = Math.floor(editor.sel.end * buf.length);
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c);
    for (let i = startF; i < endF; i++) { const v = Math.abs(s[i]); if (v > peak) peak = v; }
  }
  const target = Math.pow(10, editor.normDb / 20);
  return peak > 0 ? target / peak : 1;
}

function audioCtx() {
  if (!editor.ac) editor.ac = new (window.AudioContext || window.webkitAudioContext)();
  return editor.ac;
}
function fmtDur(s) { return (s || 0).toFixed(2) + ' s'; }

async function setEditor(rel, name, scope = 'root') {
  const seq = (editor.seq = (editor.seq || 0) + 1);   // guards against out-of-order decodes
  editor.rel = rel; editor.name = name; editor.scope = scope;
  editor.buf = null; editor.peaks = null; editor.combined = null;   // single-file (editable) mode
  $('#edit-tools').classList.remove('hidden');
  editor.sel = { start: 0, end: 1 }; editor.fadeIn = 0; editor.fadeOut = 0; editor.normalize = false;
  $('#fade-in').value = 0; $('#fade-out').value = 0;
  $('#fade-in-val').textContent = '0 ms'; $('#fade-out-val').textContent = '0 ms';
  $('#normalize').checked = false; $('#norm-db').value = editor.normDb;
  $('#editor').classList.remove('hidden');
  $('#insp-empty').classList.add('hidden');
  $('#insp-sub').textContent = prettyName(name);
  try {
    const file = scope === 'reserve' ? await fileByReservePath(rel) : await fileByRootRel(rel);
    const bytes = await file.arrayBuffer();
    // Decode at the file's own sample rate so an edited sample keeps it (decodeAudioData
    // otherwise resamples to the output device's rate — e.g. a 48k file → 44.1k on some Macs).
    const info = wavInfo(bytes.slice(0, 8192));
    const srcRate = info && info.sampleRate >= 8000 && info.sampleRate <= 96000 ? info.sampleRate : 0;
    let ctx; try { ctx = srcRate ? new OfflineAudioContext(1, 1, srcRate) : audioCtx(); } catch { ctx = audioCtx(); }
    const buf = await ctx.decodeAudioData(bytes);
    if (seq !== editor.seq) return;                   // a newer selection superseded this one
    editor.buf = buf; editor.peaks = null;
  } catch (e) { if (seq === editor.seq) { editor.buf = null; toast('Audio decoding failed.', true); } }
  if (seq !== editor.seq) return;
  drawWave();
  if (editor.buf && !playheadRAF && audio && !audio.paused) playheadRAF = requestAnimationFrame(tickPlayhead);
}
function clearEditor() {
  editor.rel = null; editor.buf = null; editor.combined = null;
  $('#edit-tools').classList.remove('hidden');
  $('#editor').classList.add('hidden');
  $('#insp-sub').textContent = '';
}

// Combined (preview-only) view of a multi-file slot: decode all files at 48k, join them,
// draw one waveform with file separators + the 10s/13s load cutoff, and play the whole stack.
async function setEditorCombined(bank, cell, files, play = true) {
  const seq = (editor.seq = (editor.seq || 0) + 1);
  editor.rel = null; editor.scope = 'root'; editor.name = `${bank}.${cell} combined`;
  editor.buf = null; editor.peaks = null; editor.combined = null;
  editor.sel = { start: 0, end: 1 };
  $('#editor').classList.remove('hidden');
  $('#insp-empty').classList.add('hidden');
  $('#edit-tools').classList.add('hidden');          // no editing on the combined view
  $('#insp-sub').textContent = `${files.length} samples · combined preview`;

  const rate = 48000, decoded = [];
  for (const f of files) {
    try { decoded.push(await new OfflineAudioContext(1, 1, rate).decodeAudioData(await (await fileByRootRel(slotRel(bank, cell) + '/' + f.name)).arrayBuffer())); }
    catch { decoded.push(null); }
  }
  if (seq !== editor.seq) return;
  const valid = decoded.filter(Boolean);
  if (!valid.length) { editor.buf = null; drawWave(); return; }
  const numCh = Math.max(1, ...valid.map((b) => b.numberOfChannels));
  const totalFrames = valid.reduce((s, b) => s + b.length, 0);
  const out = audioCtx().createBuffer(numCh, totalFrames, rate);
  const boundaries = []; let off = 0, running = 0, loadedEnd = 0, loadedCount = 0, done = false;
  for (const b of decoded) {
    if (b) {
      for (let c = 0; c < numCh; c++) out.getChannelData(c).set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), off);
      off += b.length;
      const dur = b.length / rate;
      if (!done && running < 10) { loadedEnd += dur; running += dur; loadedCount++; } else done = true;
    }
    boundaries.push(off / rate);
  }
  loadedEnd = Math.min(loadedEnd, 13);
  editor.buf = out; editor.peaks = null;
  editor.combined = { boundaries, loadedEnd, total: totalFrames / rate, loadedCount, count: files.length };

  const chans = []; for (let c = 0; c < numCh; c++) chans.push(out.getChannelData(c));
  const url = URL.createObjectURL(new Blob([encodeWav24(chans, rate)], { type: 'audio/wav' }));
  playBlob(url, `${bank}.${cell} · ${files.length} samples`, 'combined:' + slotRel(bank, cell), play);
  drawWave();
  if (play && !playheadRAF) playheadRAF = requestAnimationFrame(tickPlayhead);
}

// Play a ready blob URL (used by the combined preview). Mirrors playAudio but skips URL resolution.
function playBlob(url, name, srcKey, play = true) {
  if (currentRow) currentRow.classList.remove('playing');
  currentRow = null;
  if (lastAudioURL) { URL.revokeObjectURL(lastAudioURL); }
  lastAudioURL = url;                                // revoked on the next play
  currentSrcKey = srcKey; playingStagingPath = null;
  $('#pl-name').textContent = name;
  $('#pl-toggle').disabled = false;
  audio.src = url;
  if (play) { $('#pl-toggle').textContent = '❚❚'; audio.play().catch(() => {}); }
  else { $('#pl-toggle').textContent = '▶'; }
}
function selDuration() { return editor.buf ? (editor.sel.end - editor.sel.start) * editor.buf.duration : 0; }

// Precompute min/max per pixel column once per (buffer, width) — cheap redraws after.
function computePeaks(W) {
  const ch = editor.buf.getChannelData(0), n = ch.length, peaks = new Array(W);
  for (let x = 0; x < W; x++) {
    const s0 = Math.floor(x / W * n), s1 = Math.max(s0 + 1, Math.floor((x + 1) / W * n));
    let mn = 1, mx = -1;
    for (let i = s0; i < s1; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    peaks[x] = [mn, mx];
  }
  editor.peaks = peaks; editor.peaksW = W;
}
// True when the footer player is playing this editor's file (same duration).
function editorIsPlaying() {
  return editor.buf && audio.duration && Math.abs(audio.duration - editor.buf.duration) < 0.35;
}
function drawWave() {
  const canvas = $('#wave');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 280, H = 130;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!editor.buf) return;
  if (!editor.peaks || editor.peaksW !== W) computePeaks(W);
  const mid = H / 2, g = normGain();
  ctx.strokeStyle = 'rgba(201,161,91,0.85)';
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let mn = editor.peaks[x][0], mx = editor.peaks[x][1];
    mx = Math.max(-1, Math.min(1, mx * g)); mn = Math.max(-1, Math.min(1, mn * g));
    ctx.moveTo(x + 0.5, mid - mx * mid * 0.9);
    ctx.lineTo(x + 0.5, mid - mn * mid * 0.9);
  }
  ctx.stroke();

  if (editor.combined) {
    // Combined preview: file separators + grey what the module drops (past the 10s/13s cutoff).
    const C = editor.combined, total = editor.buf.duration || C.total;
    if (C.loadedEnd < total - 1e-3) {
      const gx = (C.loadedEnd / total) * W;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(gx, 0, W - gx, H);
      ctx.strokeStyle = 'rgba(197,107,92,0.85)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(226,196,137,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < C.boundaries.length - 1; i++) {
      const bxx = (C.boundaries[i] / total) * W;
      ctx.beginPath(); ctx.moveTo(bxx, 0); ctx.lineTo(bxx, H); ctx.stroke();
    }
  } else {
    const sx = editor.sel.start * W, ex = editor.sel.end * W;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, sx, H); ctx.fillRect(ex, 0, W - ex, H);
    const selW = ex - sx, dur = selDuration();
    const fi = dur > 0 ? Math.min(1, (editor.fadeIn / 1000) / dur) : 0;
    const fo = dur > 0 ? Math.min(1, (editor.fadeOut / 1000) / dur) : 0;
    ctx.strokeStyle = 'rgba(226,196,137,0.7)';
    ctx.beginPath();
    ctx.moveTo(sx, H); ctx.lineTo(sx + selW * fi, 0);
    ctx.moveTo(ex, H); ctx.lineTo(ex - selW * fo, 0);
    ctx.stroke();
    // discrete trim handles: a faint boundary line + a small grab pill at mid-height
    for (const bx of [sx, ex]) {
      ctx.strokeStyle = 'rgba(226,196,137,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H); ctx.stroke();
      const hw = 7, hh = 26;
      ctx.fillStyle = '#e2c489';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx - hw / 2, mid - hh / 2, hw, hh, 3.5);
      else ctx.rect(bx - hw / 2, mid - hh / 2, hw, hh);
      ctx.fill();
    }
  }

  if (editorIsPlaying()) {                       // scrolling playhead
    const px = (audio.currentTime / audio.duration) * W;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); ctx.lineWidth = 1;
  }

  if (editor.combined) {
    const C = editor.combined;
    const ignored = C.count - C.loadedCount;
    $('#edit-info').innerHTML = `combined <b>${fmtDur(editor.buf.duration)}</b> · loads first <b>${C.loadedCount}/${C.count}</b> (~${fmtDur(C.loadedEnd)}, 13s buffer)`
      + (ignored ? `<span class="edit-warn">${ignored} past the limit</span>` : '');
  } else {
    const dur = selDuration();
    const over = dur > 13.05;   // arbhar layer buffer holds max 13 s; longer is truncated on load
    $('#edit-info').innerHTML = `length <b>${fmtDur(editor.buf.duration)}</b> · selection <b>${fmtDur(dur)}</b> · ${editor.buf.sampleRate / 1000}k · ${editor.buf.numberOfChannels === 2 ? 'stereo' : 'mono'}`
      + (over ? '<span class="edit-warn">⚠ over 13s</span>' : '');
  }
}

// Animate the playhead while the editor's file plays.
let playheadRAF = 0;
function tickPlayhead() {
  playheadRAF = 0;
  if (editor.buf) drawWave();                 // draw only when ready — but keep looping regardless
  if (!audio.paused && !audio.ended) playheadRAF = requestAnimationFrame(tickPlayhead);
}
audio.addEventListener('play', () => { if (!playheadRAF) playheadRAF = requestAnimationFrame(tickPlayhead); });
['pause', 'ended', 'seeked'].forEach((ev) => audio.addEventListener(ev, () => { if (editor.buf) drawWave(); }));

// Click the waveform (away from the trim handles) to play from that point.
function editorSrc() {
  return editor.scope === 'reserve'
    ? '/api/staging-audio?path=' + encodeURIComponent(editor.rel)
    : '/api/audio?path=' + encodeURIComponent(editor.rel);
}
async function seekEditor(f) {
  if (!editor.buf) return;
  const t = f * editor.buf.duration;
  if (editorIsPlaying()) {
    audio.currentTime = t; audio.play().catch(() => {});
  } else if (editor.combined) {
    // The combined blob is already loaded in the player; just seek + play.
    if (audio.src) { try { audio.currentTime = t; } catch (e) { /* */ } audio.play().catch(() => {}); $('#pl-toggle').textContent = '❚❚'; }
  } else {
    await playAudio(editorSrc(), prettyName(editor.name), null);
    if (editor.scope === 'reserve') playingStagingPath = editor.rel;
    const seek = () => { try { audio.currentTime = t; } catch (e) { /* */ } };
    if (audio.readyState >= 1 && audio.duration) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
  }
  if (!playheadRAF) playheadRAF = requestAnimationFrame(tickPlayhead);
}

// process trim + fades → per-channel Float32 arrays
function processEdited() {
  const buf = editor.buf, sr = buf.sampleRate;
  const startF = Math.floor(editor.sel.start * buf.length);
  const endF = Math.floor(editor.sel.end * buf.length);
  const len = Math.max(1, endF - startF);
  const fiN = Math.min(len, Math.floor(editor.fadeIn / 1000 * sr));
  const foN = Math.min(len, Math.floor(editor.fadeOut / 1000 * sr));
  const norm = normGain();                        // normalization gain (1 if off)
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let g = norm;
      if (fiN > 0 && i < fiN) g *= i / fiN;
      if (foN > 0 && i > len - foN) g *= (len - i) / foN;
      out[i] = Math.max(-1, Math.min(1, src[startF + i] * g));
    }
    chans.push(out);
  }
  return { chans, sampleRate: sr };
}

// encode Float32 channels → 24-bit PCM WAV (arbhar's ideal format)
function encodeWav24(chans, sampleRate) {
  const numCh = chans.length, frames = chans[0].length, bps = 3;
  const dataSize = frames * numCh * bps;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * numCh * bps, true);
  view.setUint16(32, numCh * bps, true); view.setUint16(34, 24, true);
  ws(36, 'data'); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      let v = Math.round(s * 8388607); if (v < 0) v += 16777216;
      view.setUint8(off, v & 255); view.setUint8(off + 1, (v >> 8) & 255); view.setUint8(off + 2, (v >> 16) & 255);
      off += 3;
    }
  }
  return view.buffer;
}

// Resample arbitrary audio bytes to a 48 kHz / 24-bit WAV. Returns null if decoding fails.
async function to48k24(bytes) {
  try {
    const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice(0));
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    return encodeWav24(chans, 48000);
  } catch { return null; }
}
// When Auto 48k/24-bit is on, convert ingested audio unless it is already ideal.
// Returns { bytes, name } — name switches to .wav on conversion.
async function ingest(bytes, name) {
  if (!autoConvert) return { bytes, name };
  const info = wavInfo(bytes.slice(0, 8192));
  if (info && info.sampleRate === 48000 && info.bits === 24) return { bytes, name };   // already ideal
  const conv = await to48k24(bytes);
  if (!conv) { toast(`Kept “${name}” as-is (couldn’t convert).`, true); return { bytes, name }; }
  return { bytes: conv, name: name.replace(/\.[^.]+$/, '.wav') };
}

function previewEdit() {
  if (!editor.buf) return;
  const ctx = audioCtx(); ctx.resume();
  const { chans, sampleRate } = processEdited();
  const ab = ctx.createBuffer(chans.length, chans[0].length, sampleRate);
  chans.forEach((c, i) => ab.copyToChannel(c, i));
  if (editor.previewSrc) { try { editor.previewSrc.stop(); } catch { /* ignore */ } }
  const s = ctx.createBufferSource(); s.buffer = ab; s.connect(ctx.destination); s.start();
  editor.previewSrc = s;
}

async function applyEdit() {
  if (!editor.buf || !editor.rel) return;
  const { chans, sampleRate } = processEdited();
  const rel = editor.rel, name = editor.name, scope = editor.scope || 'root';
  const refresh = () => (scope === 'reserve' ? loadStaging() : loadGrid());
  try {
    const src = scope === 'reserve' ? await fileByReservePath(rel) : await fileByRootRel(rel);
    const before = await src.arrayBuffer();                           // keep original for undo
    await writeBytes(scope, rel, encodeWav24(chans, sampleRate));
    await refresh();
    // Reflect the result immediately from the processed buffer (no file re-read race).
    const nb = audioCtx().createBuffer(chans.length, chans[0].length, sampleRate);
    chans.forEach((c, i) => nb.copyToChannel(c, i));
    editor.buf = nb; editor.peaks = null;
    editor.sel = { start: 0, end: 1 }; editor.fadeIn = 0; editor.fadeOut = 0; editor.normalize = false;
    $('#fade-in').value = 0; $('#fade-out').value = 0; $('#fade-in-val').textContent = '0 ms'; $('#fade-out-val').textContent = '0 ms';
    $('#normalize').checked = false; $('#norm-db').value = editor.normDb;
    drawWave();
    toast('Sample edited ✓', false, async () => {
      await writeBytes(scope, rel, before);
      await refresh(); await setEditor(rel, name, scope); toast('Edit reverted.');
    });
  } catch (e) { toast(e.message, true); }
}

// waveform trim handles
(function initWave() {
  const canvas = $('#wave');
  const frac = (e) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const move = (f) => {
    if (editor.drag === 'start') editor.sel.start = Math.max(0, Math.min(f, editor.sel.end - 0.01));
    else editor.sel.end = Math.min(1, Math.max(f, editor.sel.start + 0.01));
    drawWave();
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!editor.buf) return;
    const f = frac(e);
    if (editor.combined) { seekEditor(f); return; }   // no trim handles in the combined preview
    const W = canvas.clientWidth || 280;
    const dStart = Math.abs(f - editor.sel.start) * W, dEnd = Math.abs(f - editor.sel.end) * W;
    if (dStart <= 10 || dEnd <= 10) {          // near a handle → drag the trim handle
      editor.drag = dStart <= dEnd ? 'start' : 'end';
      canvas.setPointerCapture(e.pointerId); move(f);
    } else {                                    // elsewhere → play from that point
      seekEditor(f);
    }
  });
  canvas.addEventListener('pointermove', (e) => { if (editor.drag) move(frac(e)); });
  canvas.addEventListener('pointerup', () => { editor.drag = null; });
})();

// Drop a reserve sample (or Finder files) onto the editor's file list → add to the selected slot,
// at the position where it is dropped (insert into the stack, not just append).
(function initInspectorListDrop() {
  const list = $('#insp-list');
  const canAdd = (dt) => state.kind !== 'scene' && state.selected && (dt.types.includes('application/x-arbhar-staging') || dt.types.includes('Files'));
  const rows = () => [...list.querySelectorAll('.file-row')];
  const idxAt = (y) => { const rs = rows(); for (let i = 0; i < rs.length; i++) { const r = rs[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return i; } return rs.length; };
  const clearMarks = () => rows().forEach((r) => r.classList.remove('insert-before', 'insert-after'));
  const mark = (y) => {
    clearMarks(); const rs = rows(); if (!rs.length) return;
    const i = idxAt(y);
    if (i < rs.length) rs[i].classList.add('insert-before');
    else rs[rs.length - 1].classList.add('insert-after');
  };
  list.addEventListener('dragover', (e) => {
    if (!canAdd(e.dataTransfer)) return;
    e.preventDefault(); list.classList.add('list-drop-over');
    if (e.dataTransfer.types.includes('application/x-arbhar-staging')) mark(e.clientY);
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) { list.classList.remove('list-drop-over'); clearMarks(); } });
  list.addEventListener('drop', async (e) => {
    list.classList.remove('list-drop-over'); clearMarks();
    if (state.kind === 'scene' || !state.selected) return;
    const { bank, cell } = state.selected;
    const stg = e.dataTransfer.getData('application/x-arbhar-staging');
    if (stg) {
      e.preventDefault(); e.stopPropagation();
      const item = JSON.parse(stg);
      if (item.isDir) { toast('Drop a sample, not a folder.', true); return; }
      const targetIndex = idxAt(e.clientY);        // position in the stack to insert at
      try {
        const r = await api.post('/api/copy-from-staging', { path: item.path, kind: state.kind, lib: state.lib, bank, cell });
        await loadGrid();
        const c = cellAt(bank, cell);
        const order = c ? c.files.map((f) => f.name) : [];
        const from = order.indexOf(r.name);         // the freshly-added file (currently last)
        if (from >= 0 && targetIndex < order.length && targetIndex !== from) {
          order.splice(from, 1); order.splice(targetIndex, 0, r.name);
          await commitSlotOrder(bank, cell, order); // reindexes N_ prefixes + rebuilds the preview
        } else {
          selectSlot(bank, cell, { play: false });
        }
        toast(`Slot ${bank}.${cell} ← “${item.name}” added.`);
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault(); e.stopPropagation();
      const n = await uploadFiles(e.dataTransfer.files, `dest=slot&kind=${state.kind}&lib=${state.lib}&bank=${bank}&cell=${cell}`);
      if (n) { await loadGrid(); selectSlot(bank, cell, { play: false }); toast(`Slot ${bank}.${cell} · ${n} sample${n > 1 ? 's' : ''} added.`); }
    }
  });
})();
$('#normalize').addEventListener('change', (e) => { editor.normalize = e.target.checked; drawWave(); });
$('#norm-db').addEventListener('input', (e) => {
  let v = parseFloat(e.target.value); if (isNaN(v)) return;
  v = Math.max(-24, Math.min(0, v)); editor.normDb = v;
  localStorage.setItem('arbhar-norm-db', String(v));      // global, persisted
  if (editor.normalize) drawWave();
});
function stepDb(delta) {
  const inp = $('#norm-db');
  let v = parseFloat(inp.value); if (isNaN(v)) v = editor.normDb;
  v = Math.max(-24, Math.min(0, Math.round((v + delta) * 10) / 10));
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}
$('#db-up').onclick = () => stepDb(0.5);
$('#db-down').onclick = () => stepDb(-0.5);
$('#fade-in').addEventListener('input', (e) => { editor.fadeIn = +e.target.value; $('#fade-in-val').textContent = editor.fadeIn + ' ms'; drawWave(); });
$('#fade-out').addEventListener('input', (e) => { editor.fadeOut = +e.target.value; $('#fade-out-val').textContent = editor.fadeOut + ' ms'; drawWave(); });
$('#edit-preview').onclick = previewEdit;
$('#edit-reset').onclick = () => { editor.sel = { start: 0, end: 1 }; editor.fadeIn = 0; editor.fadeOut = 0; $('#fade-in').value = 0; $('#fade-out').value = 0; $('#fade-in-val').textContent = '0 ms'; $('#fade-out-val').textContent = '0 ms'; drawWave(); };
$('#edit-apply').onclick = applyEdit;
window.addEventListener('resize', () => { if (editor.buf) drawWave(); });

/* ===================== BOOT ===================== */
(async function boot() {
  if (!window.showDirectoryPicker) {
    setupStatus(
      (await isBrave())
        ? 'Brave blocks the File System Access API by default, so folder access is off. Open brave://flags, search “File System Access”, set it to Enabled and relaunch Brave — or use Chrome or Edge.'
        : 'This browser can’t edit local files (no File System Access API). Please use Chrome, Edge, or Brave (in Brave, enable it in brave://flags).',
      true);
    $('#pick-root').disabled = true; $('#pick-reserve').disabled = true;
    return;
  }
  // Restore previously chosen folders. Permission needs a user gesture to re-grant,
  // so we pre-fill names and let the buttons reconnect on click.
  let savedRoot = null, savedReserve = null;
  try { savedRoot = await idb.get('root'); savedReserve = await idb.get('reserve'); } catch { /* */ }

  if (savedReserve) {
    reserveHandle = savedReserve;
    $('#reserve-name').textContent = savedReserve.name + ' (click to reconnect)';
  }
  if (savedRoot) {
    rootHandle = savedRoot;
    $('#root-name').textContent = savedRoot.name;
    $('#root-name').classList.add('set');
    setupStatus('Previous library “' + savedRoot.name + '” — click Enter to reconnect.', false);
    $('#enter').disabled = false;
  }

  // Re-grant permission on the user's first action, then proceed.
  const reconnect = async () => {
    if (rootHandle && !(await ensurePermission(rootHandle))) { toast('Permission denied for the library folder.', true); return false; }
    if (reserveHandle && !(await ensurePermission(reserveHandle))) { reserveHandle = null; }
    state.present = await computePresent();
    return true;
  };
  const enterBtn = $('#enter');
  enterBtn.onclick = async () => { if (!rootHandle) return; if (await reconnect()) { $('#reserve-name').textContent = reserveHandle ? reserveHandle.name : 'optional — a folder to stage samples'; enterApp(); } };
})().catch((e) => toast(e.message, true));
