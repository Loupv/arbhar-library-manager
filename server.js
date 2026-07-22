'use strict';

/*
 * arbhar library editor — lightweight local server (zero dependencies).
 * Serves the UI and exposes a small filesystem API so the browser can
 * browse, read, copy, rename and import samples into the arbhar folder
 * structure expected by the module (Firmware 2.0).
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = process.env.PORT || 4173;

// When packaged into a single binary (pkg / SEA), __dirname is a read-only virtual
// snapshot. UI assets stay there (bundled), but anything we WRITE — the reserve,
// trash and config — must live next to the real executable on the user's disk.
const IS_PACKAGED = !!process.pkg || (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const APP_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;

const PUBLIC_DIR = path.join(__dirname, 'public');   // bundled assets (read-only when packaged)
const STAGING_DIR = path.join(APP_DIR, 'staging');
const CONFIG_FILE = path.join(APP_DIR, '.config.json');
const TRASH_DIR = path.join(APP_DIR, '.trash');

// ---------------------------------------------------------------------------
// arbhar structure constants
// ---------------------------------------------------------------------------
const LIB_FOLDERS = [
  '_arbhar_library',
  '_arbhar_library_2',
  '_arbhar_library_3',
  '_arbhar_library_4',
  '_arbhar_library_5',
  '_arbhar_library_6',
];
const SCENES_FOLDER = '_arbhar_scenes';
const AUDIO_EXT = new Set(['.wav', '.aif', '.aiff']);

// Session state: the active root the user selected in the UI.
let activeRoot = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(body) || typeof body === 'string'
      ? (headers['Content-Type'] || 'text/plain; charset=utf-8')
      : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function fail(res, status, message) {
  sendJSON(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// Guard: ensure `target` is inside `base` (prevents path escapes).
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeName(name) {
  // Strip path separators and control chars from a user-provided file name.
  return String(name).replace(/[\/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
}

// Parse the first chunk of a WAV file to expose sample-rate / bit-depth badges.
function wavInfo(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        const channels = buf.readUInt16LE(offset + 10);
        const sampleRate = buf.readUInt32LE(offset + 12);
        const bits = buf.readUInt16LE(offset + 22);
        return { sampleRate, bits, channels };
      }
      offset += 8 + size + (size % 2);
    }
  } catch { /* ignore malformed headers */ }
  return null;
}

