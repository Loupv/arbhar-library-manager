'use strict';

/* arbhar library editor — front-end. Vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);
const api = {
  async get(path) { const r = await fetch(path); if (!r.ok) throw new Error((await r.json()).error || r.statusText); return r.json(); },
  async post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText); return r.json();
  },
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

/* ===================== FOLDER PICKER ===================== */
let pickerPath = null;

async function loadShortcuts() {
  const { shortcuts } = await api.get('/api/volumes');
  const ul = $('#pk-shortcuts');
  ul.innerHTML = '';
  shortcuts.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.label;
    li.onclick = () => browseTo(s.path);
    ul.appendChild(li);
  });
}

async function browseTo(dir) {
  try {
    const data = await api.get('/api/browse?path=' + encodeURIComponent(dir));
    pickerPath = data.path;
    $('#pk-path').value = data.path;
    const list = $('#pk-list');
    list.innerHTML = '';
    data.dirs.forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      const isLib = /^_arbhar_/.test(name);
      if (isLib) li.classList.add('is-arbhar');
      li.ondblclick = () => browseTo(joinPath(data.path, name));
      li.onclick = () => browseTo(joinPath(data.path, name));
      list.appendChild(li);
    });
    const st = $('#pk-status');
    if (data.isArbhar) {
      st.textContent = '◆ arbhar structure detected in this folder — ready to open.';
      st.className = 'picker-status good';
    } else {
      st.textContent = 'No arbhar structure here. Tick “create the structure” to initialise one.';
      st.className = 'picker-status';
    }
    $('#pk-open').disabled = false;
    $('#pk-up').dataset.parent = data.parent || '';
  } catch (e) { toast(e.message, true); }
}
function joinPath(base, name) { return base.replace(/\/$/, '') + '/' + name; }

$('#pk-up').onclick = () => { const p = $('#pk-up').dataset.parent; if (p) browseTo(p); };
$('#pk-go').onclick = () => browseTo($('#pk-path').value.trim());
$('#pk-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') browseTo($('#pk-path').value.trim()); });

async function openRoot(root, scaffold) {
  const data = await api.post('/api/open', { root, scaffold });
  state.root = data.root;
  state.present = data.present;
  enterApp();
  if (data.adjusted) toast('Root auto-adjusted to: ' + data.root);
  const anyFolder = Object.values(data.present).some(Boolean);
  if (!anyFolder && !scaffold) {
    toast('No _arbhar_* folder found at this root — check the chosen folder.', true);
  }
}

$('#pk-open').onclick = async () => {
  try { await openRoot(pickerPath, $('#pk-scaffold').checked); }
  catch (e) { toast(e.message, true); }
};

/* ===================== APP ===================== */
function enterApp() {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#root-path').textContent = state.root;
  $('#root-path').title = state.root;
  buildTabs();
  loadStaging();
  selectTab('library', 1);
}

$('#change-root').onclick = () => {
  stopPlayback();                         // leaving the app screen stops audio
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#pk-close').classList.remove('hidden');   // a library is open → allow closing back to it
  if (state.root) browseTo(state.root);        // position the picker on the current folder
};

// Close the picker and return to the current library (only shown when one is open).
$('#pk-close').onclick = () => {
  if (!state.root) return;
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
      const count = c.files.length > 1 ? `<span class="pad-count">+${c.files.length - 1} autres</span>` : '';
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
          e.dataTransfer.setData('application/x-arbhar-file', JSON.stringify({ path: rel, name: c.files[0].name }));
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      wireExternalDrop(pad, { bank, cell });
      wireStagingDrop(pad, { bank, cell });
      grid.appendChild(pad);
    }
  }
}

/* ---------- scenes view ---------- */
// The file whose numeric prefix maps to a scene layer (1..6).
function layerFile(cell, layer) {
  return (cell.files || []).find((f) => new RegExp(`^${layer}_`).test(f.name)) || null;
}