async function listAudioFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    if (!AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const full = path.join(dir, e.name);
    let stat, info = null;
    try {
      stat = await fsp.stat(full);
      if (path.extname(e.name).toLowerCase() === '.wav') {
        const fd = await fsp.open(full, 'r');
        const { buffer } = await fd.read(Buffer.alloc(8192), 0, 8192, 0);
        await fd.close();
        info = wavInfo(buffer);
      }
    } catch { /* skip */ }
    files.push({
      name: e.name,
      size: stat ? stat.size : 0,
      info,
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return files;
}

// Resolve the folder for a given grid slot within the active root.
function slotDir(kind, lib, bank, cell) {
  if (!activeRoot) throw new Error('No active root selected.');
  if (kind === 'scene') {
    return path.join(activeRoot, SCENES_FOLDER, `${bank}_${cell}_scene`);
  }
  const folder = LIB_FOLDERS[lib - 1];
  if (!folder) throw new Error('Invalid library index.');
  return path.join(activeRoot, folder, `${bank}_${cell}_sample`);
}

// Next numeric prefix for a new file in a slot folder (load-order index).
async function nextIndex(dir) {
  const files = await listAudioFiles(dir);
  let max = 0;
  for (const f of files) {
    const m = f.name.match(/^(\d+)_/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Persist small preferences (last opened root) next to the app.
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch { /* best-effort; ignore read-only filesystems */ }
}

// Avoid clobbering: append _2, _3 … if the target name exists.
async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = filename;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${n}${ext}`;
    n++;
  }
  return path.join(dir, candidate);
}

// Resolve a path inside the staging tree, refusing escapes.
function stagingPath(rel) {
  const full = path.resolve(STAGING_DIR, rel || '');
  if (!isInside(STAGING_DIR, full)) throw new Error('Chemin hors réserve.');
  return full;
}

// Move a file/folder to the in-app .trash (reversible). Returns the trash basename.
async function toTrash(src) {
  await ensureDir(TRASH_DIR);
  const dest = await uniquePath(TRASH_DIR, `${Date.now()}__${path.basename(src)}`);
  await fsp.rename(src, dest);
  return path.basename(dest);
}

// Move any existing file whose prefix matches a scene layer to the trash.
async function clearSceneLayer(dir, layer) {
  const files = await listAudioFiles(dir);
  for (const f of files) {
    if (new RegExp(`^${layer}_`).test(f.name)) await toTrash(path.join(dir, f.name));
  }
}

// Move every audio file in a slot to the trash (used for replace-on-drop).
async function clearSlotFiles(dir) {
  for (const f of await listAudioFiles(dir)) await toTrash(path.join(dir, f.name));
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

// List directory contents for the folder picker (directories only).
async function apiBrowse(res, query) {
  let dir = query.path || os.homedir();
  dir = path.resolve(dir);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return fail(res, 400, `Cannot read: ${dir}`);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  // Detect whether this folder already looks like an arbhar root.
  const isArbhar = LIB_FOLDERS.some((f) => dirs.includes(f)) || dirs.includes(SCENES_FOLDER);
  sendJSON(res, 200, {
    path: dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    dirs,
    isArbhar,
  });
}

// Quick shortcuts: mounted volumes, home, cwd.
async function apiVolumes(res) {
  const shortcuts = [];
  shortcuts.push({ label: 'Home', path: os.homedir() });
  shortcuts.push({ label: 'Working dir', path: process.cwd() });
  try {
    const vols = await fsp.readdir('/Volumes', { withFileTypes: true });
    for (const v of vols) {
      if (v.isDirectory() || v.isSymbolicLink()) {
        shortcuts.push({ label: `Volume: ${v.name}`, path: path.join('/Volumes', v.name) });
      }
    }
  } catch { /* not macOS or no /Volumes */ }
  sendJSON(res, 200, { shortcuts });
}

// Does this folder directly contain arbhar library/scene folders?
function hasArbharFolders(dir) {
  return [...LIB_FOLDERS, SCENES_FOLDER].some((f) => fs.existsSync(path.join(dir, f)));
}

// Tolerate the common mistake of pointing at the wrong nesting level:
// if the user selected an `_arbhar_library*` / `_arbhar_scenes` folder itself,
// or any folder that directly holds `#_#_sample|scene` dirs, use its parent.
function resolveArbharRoot(start) {
  if (hasArbharFolders(start)) return start;
  const parent = path.dirname(start);
  const base = path.basename(start);
  if (/^_arbhar_/.test(base) && hasArbharFolders(parent)) return parent;
  try {
    const entries = fs.readdirSync(start);
    if (entries.some((n) => /^\d_\d_(sample|scene)$/.test(n))) return parent;
  } catch { /* ignore */ }
  return start;
}

// Select / validate a root. Optionally scaffold the full structure.
async function apiOpen(res, body) {
  let root = path.resolve(body.root || '');
  if (!fs.existsSync(root)) return fail(res, 400, 'Folder does not exist.');

  let adjusted = false;
  if (!body.scaffold) {
    const resolved = resolveArbharRoot(root);
    if (resolved !== root) { root = resolved; adjusted = true; }
  }

  if (body.scaffold) {
    for (const lib of LIB_FOLDERS) {
      for (let b = 1; b <= 6; b++) {
        for (let l = 1; l <= 6; l++) {
          await ensureDir(path.join(root, lib, `${b}_${l}_sample`));
        }
      }
    }
    for (let b = 1; b <= 6; b++) {
      for (let s = 1; s <= 6; s++) {
        await ensureDir(path.join(root, SCENES_FOLDER, `${b}_${s}_scene`));
      }
    }
  }

  activeRoot = root;
  saveConfig({ lastRoot: root });
  const present = {};
  for (const f of [...LIB_FOLDERS, SCENES_FOLDER]) {
    present[f] = fs.existsSync(path.join(root, f));
  }
  sendJSON(res, 200, { root, present, adjusted });
}

// Return the 6×6 grid for a library (lib 1-6) or the scenes bank.
async function apiGrid(res, query) {
  if (!activeRoot) return fail(res, 400, 'No root selected.');
  const kind = query.kind === 'scene' ? 'scene' : 'library';
  const lib = parseInt(query.lib || '1', 10);
  const cells = [];
  for (let bank = 1; bank <= 6; bank++) {
    for (let cell = 1; cell <= 6; cell++) {
      const dir = slotDir(kind, lib, bank, cell);
      const files = await listAudioFiles(dir);
      const slot = { bank, cell, files, exists: fs.existsSync(dir) };
      if (kind === 'scene') {
        slot.hasPreset = fs.existsSync(path.join(dir, 'preset.txt'));
      }
      cells.push(slot);
    }
  }
  sendJSON(res, 200, { kind, lib, cells });
}

// Stream an audio file (with Range support for seeking) from the active root.
async function apiAudio(req, res, query) {
  if (!activeRoot) return fail(res, 400, 'No root selected.');
  const rel = query.path || '';
  const full = path.resolve(activeRoot, rel);
  if (!isInside(activeRoot, full) && !isInside(STAGING_DIR, full)) {
    return fail(res, 403, 'Path outside allowed roots.');
  }
  await streamFile(req, res, full);
}

async function apiStagingAudio(req, res, query) {
  const full = stagingPath(query.path || query.name || '');
  await streamFile(req, res, full);
}

async function streamFile(req, res, full) {
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return fail(res, 404, 'File not found.');
  }
  const ext = path.extname(full).toLowerCase();
  const type = ext === '.wav' ? 'audio/wav'
    : (ext === '.aif' || ext === '.aiff') ? 'audio/aiff'
    : 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(full).pipe(res);
  }
}

// Import an external file (raw body) into a slot or into staging.
// Query: dest=staging | slot ; and for slot: kind, lib, bank, cell ; name=<original>
async function apiImport(req, res, query) {
  const buf = await readBody(req);
  if (!buf.length) return fail(res, 400, 'Empty upload.');
  const original = safeName(query.name || 'sample.wav');
  const ext = path.extname(original).toLowerCase();
  if (!AUDIO_EXT.has(ext)) {
    return fail(res, 400, `Unsupported file type: ${ext || '(none)'}. Use .wav / .aif / .aiff.`);
  }

  const stem = original.replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
  let targetDir, finalName;
  if (query.dest === 'staging') {
    targetDir = stagingPath(query.path || '');
    await ensureDir(targetDir);
    finalName = original;
  } else {
    const kind = query.kind === 'scene' ? 'scene' : 'library';
    const lib = parseInt(query.lib || '1', 10);
    const bank = parseInt(query.bank, 10);
    const cell = parseInt(query.cell, 10);
    targetDir = slotDir(kind, lib, bank, cell);
    await ensureDir(targetDir);
    if (kind === 'scene' && query.layer) {
      // A scene layer holds one sample, prefixed with the layer number.
      const layer = parseInt(query.layer, 10);
      await clearSceneLayer(targetDir, layer);
      finalName = `${layer}_${stem}${ext}`;
    } else if (query.replace) {
      // Replace-on-drop: the dropped sample becomes the slot's only content.
      await clearSlotFiles(targetDir);
      finalName = `1_${stem}${ext}`;
    } else {
      const idx = await nextIndex(targetDir);
      finalName = `${idx}_${stem}${ext}`;
    }
  }
  const outPath = await uniquePath(targetDir, finalName);
  await fsp.writeFile(outPath, buf);
  sendJSON(res, 200, { ok: true, name: path.basename(outPath) });
}

// Copy a staged file into a slot (server-side, no re-upload).
async function apiCopyFromStaging(res, body) {
  const src = stagingPath(body.path || body.name || '');
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    return fail(res, 400, 'Staged file not found.');
  }
  const kind = body.kind === 'scene' ? 'scene' : 'library';
  const dir = slotDir(kind, body.lib || 1, body.bank, body.cell);
  await ensureDir(dir);
  const ext = path.extname(src);
  const stem = path.basename(src, ext).replace(/^\d+_/, '');
  let out;
  if (kind === 'scene' && body.layer) {
    const layer = parseInt(body.layer, 10);
    await clearSceneLayer(dir, layer);
    out = await uniquePath(dir, `${layer}_${stem}${ext}`);
  } else if (body.replace) {
    await clearSlotFiles(dir);
    out = await uniquePath(dir, `1_${stem}${ext}`);
  } else {
    const idx = await nextIndex(dir);
    out = await uniquePath(dir, `${idx}_${stem}${ext}`);
  }
  await fsp.copyFile(src, out);
  sendJSON(res, 200, { ok: true, name: path.basename(out) });
}

// Fill a scene from a reserve folder: its first 6 audio files → the 6 layers.
async function apiFillScene(res, body) {
  if (!activeRoot) return fail(res, 400, 'Aucune racine ouverte.');
  const srcDir = stagingPath(body.folder || '');
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    return fail(res, 400, 'Dossier introuvable.');
  }
  const files = (await listAudioFiles(srcDir)).slice(0, 6);   // sorted alpha, first 6
  if (!files.length) return fail(res, 400, 'Aucun audio dans ce dossier.');
  const dir = slotDir('scene', 1, body.bank, body.cell);
  await ensureDir(dir);
  const restore = [];
  for (const f of await listAudioFiles(dir)) {                // replace the whole scene
    const src = path.join(dir, f.name);
    restore.push({ trash: await toTrash(src), orig: path.relative(activeRoot, src), base: 'root' });
  }
  let layer = 1;
  for (const f of files) {
    const ext = path.extname(f.name);
    const stem = path.basename(f.name, ext).replace(/^\d+_/, '');
    const out = await uniquePath(dir, `${layer}_${stem}${ext}`);
    await fsp.copyFile(path.join(srcDir, f.name), out);
    layer++;
  }
  sendJSON(res, 200, { ok: true, count: files.length, restore });
}

// Copy an existing slot/scene sample OUT into the staging tree (non-destructive).
async function apiCopyToStaging(res, body) {
  if (!activeRoot) return fail(res, 400, 'Aucune racine ouverte.');
  const src = path.resolve(activeRoot, body.rel || '');
  if (!isInside(activeRoot, src) || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
    return fail(res, 400, 'Sample introuvable.');
  }
  const destDir = stagingPath(body.to || '');
  await ensureDir(destDir);
  const ext = path.extname(src);
  const stem = path.basename(src, ext).replace(/^\d+_/, ''); // drop the load-order prefix
  const out = await uniquePath(destDir, `${stem}${ext}`);
  await fsp.copyFile(src, out);
  sendJSON(res, 200, { ok: true, name: path.basename(out) });
}

// Overwrite an existing sample with edited audio (raw WAV body).
// The original is copied to .trash first, so the edit is reversible.
async function apiWriteSample(req, res, query) {
  if (!activeRoot) return fail(res, 400, 'Aucune racine ouverte.');
  const full = path.resolve(activeRoot, query.path || '');
  if (!isInside(activeRoot, full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return fail(res, 400, 'Fichier introuvable.');
  }
  const buf = await readBody(req);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    return fail(res, 400, 'Données audio invalides.');
  }
  const orig = path.relative(activeRoot, full);
  const trash = await toTrash(full);            // move the original aside, then write the edit
  await fsp.writeFile(full, buf);
  sendJSON(res, 200, { ok: true, restore: { trash, orig, base: 'root', overwrite: true } });
}