function selRow(label, active, onPick, filledFn) {
  const row = document.createElement('div');
  row.className = 'sel-row';
  row.innerHTML = `<span class="sel-label">${label}</span>`;
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button');
    b.className = 'sel-btn' + (i === active ? ' active' : '') + (filledFn(i) ? ' filled' : '');
    b.textContent = i;
    b.onclick = () => onPick(i);
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
  controls.appendChild(selRow('Bank', state.sceneBank, (v) => { stopPlayback(); clearEditor(); state.sceneBank = v; state.sceneLayer = 1; renderSceneView(); }, bankFilled));
  controls.appendChild(selRow('Scene', state.sceneCell, (v) => { stopPlayback(); clearEditor(); state.sceneCell = v; state.sceneLayer = 1; renderSceneView(); }, sceneFilled));
  if (cur.hasPreset) {
    const p = document.createElement('div');
    p.className = 'preset-note';
    p.textContent = '⬥ preset.txt present in this scene (preserved)';
    controls.appendChild(p);
  }

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
      <div class="lt-meta">${f ? (info ? info + ' · ' : '') + fmtSize(f.size) : 'glisse un .wav ici'}</div>`;
    tile.onclick = () => selectLayer(L);
    if (f) {
      tile.querySelector('.rn').onclick = (e) => { e.stopPropagation(); startRename(tile, f, state.sceneBank, state.sceneCell); };
      tile.querySelector('.del').onclick = (e) => { e.stopPropagation(); deleteFile(f, state.sceneBank, state.sceneCell); };
      tile.draggable = true;
      tile.addEventListener('dragstart', (e) => {
        const rel = slotRel(state.sceneBank, state.sceneCell) + '/' + f.name;
        e.dataTransfer.setData('application/x-arbhar-file', JSON.stringify({ path: rel, name: f.name }));
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    wireLayerDrop(tile, L);
    grid.appendChild(tile);
  }
}

function selectLayer(layer, { play = true } = {}) {
  state.sceneLayer = layer;
  renderSceneView();
  const sel = $('#scene-grid .layer-tile.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const cur = cellAt(state.sceneBank, state.sceneCell) || { files: [] };
  const f = layerFile(cur, layer);
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
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-arbhar-staging')) {
      e.preventDefault(); el.classList.add('over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('over');
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
    if (state.selected && state.selected.bank === bank && state.selected.cell === cell) {
      state.selected = null; clearEditor();
    }
    await loadGrid();
    toast(`Slot ${bank}.${cell} cleared.`, false, () => undoRestore(r.restore));
  } catch (e) { toast(e.message, true); }
}

// Select a slot (shared by click + keyboard) and audition its first sample.
function selectSlot(bank, cell, { play = true } = {}) {
  state.selected = { bank, cell };
  renderGrid();
  renderInspector();
  const sel = $('#grid .pad.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const cc = cellAt(bank, cell);
  if (cc && cc.files.length) {
    const first = cc.files[0];
    const rel = slotRel(bank, cell) + '/' + first.name;
    if (play) playAudio('/api/audio?path=' + encodeURIComponent(rel), prettyName(first.name), $('#insp-list .file-row'));
    setEditor(rel, first.name);
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
  const drop = $('#insp-drop');
  list.innerHTML = '';
  if (!state.selected) {
    empty.classList.remove('hidden'); drop.classList.add('hidden');
    clearEditor();
    return;
  }
  empty.classList.add('hidden'); drop.classList.remove('hidden');
  const { bank, cell } = state.selected;
  const c = cellAt(bank, cell) || { files: [] };
  c.files.forEach((f) => list.appendChild(fileRow(f, bank, cell)));
  if (!c.files.length) {
    const p = document.createElement('p');
    p.className = 'empty-note'; p.style.marginTop = '20px';
    p.textContent = 'Empty slot — drop a sample or drag one from the reserve.';
    list.appendChild(p);
  }
}

function fileRow(f, bank, cell) {
  const li = document.createElement('li');
  li.className = 'file-row';
  li.draggable = true;
  const relPath = slotRel(bank, cell) + '/' + f.name;
  const info = f.info ? `${(f.info.sampleRate / 1000).toFixed(f.info.sampleRate % 1000 ? 1 : 0)}k · ${f.info.bits}bit · ${f.info.channels === 2 ? 'stéréo' : 'mono'}` : '';
  const ideal = f.info && f.info.sampleRate === 48000 && f.info.bits === 24;
  li.innerHTML = `<span class="play">▶</span>
    <div class="file-main">
      <div class="file-name">${escapeHtml(prettyName(f.name))}</div>
      <div class="file-meta">
        ${info ? `<span class="badge ${ideal ? 'ok' : ''}">${info}</span>` : ''}
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
    e.dataTransfer.setData('application/x-arbhar-file', JSON.stringify({ path: relPath, name: f.name }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  return li;
}

function slotRel(bank, cell) {
  if (state.kind === 'scene') return `_arbhar_scenes/${bank}_${cell}_scene`;
  return `${LIB_FOLDERS[state.lib - 1]}/${bank}_${cell}_sample`;
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
    await loadGrid();
    if (state.kind !== 'scene') renderInspector();
    if (editor.name === f.name) clearEditor();
    toast('Removed to trash.', false, () => undoRestore(r.restore));
  } catch (e) { toast(e.message, true); }
}

/* ===================== RESERVE (accordion tree) ===================== */
async function loadStaging() {
  const ul = $('#staging-list');
  ul.innerHTML = '';
  const total = await renderNode('', 0, ul);
  $('#staging-panel').classList.toggle('has-items', total > 0);
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
        playAudio('/api/staging-audio?path=' + encodeURIComponent(rel), name, li);
        playingStagingPath = rel;                 // remember it's a reserve sample
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
async function mkdirIn(parent) {
  const name = prompt('New subfolder name:');
  if (!name || !name.trim()) return;
  try { await api.post('/api/staging/mkdir', { path: parent, name: name.trim() }); state.expanded.add(parent); loadStaging(); toast('Folder created.'); }
  catch (e) { toast(e.message, true); }
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
      try { await api.post('/api/staging/move', { from: item.path, to: folderRel }); state.expanded.add(folderRel); toast('Moved.'); loadStaging(); }
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

$('#stg-mkdir').onclick = async () => {
  const name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  try { await api.post('/api/staging/mkdir', { path: '', name: name.trim() }); loadStaging(); toast('Folder created.'); }
  catch (e) { toast(e.message, true); }
};

/* ===================== DRAG & DROP ===================== */
const AUDIO_RE = /\.(wav|aif|aiff)$/i;

// External files (from Finder) → upload raw bytes.
async function uploadFiles(fileList, destQuery) {
  let ok = 0;
  for (const file of [...fileList]) {
    try {
      await fetch(`/api/import?${destQuery}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
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
      const files = [...e.dataTransfer.files];
      let ok = 0;
      for (let i = 0; i < files.length; i++) {
        const rep = i === 0 ? '&replace=1' : '';            // first replaces, extras append
        ok += await uploadFiles([files[i]], `dest=slot&kind=${state.kind}&lib=${state.lib}&bank=${slot.bank}&cell=${slot.cell}${rep}`);
      }
      if (ok) toast(`Slot ${slot.bank}.${slot.cell} replaced.`);
      await loadGrid();
      selectSlot(slot.bank, slot.cell, { play: false });
    }
  });
}

// Drop a staged sample onto a pad (library) → replace the slot.
function wireStagingDrop(el, slot) {
  el.addEventListener('drop', async (e) => {
    const stg = e.dataTransfer.getData('application/x-arbhar-staging');
    if (!stg) return;
    e.preventDefault(); el.classList.remove('over');
    const item = JSON.parse(stg);
    if (item.isDir) return;
    try {
      await api.post('/api/copy-from-staging', { path: item.path, kind: state.kind, lib: state.lib, bank: slot.bank, cell: slot.cell, replace: true });
      toast(`Slot ${slot.bank}.${slot.cell} ← “${item.name}”.`);
      await loadGrid();
      selectSlot(slot.bank, slot.cell, { play: false });
    } catch (err) { toast(err.message, true); }
  });
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

// Inspector dropzone → REPLACE the selected slot
const inspDrop = $('#insp-drop');
['dragover', 'dragenter'].forEach((ev) => inspDrop.addEventListener(ev, (e) => {
  if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-arbhar-staging')) {
    e.preventDefault(); inspDrop.classList.add('over');
  }
}));
['dragleave'].forEach((ev) => inspDrop.addEventListener(ev, () => inspDrop.classList.remove('over')));
inspDrop.addEventListener('drop', async (e) => {
  inspDrop.classList.remove('over');
  if (!state.selected) return;
  const { bank, cell } = state.selected;
  const stg = e.dataTransfer.getData('application/x-arbhar-staging');
  if (stg) {
    e.preventDefault();
    const item = JSON.parse(stg);
    if (item.isDir) return;
    try { await api.post('/api/copy-from-staging', { path: item.path, kind: state.kind, lib: state.lib, bank, cell, replace: true }); toast('Slot replaced.'); await loadGrid(); selectSlot(bank, cell, { play: false }); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (e.dataTransfer.files.length) {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const rep = i === 0 ? '&replace=1' : '';
      ok += await uploadFiles([files[i]], `dest=slot&kind=${state.kind}&lib=${state.lib}&bank=${bank}&cell=${cell}${rep}`);
    }
    if (ok) toast('Slot replaced.');
    await loadGrid(); selectSlot(bank, cell, { play: false });
  }
});

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
  const typing = /^(input|textarea)$/i.test(t.tagName) || t.isContentEditable;
  if (typing) return;                                         // don't hijack while editing a name

  if (e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
  else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key.startsWith('Arrow')) { e.preventDefault(); moveSelection(e.key); }
});

/* ===================== AUDIO PLAYER ===================== */
const audio = $('#audio');
let currentRow = null;
let playingStagingPath = null;   // reserve path of the playing sample, if it came from the reserve

function playAudio(src, name, row) {
  if (currentRow) currentRow.classList.remove('playing');
  currentRow = row; if (row) row.classList.add('playing');
  playingStagingPath = null;     // reset; the reserve caller sets it right after
  audio.src = src;
  audio.play().catch(() => {});
  $('#pl-name').textContent = name;
  $('#pl-toggle').disabled = false;
  $('#pl-toggle').textContent = '❚❚';
}

// Stop and reset the persistent player (used when leaving the audio's context).
function stopPlayback() {
  audio.pause();
  audio.removeAttribute('src');
  try { audio.load(); } catch { /* ignore */ }
  if (currentRow) currentRow.classList.remove('playing');
  currentRow = null;
  playingStagingPath = null;
  $('#pl-toggle').textContent = '▶';
  $('#pl-toggle').disabled = true;
  $('#pl-name').textContent = '—';
  $('#pl-progress').style.width = '0%';
  $('#pl-time').textContent = '0:00';
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
const editor = { rel: null, name: null, buf: null, sel: { start: 0, end: 1 }, fadeIn: 0, fadeOut: 0, ac: null, previewSrc: null, drag: null, normalize: false, normDb: parseFloat(localStorage.getItem('arbhar-norm-db') || '-1') };

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

async function setEditor(rel, name) {
  editor.rel = rel; editor.name = name;
  editor.sel = { start: 0, end: 1 }; editor.fadeIn = 0; editor.fadeOut = 0; editor.normalize = false;
  $('#fade-in').value = 0; $('#fade-out').value = 0;
  $('#fade-in-val').textContent = '0 ms'; $('#fade-out-val').textContent = '0 ms';
  $('#normalize').checked = false; $('#norm-db').value = editor.normDb;
  $('#editor').classList.remove('hidden');
  $('#insp-empty').classList.add('hidden');
  $('#insp-sub').textContent = prettyName(name);
  try {
    const arr = await fetch('/api/audio?path=' + encodeURIComponent(rel)).then((r) => r.arrayBuffer());
    editor.buf = await audioCtx().decodeAudioData(arr);
  } catch (e) { editor.buf = null; toast('Audio decoding failed.', true); }
  drawWave();
}
function clearEditor() {
  editor.rel = null; editor.buf = null;
  $('#editor').classList.add('hidden');
  $('#insp-sub').textContent = '';
}
function selDuration() { return editor.buf ? (editor.sel.end - editor.sel.start) * editor.buf.duration : 0; }

function drawWave() {
  const canvas = $('#wave');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 280, H = 130;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!editor.buf) return;
  const ch = editor.buf.getChannelData(0), n = ch.length, mid = H / 2;
  const g = normGain();                          // reflect normalization live
  ctx.strokeStyle = 'rgba(201,161,91,0.85)';
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const s0 = Math.floor(x / W * n), s1 = Math.max(s0 + 1, Math.floor((x + 1) / W * n));
    let mn = 1, mx = -1;
    for (let i = s0; i < s1; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    mx = Math.max(-1, Math.min(1, mx * g)); mn = Math.max(-1, Math.min(1, mn * g));
    ctx.moveTo(x + 0.5, mid - mx * mid * 0.9);
    ctx.lineTo(x + 0.5, mid - mn * mid * 0.9);
  }
  ctx.stroke();
  const sx = editor.sel.start * W, ex = editor.sel.end * W;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, sx, H); ctx.fillRect(ex, 0, W - ex, H);
  ctx.strokeStyle = '#e2c489'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke();
  ctx.lineWidth = 1;
  const selW = ex - sx, dur = selDuration();
  const fi = dur > 0 ? Math.min(1, (editor.fadeIn / 1000) / dur) : 0;
  const fo = dur > 0 ? Math.min(1, (editor.fadeOut / 1000) / dur) : 0;
  ctx.strokeStyle = 'rgba(226,196,137,0.75)';
  ctx.beginPath();
  ctx.moveTo(sx, H); ctx.lineTo(sx + selW * fi, 0);
  ctx.moveTo(ex, H); ctx.lineTo(ex - selW * fo, 0);
  ctx.stroke();
  $('#edit-info').innerHTML = `durée <b>${fmtDur(editor.buf.duration)}</b> · sélection <b>${fmtDur(dur)}</b> · ${editor.buf.sampleRate / 1000}k · ${editor.buf.numberOfChannels === 2 ? 'stéréo' : 'mono'}`;
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
  const rel = editor.rel, name = editor.name;
  try {
    const r = await fetch('/api/write-sample?path=' + encodeURIComponent(rel), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encodeWav24(chans, sampleRate),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const data = await r.json();
    await loadGrid();
    await setEditor(rel, name);
    toast('Sample edited ✓', false, async () => {
      await api.post('/api/restore', { items: [data.restore] });
      await loadGrid(); await setEditor(rel, name); toast('Edit reverted.');
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
    editor.drag = Math.abs(f - editor.sel.start) <= Math.abs(f - editor.sel.end) ? 'start' : 'end';
    canvas.setPointerCapture(e.pointerId); move(f);
  });
  canvas.addEventListener('pointermove', (e) => { if (editor.drag) move(frac(e)); });
  canvas.addEventListener('pointerup', () => { editor.drag = null; });
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
  await loadShortcuts();
  // Reopen the last used library automatically when it is still available.
  const cfg = await api.get('/api/config').catch(() => ({}));
  if (cfg.lastRoot && cfg.exists && cfg.hasArbhar) {
    try { await openRoot(cfg.lastRoot, false); return; }
    catch { /* fall through to the picker */ }
  }
  if (cfg.lastRoot && !cfg.exists) {
    toast('Last folder not found (USB unplugged?) — pick one.', true);
  }
  await browseTo(cfg.lastRoot && cfg.exists ? cfg.lastRoot : '');
})().catch((e) => toast(e.message, true));