// Rename a sample inside a slot. Keeps the numeric load-order prefix.
async function apiRename(res, body) {
  const kind = body.kind === 'scene' ? 'scene' : 'library';
  const dir = slotDir(kind, body.lib || 1, body.bank, body.cell);
  const src = path.join(dir, safeName(body.from));
  if (!isInside(activeRoot, src) || !fs.existsSync(src)) {
    return fail(res, 400, 'File not found.');
  }
  const ext = path.extname(src);
  const prefixMatch = path.basename(src).match(/^(\d+_)/);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  let newStem = safeName(body.to).replace(/\.[^.]+$/, '').replace(/^\d+_/, '');
  if (!newStem) return fail(res, 400, 'Empty name.');
  const dest = await uniquePath(dir, `${prefix}${newStem}${ext}`);
  await fsp.rename(src, dest);
  sendJSON(res, 200, { ok: true, name: path.basename(dest) });
}

// Delete = move to an in-app .trash folder (reversible, never hard-deletes).
// Returns a restore descriptor so the UI can offer an undo.
async function apiDelete(res, body) {
  let src, base;
  if (body.staging) {
    src = stagingPath(body.path || body.name || '');
    base = 'staging';
  } else {
    const kind = body.kind === 'scene' ? 'scene' : 'library';
    const dir = slotDir(kind, body.lib || 1, body.bank, body.cell);
    src = path.join(dir, safeName(body.name));
    if (!isInside(activeRoot, src)) return fail(res, 403, 'Forbidden.');
    base = 'root';
  }
  if (!fs.existsSync(src)) return fail(res, 400, 'File not found.');
  const orig = path.relative(base === 'staging' ? STAGING_DIR : activeRoot, src);
  const trash = await toTrash(src);
  sendJSON(res, 200, { ok: true, restore: { trash, orig, base } });
}

// Clear a whole slot / scene folder (all audio files) → trash, with undo info.
async function apiClearSlot(res, body) {
  const kind = body.kind === 'scene' ? 'scene' : 'library';
  const dir = slotDir(kind, body.lib || 1, body.bank, body.cell);
  const restore = [];
  for (const f of await listAudioFiles(dir)) {
    const src = path.join(dir, f.name);
    const orig = path.relative(activeRoot, src);
    const trash = await toTrash(src);
    restore.push({ trash, orig, base: 'root' });
  }
  sendJSON(res, 200, { ok: true, restore });
}

// Restore trashed items back to their original locations (undo).
async function apiRestore(res, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) {
    const trashPath = path.join(TRASH_DIR, safeName(it.trash || ''));
    if (!isInside(TRASH_DIR, trashPath) || !fs.existsSync(trashPath)) continue;
    const baseDir = it.base === 'staging' ? STAGING_DIR : activeRoot;
    if (!baseDir) continue;
    let dest = path.resolve(baseDir, it.orig || '');
    if (!isInside(baseDir, dest)) continue;
    await ensureDir(path.dirname(dest));
    if (fs.existsSync(dest)) {
      if (it.overwrite) await toTrash(dest);      // undo of an edit: set the edited version aside
      else dest = await uniquePath(path.dirname(dest), path.basename(dest));
    }
    await fsp.rename(trashPath, dest);
  }
  sendJSON(res, 200, { ok: true });
}

// Return the last opened root plus whether it still exists / looks valid.
async function apiConfig(res) {
  const cfg = loadConfig();
  const lastRoot = cfg.lastRoot || null;
  let exists = false, hasArbhar = false;
  if (lastRoot && fs.existsSync(lastRoot)) {
    exists = true;
    hasArbhar = hasArbharFolders(lastRoot);
  }
  sendJSON(res, 200, { lastRoot, exists, hasArbhar });
}

// Browse a folder in the staging tree, honouring the manual order.
async function apiStagingList(res, query) {
  await ensureDir(STAGING_DIR);
  const rel = (query.path || '').replace(/^\/+|\/+$/g, '');
  const dir = stagingPath(rel);
  let raw = [];
  try { raw = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* gone */ }
  const dirs = raw.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  const files = await listAudioFiles(dir);
  const alpha = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const entries = [
    ...dirs.map((n) => ({ name: n, isDir: true })).sort(alpha),
    ...files.map((f) => ({ name: f.name, isDir: false, size: f.size, info: f.info })).sort(alpha),
  ];
  const parent = rel === '' ? null : (path.dirname(rel) === '.' ? '' : path.dirname(rel));
  sendJSON(res, 200, { root: STAGING_DIR, path: rel, parent, entries });
}

// Create a folder in the staging tree.
async function apiStagingMkdir(res, body) {
  const name = safeName(body.name || '');
  if (!name) return fail(res, 400, 'Nom de dossier vide.');
  const dir = stagingPath(path.join(body.path || '', name));
  await ensureDir(dir);
  sendJSON(res, 200, { ok: true });
}

// Move a staged file/folder into another staging folder.
async function apiStagingMove(res, body) {
  const src = stagingPath(body.from || '');
  const destDir = stagingPath(body.to || '');
  if (!fs.existsSync(src)) return fail(res, 400, 'Élément introuvable.');
  await ensureDir(destDir);
  // No-op if already there; refuse moving a folder into itself/its descendant.
  if (path.dirname(src) === destDir) return sendJSON(res, 200, { ok: true, moved: false });
  if (fs.statSync(src).isDirectory() && isInside(src, destDir)) {
    return fail(res, 400, 'Impossible de déplacer un dossier dans lui-même.');
  }
  const dest = await uniquePath(destDir, path.basename(src));
  await fsp.rename(src, dest);
  sendJSON(res, 200, { ok: true, moved: true });
}

// ---------------------------------------------------------------------------
// static file serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!isInside(PUBLIC_DIR, full)) return fail(res, 403, 'Forbidden.');
  try {
    const data = await fsp.readFile(full);
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  } catch {
    fail(res, 404, 'Not found.');
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (p.startsWith('/api/')) {
      // await every handler so a thrown error is caught here, never crashing.
      if (req.method === 'GET') {
        if (p === '/api/browse') return await apiBrowse(res, q);
        if (p === '/api/volumes') return await apiVolumes(res);
        if (p === '/api/grid') return await apiGrid(res, q);
        if (p === '/api/audio') return await apiAudio(req, res, q);
        if (p === '/api/staging-audio') return await apiStagingAudio(req, res, q);
        if (p === '/api/staging') return await apiStagingList(res, q);
        if (p === '/api/config') return await apiConfig(res);
      } else if (req.method === 'POST') {
        if (p === '/api/open') return await apiOpen(res, await readJSON(req));
        if (p === '/api/import') return await apiImport(req, res, q);
        if (p === '/api/write-sample') return await apiWriteSample(req, res, q);
        if (p === '/api/copy-from-staging') return await apiCopyFromStaging(res, await readJSON(req));
        if (p === '/api/copy-to-staging') return await apiCopyToStaging(res, await readJSON(req));
        if (p === '/api/fill-scene') return await apiFillScene(res, await readJSON(req));
        if (p === '/api/rename') return await apiRename(res, await readJSON(req));
        if (p === '/api/delete') return await apiDelete(res, await readJSON(req));
        if (p === '/api/clear-slot') return await apiClearSlot(res, await readJSON(req));
        if (p === '/api/restore') return await apiRestore(res, await readJSON(req));
        if (p === '/api/staging/mkdir') return await apiStagingMkdir(res, await readJSON(req));
        if (p === '/api/staging/move') return await apiStagingMove(res, await readJSON(req));
      }
      return fail(res, 404, 'Unknown API route.');
    }

    return await serveStatic(req, res, p);
  } catch (err) {
    try { fail(res, 400, err.message || 'Server error.'); } catch { /* headers already sent */ }
  }
});

// Safety net: never let a stray rejection take the whole server down.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  arbhar — unofficial library manager');
  console.log('  ───────────────────────────────────');
  console.log(`  ▸ open ${url}\n`);
  // Best-effort auto-open the default browser (mac / windows / linux).
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  require('child_process').exec(cmd, () => { /* ignore if no browser */ });
});
