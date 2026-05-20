// Roadmap - Tauri frontend
// Ported from the standalone HTML artifact, with localStorage swapped for
// Tauri file commands and the macOS native menu wired up.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ----- Constants -----

const SCHEMA_VERSION = 5;
const AUTOSAVE_DEBOUNCE_MS = 400;

const DEFAULT_CONFIG = {
  startYear: 2026,
  startMonth: 1,
  endYear: 2027,
  endMonth: 12,
  labelColumnWidth: 200
};

const MONTH_LABELS = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

const LABEL_MIN_WIDTH = 100;
const LABEL_MAX_WIDTH = 500;
const MONTH_WIDTH_PX = 60;

const YEAR_BAND_COLORS = ['#2F7060', '#1E4F44', '#133933', '#082823', '#2F7060', '#1E4F44'];
const QUARTER_CELL_COLORS = ['#EFF6F3', '#DCEBE6', '#BCD8D0', '#9CC4B8', '#EFF6F3', '#DCEBE6'];

const LEGEND_DEFAULTS = [
  {id:'ongoing', label:'Pågående', color:'#888780'},
  {id:'committed', label:'Committed', color:'#378ADD'},
  {id:'priority', label:'Prioriterat', color:'#1D9E75'},
  {id:'maybe', label:'Eventuellt', color:'#BA7517'},
  {id:'growth', label:'Tillväxt', color:'#7F77DD'},
  {id:'dependency', label:'Beroende', color:'#A32D2D', dashed:true},
  {id:'new', label:'Nytt', color:'#D85A30'}
];

// ----- State -----

const state = {
  config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  initiatives: [],
  legend: deepClone(LEGEND_DEFAULTS),
  selected: null,
  editingLegend: null,
  pendingConfirm: null,
  reorderDragId: null,
  reorderDropTarget: null,
  reorderDropPosition: null
};

let currentFilePath = null;
let dragState = null;
let labelResizeState = null;
let cachedMonths = null;
let cachedYears = null;
let saveTimer = null;
let suppressAutosave = false;
let welcomeDismissed = false;
let renamingId = null;
let clickTimer = null;
const CLICK_DELAY_MS = 220;

// ----- Helpers -----

function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

function months(){
  if(cachedMonths) return cachedMonths;
  const c = state.config;
  const arr = [];
  let y = c.startYear, m = c.startMonth;
  let safety = 2000;
  while(safety-- > 0 && (y < c.endYear || (y === c.endYear && m <= c.endMonth))){
    arr.push({label: MONTH_LABELS[m-1], year: y, month: m});
    m++;
    if(m > 12){ m = 1; y++; }
  }
  cachedMonths = arr;
  return arr;
}

function years(){
  if(cachedYears) return cachedYears;
  const ms = months();
  const groups = [];
  let current = null;
  ms.forEach((mObj, idx) => {
    const yr = String(mObj.year);
    if(current && current.label === yr){
      current.span++;
      current.endIdx = idx;
    } else {
      current = {label: yr, span: 1, startIdx: idx, endIdx: idx};
      groups.push(current);
    }
  });
  return cachedYears = groups;
}

function quarterBands(){
  // Group months into quarters for the header row (Q1-Q4 within each year)
  const ms = months();
  const groups = [];
  let current = null;
  ms.forEach((mObj, idx) => {
    const qNum = Math.floor((mObj.month - 1) / 3) + 1;
    const key = mObj.year + '-Q' + qNum;
    if(current && current.key === key){
      current.span++;
    } else {
      current = {key, label: 'Q' + qNum, span: 1, year: mObj.year};
      groups.push(current);
    }
  });
  return groups;
}

function invalidateCache(){
  cachedMonths = null;
  cachedYears = null;
}

function isYearEmpty(yearGroup){
  return !state.initiatives.some(init =>
    init.position && init.position.s <= yearGroup.endIdx && init.position.e >= yearGroup.startIdx
  );
}

function canRemoveYear(yearGroup){
  const ys = years();
  if(ys.length <= 1) return false;
  const isFirst = yearGroup.label === ys[0].label;
  const isLast = yearGroup.label === ys[ys.length-1].label;
  if(!isFirst && !isLast) return false;
  return isYearEmpty(yearGroup);
}

function addYearAtEnd(){
  state.config.endYear++;
  state.config.endMonth = 12;
  invalidateCache();
  render();
}

function removeYear(yearGroup){
  const ys = years();
  const isFirst = yearGroup.label === ys[0].label;
  const numMonths = yearGroup.span;
  if(isFirst){
    state.initiatives.forEach(init => {
      init.position.s -= numMonths;
      init.position.e -= numMonths;
    });
    state.config.startYear = +yearGroup.label + 1;
    state.config.startMonth = 1;
  } else {
    state.config.endYear = +yearGroup.label - 1;
    state.config.endMonth = 12;
  }
  invalidateCache();
  render();
}

function findInit(id){ return state.initiatives.find(x => x.id === id); }
function legendFor(typeId){ return state.legend.find(x => x.id === typeId); }

function setPosition(init, start, end){
  init.position = {s:start, e:end};
}

// ----- Persistence (Tauri file-backed, replaces localStorage) -----

function buildSerializableData(){
  return {
    v: SCHEMA_VERSION,
    config: state.config,
    initiatives: state.initiatives,
    legend: state.legend,
    savedAt: new Date().toISOString()
  };
}

function applyLoadedData(data){
  // Detect v4 quarter-based format and convert to v5 month-based
  const isQuarterFormat = data.config && (data.config.startQuarter !== undefined || data.config.endQuarter !== undefined);
  if(data.config){
    if(isQuarterFormat){
      // Convert quarter config to month config
      const sq = data.config.startQuarter || 1;
      const eq = data.config.endQuarter || 4;
      data.config.startMonth = (sq - 1) * 3 + 1;
      data.config.endMonth = eq * 3;
      delete data.config.startQuarter;
      delete data.config.endQuarter;
    }
    state.config = Object.assign(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), data.config);
  }
  if(Array.isArray(data.initiatives)){
    data.initiatives.forEach(init => {
      // Tolerate older positions[] (per-scenario) format
      if(Array.isArray(init.positions) && !init.position){
        init.position = init.positions[0] || {s:0, e:0};
        delete init.positions;
        delete init.offsets;
      }
      if(!init.position) init.position = {s:0, e:0};
      // Convert quarter-index positions to month-index (each Q = 3 months)
      if(isQuarterFormat){
        init.position.s = init.position.s * 3;
        init.position.e = init.position.e * 3 + 2;
      }
    });
    state.initiatives = data.initiatives;
  }
  if(Array.isArray(data.legend)) state.legend = data.legend;
}

async function persistToFile(path){
  const data = buildSerializableData();
  const json = JSON.stringify(data, null, 2);
  try {
    await invoke("write_roadmap_file", { path, contents: json });
  } catch(e){
    console.error("[Roadmap] write failed:", e);
  }
}

function scheduleAutosave(){
  if(suppressAutosave) return;
  if(!currentFilePath) return;
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistToFile(currentFilePath);
  }, AUTOSAVE_DEBOUNCE_MS);
}

async function loadFromFile(path){
  try {
    const contents = await invoke("read_roadmap_file", { path });
    const data = JSON.parse(contents);
    suppressAutosave = true;
    applyLoadedData(data);
    invalidateCache();
    suppressAutosave = false;
    currentFilePath = path;
    await invoke("add_recent_file", { path });
    await invoke("refresh_menu");
    await updateWindowTitle();
    render();
  } catch(e){
    console.error("[Roadmap] load failed:", e);
    alert("Kunde inte öppna filen: " + e);
  }
}

function basenameOf(path){
  if(!path) return null;
  const segs = path.split(/[\\/]/);
  const last = segs[segs.length - 1];
  return last.replace(/\.roadmap$/i, '');
}

async function updateWindowTitle(){
  const name = basenameOf(currentFilePath) || 'Untitled';
  const title = name + ' — Roadmap';
  const titleEl = document.getElementById('gantt-title');
  if(titleEl) titleEl.textContent = name;
  document.title = title;
  try {
    const win = getCurrentWindow();
    await win.setTitle(title);
  } catch(e){}
}

// ----- Render -----

function shouldShowWelcome(){
  if(welcomeDismissed) return false;
  return !currentFilePath && state.initiatives.length === 0;
}

async function renderWelcome(){
  const welcome = document.getElementById('welcome');
  if(!welcome) return;
  if(shouldShowWelcome()){
    welcome.classList.add('active');
    await renderWelcomeRecent();
  } else {
    welcome.classList.remove('active');
  }
}

async function renderWelcomeRecent(){
  try {
    const recents = await invoke('get_recent_files');
    const wrap = document.getElementById('welcome-recent');
    const list = document.getElementById('welcome-recent-list');
    if(!wrap || !list) return;
    if(!recents || recents.length === 0){
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    list.innerHTML = '';
    recents.slice(0, 5).forEach(path => {
      const name = basenameOf(path) || path;
      const li = document.createElement('li');
      const nameEl = document.createElement('span');
      nameEl.className = 'recent-name';
      nameEl.textContent = name;
      const pathEl = document.createElement('span');
      pathEl.className = 'recent-path';
      pathEl.textContent = path;
      pathEl.title = path;
      li.appendChild(nameEl);
      li.appendChild(pathEl);
      li.addEventListener('click', async () => {
        await loadFromFile(path);
      });
      list.appendChild(li);
    });
  } catch(e){
    console.error('[Roadmap] recents failed:', e);
  }
}

function render(){
  invalidateCache();
  const addYearBtn = document.getElementById('add-year');
  if(addYearBtn) addYearBtn.textContent = '+ Lägg till år ' + (state.config.endYear + 1);
  renderGrid();
  renderEditPanel();
  renderLegend();
  renderWelcome();
  scheduleAutosave();
}

function renderGrid(){
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  const qs = months();
  const ys = years();
  const labelW = state.config.labelColumnWidth || 200;
  grid.style.gridTemplateColumns = labelW + 'px repeat(' + qs.length + ', minmax(' + MONTH_WIDTH_PX + 'px, 1fr))';
  grid.style.minWidth = (labelW + qs.length * MONTH_WIDTH_PX) + 'px';

  const yb = document.createElement('div');
  yb.className = 'gh year-band sticky-col';
  yb.style.background = 'var(--bg-soft)';
  grid.appendChild(yb);
  ys.forEach((y, idx) => {
    const c = document.createElement('div');
    c.className = 'gh year-band';
    c.style.background = YEAR_BAND_COLORS[idx % YEAR_BAND_COLORS.length];
    c.style.gridColumn = 'span ' + y.span;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = y.label;
    c.appendChild(labelSpan);
    if(canRemoveYear(y)){
      const rm = document.createElement('button');
      rm.className = 'year-remove';
      rm.textContent = '×';
      rm.title = 'Ta bort år ' + y.label + ' (tomt)';
      rm.addEventListener('click', e => {
        e.stopPropagation();
        removeYearConfirm(y);
      });
      c.appendChild(rm);
    }
    // On the last year, append a "+" button to add another year
    if(idx === ys.length - 1){
      const add = document.createElement('button');
      add.className = 'year-add';
      add.textContent = '+';
      add.title = 'Lägg till år ' + (state.config.endYear + 1);
      add.addEventListener('click', e => {
        e.stopPropagation();
        addYearAtEnd();
      });
      c.appendChild(add);
    }
    grid.appendChild(c);
  });

  // Quarter band (between year and month)
  const qbBlank = document.createElement('div');
  qbBlank.className = 'gh sticky-col quarter-band';
  qbBlank.style.background = 'var(--bg-soft)';
  grid.appendChild(qbBlank);
  const qBands = quarterBands();
  qBands.forEach((qb) => {
    const c = document.createElement('div');
    c.className = 'gh quarter-band';
    c.style.gridColumn = 'span ' + qb.span;
    c.textContent = qb.label;
    grid.appendChild(c);
  });

  const blank = document.createElement('div');
  blank.className = 'gh sticky-col';
  blank.textContent = 'Initiativ';
  blank.style.textAlign = 'left';
  blank.style.paddingLeft = '12px';
  grid.appendChild(blank);

  let yearIdx = 0;
  let yearMonthsUsed = 0;
  qs.forEach((mObj) => {
    if(yearMonthsUsed >= ys[yearIdx].span){
      yearIdx++;
      yearMonthsUsed = 0;
    }
    const c = document.createElement('div');
    c.className = 'gh';
    c.style.background = QUARTER_CELL_COLORS[yearIdx % QUARTER_CELL_COLORS.length];
    c.style.color = '#133933';
    c.textContent = mObj.label;
    grid.appendChild(c);
    yearMonthsUsed++;
  });

  state.initiatives.forEach((init, idx) => {
    const isDragging = state.reorderDragId === init.id;
    const isDropTarget = state.reorderDropTarget === init.id;
    const dropClass = isDropTarget ? 'drop-' + state.reorderDropPosition : '';
    const qcellDropClass = isDropTarget ? 'row-drop-' + state.reorderDropPosition : '';

    const lc = document.createElement('div');
    lc.className = 'lbl-cell';
    const li = document.createElement('div');
    const isRenaming = renamingId === init.id;
    li.className = 'row-label' + (state.selected === init.id ? ' selected' : '') + (isDragging ? ' dragging-row' : '') + (dropClass ? ' ' + dropClass : '');
    const num = document.createElement('span');
    num.className = 'row-number' + (init.adjustable !== false ? ' drag-handle' : '');
    num.textContent = (idx + 1);
    li.appendChild(num);

    if(isRenaming){
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'lbl-input';
      input.value = init.label;
      input.addEventListener('mousedown', e => e.stopPropagation());
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('keydown', e => {
        if(e.key === 'Enter'){
          e.preventDefault();
          commitInlineRename(input.value);
        } else if(e.key === 'Escape'){
          e.preventDefault();
          cancelInlineRename();
        }
      });
      input.addEventListener('blur', () => commitInlineRename(input.value));
      li.appendChild(input);
    } else {
      const txt = document.createElement('span');
      txt.className = 'lbl-text';
      txt.textContent = init.label;
      txt.title = init.label;
      li.appendChild(txt);
    }

    if(init.weeks){
      const t = document.createElement('span');
      t.className = 'lbl-tag';
      t.textContent = init.weeks + 'v';
      li.appendChild(t);
    }
    if(init.adjustable !== false && !isRenaming){
      // Double-click on the row label triggers inline rename (Finder-style).
      // Single-click does nothing - opening the detail modal is done via the time bar instead.
      li.addEventListener('dblclick', () => {
        if(state.reorderDragId) return;
        startInlineRename(init.id);
      });
      attachReorderHandlers(li, num, init);
    }
    lc.appendChild(li);
    grid.appendChild(lc);

    const range = init.position;
    const legendItem = legendFor(init.type);
    qs.forEach((_, qi) => {
      const c = document.createElement('div');
      c.className = 'qcell' + (isDragging ? ' row-dragging' : '') + (qcellDropClass ? ' ' + qcellDropClass : '');
      if(qi === range.s && range.s >= 0 && range.s < qs.length){
        const b = document.createElement('div');
        const cls = ['bar'];
        if(init.dashed) cls.push('dashed');
        if(init.adjustable !== false) cls.push('adj');
        if(dragState && dragState.initId === init.id && dragState.dragged) cls.push('dragging');
        b.className = cls.join(' ');
        if(legendItem){
          if(init.dashed){
            b.style.color = legendItem.color;
            b.style.borderColor = legendItem.color;
          } else {
            b.style.background = legendItem.color;
          }
        }
        const span = Math.min(range.e, qs.length-1) - range.s + 1;
        b.style.width = 'calc(' + (span * 100) + '% - 8px)';

        const textSpan = document.createElement('span');
        textSpan.className = 'bar-text';
        textSpan.textContent = init.label;
        b.appendChild(textSpan);

        if(init.adjustable !== false){
          const leftH = document.createElement('div');
          leftH.className = 'resize-handle left';
          leftH.addEventListener('mousedown', e => onBarPointerDown(e, init, 'start'));
          b.appendChild(leftH);

          const rightH = document.createElement('div');
          rightH.className = 'resize-handle right';
          rightH.addEventListener('mousedown', e => onBarPointerDown(e, init, 'end'));
          b.appendChild(rightH);

          b.addEventListener('mousedown', e => {
            if(e.target === b || e.target === textSpan) onBarPointerDown(e, init, 'move');
          });
        }
        c.appendChild(b);
      }
      grid.appendChild(c);
    });
  });

  // Ghost row: "+ Lägg till initiativ" at the end of the grid
  const ghostLc = document.createElement('div');
  ghostLc.className = 'lbl-cell ghost-cell';
  const ghostLi = document.createElement('div');
  ghostLi.className = 'row-label ghost-row';
  ghostLi.textContent = '+ Lägg till initiativ';
  ghostLi.title = 'Lägg till ett nytt initiativ';
  ghostLi.addEventListener('click', addInit);
  ghostLc.appendChild(ghostLi);
  grid.appendChild(ghostLc);
  qs.forEach(() => {
    const c = document.createElement('div');
    c.className = 'qcell ghost-cell';
    c.addEventListener('click', addInit);
    grid.appendChild(c);
  });

  // Label resize handle outside grid in wrap (stays visually static during scroll)
  const wrap = document.querySelector('.gantt-grid-wrap');
  const existingHandle = wrap.querySelector('.label-resize-handle');
  if(existingHandle) existingHandle.remove();
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'label-resize-handle';
  resizeHandle.style.left = (labelW - 3) + 'px';
  resizeHandle.title = 'Dra för att ändra bredden på etikett-kolumnen';
  resizeHandle.addEventListener('mousedown', onLabelResizeStart);
  wrap.appendChild(resizeHandle);
}

function onLabelResizeStart(e){
  if(e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  labelResizeState = {
    startX: e.clientX,
    initialWidth: state.config.labelColumnWidth || 200,
    handle: e.currentTarget
  };
  labelResizeState.handle.classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.addEventListener('mousemove', onLabelResizeMove);
  document.addEventListener('mouseup', onLabelResizeEnd);
}

function onLabelResizeMove(e){
  if(!labelResizeState) return;
  const deltaX = e.clientX - labelResizeState.startX;
  let newWidth = labelResizeState.initialWidth + deltaX;
  if(newWidth < LABEL_MIN_WIDTH) newWidth = LABEL_MIN_WIDTH;
  if(newWidth > LABEL_MAX_WIDTH) newWidth = LABEL_MAX_WIDTH;
  if(newWidth !== state.config.labelColumnWidth){
    state.config.labelColumnWidth = newWidth;
    const grid = document.getElementById('grid');
    const qs = months();
    grid.style.gridTemplateColumns = newWidth + 'px repeat(' + qs.length + ', minmax(' + MONTH_WIDTH_PX + 'px, 1fr))';
    grid.style.minWidth = (newWidth + qs.length * MONTH_WIDTH_PX) + 'px';
    labelResizeState.handle.style.left = (newWidth - 3) + 'px';
  }
}

function onLabelResizeEnd(){
  if(labelResizeState){
    labelResizeState.handle.classList.remove('active');
    labelResizeState = null;
  }
  document.body.style.cursor = '';
  document.removeEventListener('mousemove', onLabelResizeMove);
  document.removeEventListener('mouseup', onLabelResizeEnd);
  scheduleAutosave();
}

function attachReorderHandlers(li, dragSource, init){
  // Mouse-based reorder drag (HTML5 drag-and-drop is unreliable on spans in WebKit).
  // The drag source (row number) initiates the drag; cursor-Y picks the drop target.
  dragSource.addEventListener('click', e => e.stopPropagation());
  dragSource.addEventListener('mousedown', e => {
    if(e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if(clickTimer){ clearTimeout(clickTimer); clickTimer = null; }
    startReorderDrag(init.id);
  });
}

function startReorderDrag(sourceId){
  state.reorderDragId = sourceId;
  state.selected = null;
  state.reorderDropTarget = null;
  state.reorderDropPosition = null;
  document.body.style.cursor = 'grabbing';
  renderGrid();

  function pickTarget(clientY){
    const grid = document.getElementById('grid');
    const labelCells = grid.querySelectorAll('.lbl-cell');
    // Skip the trailing ghost row - it's the last lbl-cell and not a real initiative
    const realCount = state.initiatives.length;
    for(let i = 0; i < realCount && i < labelCells.length; i++){
      const rect = labelCells[i].getBoundingClientRect();
      if(clientY >= rect.top && clientY <= rect.bottom){
        const init = state.initiatives[i];
        const position = clientY < rect.top + rect.height / 2 ? 'above' : 'below';
        return { id: init.id, position };
      }
    }
    return null;
  }

  function clearTarget(){
    if(state.reorderDropTarget){
      state.reorderDropTarget = null;
      state.reorderDropPosition = null;
      renderGrid();
    }
  }

  function onMove(ev){
    const target = pickTarget(ev.clientY);
    if(!target || target.id === state.reorderDragId){
      clearTarget();
      return;
    }
    // Suppress no-op drop positions (adjacent to source)
    const sourceIdx = state.initiatives.findIndex(x => x.id === state.reorderDragId);
    const targetIdx = state.initiatives.findIndex(x => x.id === target.id);
    if(target.position === 'above' && targetIdx === sourceIdx + 1){
      clearTarget();
      return;
    }
    if(target.position === 'below' && targetIdx === sourceIdx - 1){
      clearTarget();
      return;
    }
    if(state.reorderDropTarget !== target.id || state.reorderDropPosition !== target.position){
      state.reorderDropTarget = target.id;
      state.reorderDropPosition = target.position;
      renderGrid();
    }
  }

  function onUp(ev){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    const dropTargetId = state.reorderDropTarget;
    const dropPosition = state.reorderDropPosition;
    if(dropTargetId && dropTargetId !== state.reorderDragId){
      reorderInitiatives(state.reorderDragId, dropTargetId, dropPosition || 'above');
    } else {
      state.reorderDragId = null;
      state.reorderDropTarget = null;
      state.reorderDropPosition = null;
      render();
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function reorderInitiatives(srcId, targetId, position){
  if(srcId === targetId) return;
  const srcIdx = state.initiatives.findIndex(x => x.id === srcId);
  if(srcIdx === -1) return;
  const [item] = state.initiatives.splice(srcIdx, 1);
  let targetIdx = state.initiatives.findIndex(x => x.id === targetId);
  if(targetIdx === -1){
    state.initiatives.splice(srcIdx, 0, item);
  } else {
    if(position === 'below') targetIdx += 1;
    state.initiatives.splice(targetIdx, 0, item);
  }
  state.reorderDragId = null;
  state.reorderDropTarget = null;
  state.reorderDropPosition = null;
  render();
}

function onBarPointerDown(e, init, handle){
  if(init.adjustable === false) return;
  if(e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const grid = document.getElementById('grid');
  const qcells = grid.querySelectorAll('.qcell');
  if(qcells.length === 0) return;
  const quarterWidth = qcells[0].getBoundingClientRect().width;
  if(!quarterWidth) return;

  dragState = {
    initId: init.id, handle, startX: e.clientX,
    initialStart: init.position.s, initialEnd: init.position.e,
    quarterWidth, dragged: false
  };
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('mouseup', onPointerUp);
}

function onPointerMove(e){
  if(!dragState) return;
  const deltaX = e.clientX - dragState.startX;
  if(!dragState.dragged && Math.abs(deltaX) > 4){
    dragState.dragged = true;
    document.body.style.cursor = dragState.handle === 'move' ? 'grabbing' : 'ew-resize';
  }
  if(!dragState.dragged) return;

  const deltaQ = Math.round(deltaX / dragState.quarterWidth);
  const init = findInit(dragState.initId);
  if(!init) return;

  let newStart = dragState.initialStart;
  let newEnd = dragState.initialEnd;
  const maxQ = months().length - 1;

  if(dragState.handle === 'move'){
    const duration = dragState.initialEnd - dragState.initialStart;
    newStart = dragState.initialStart + deltaQ;
    newEnd = dragState.initialEnd + deltaQ;
    if(newStart < 0){ newStart = 0; newEnd = duration; }
    if(newEnd > maxQ){ newEnd = maxQ; newStart = maxQ - duration; }
  } else if(dragState.handle === 'start'){
    newStart = Math.max(0, Math.min(dragState.initialEnd, dragState.initialStart + deltaQ));
  } else if(dragState.handle === 'end'){
    newEnd = Math.min(maxQ, Math.max(dragState.initialStart, dragState.initialEnd + deltaQ));
  }

  if(newStart !== init.position.s || newEnd !== init.position.e){
    setPosition(init, newStart, newEnd);
    renderGrid();
  }
}

function onPointerUp(){
  document.body.style.cursor = '';
  if(!dragState){
    document.removeEventListener('mousemove', onPointerMove);
    document.removeEventListener('mouseup', onPointerUp);
    return;
  }
  const wasDragged = dragState.dragged;
  const initId = dragState.initId;
  if(!wasDragged){
    const init = findInit(initId);
    if(init && init.adjustable !== false) select(init.id);
  } else {
    render();
  }
  dragState = null;
  document.removeEventListener('mousemove', onPointerMove);
  document.removeEventListener('mouseup', onPointerUp);
}

function renderLegend(){
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  state.legend.forEach(lg => {
    const item = document.createElement('div');
    item.className = 'legend-item' + (state.editingLegend === lg.id ? ' editing' : '');
    const swWrap = document.createElement('span');
    swWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;flex-shrink:0';
    const sw = document.createElement('span');
    sw.className = 'legend-sw';
    sw.title = 'Klicka för att ändra färg';
    if(lg.dashed){
      sw.style.border = '1.5px dashed ' + lg.color;
      sw.style.background = 'transparent';
    } else {
      sw.style.background = lg.color;
    }
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = lg.color;
    colorInput.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;padding:0;margin:0';
    colorInput.addEventListener('input', e => {
      lg.color = e.target.value;
      render();
    });
    colorInput.addEventListener('click', e => e.stopPropagation());
    swWrap.appendChild(sw);
    swWrap.appendChild(colorInput);
    item.appendChild(swWrap);

    const text = document.createElement('span');
    text.className = 'legend-text';
    text.textContent = lg.label;
    item.appendChild(text);
    const input = document.createElement('input');
    input.className = 'legend-input';
    input.type = 'text';
    input.value = lg.label;
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      if(e.key === 'Enter') saveLegendEdit(lg.id, input.value);
      if(e.key === 'Escape'){ state.editingLegend = null; render(); }
    });
    input.addEventListener('blur', () => saveLegendEdit(lg.id, input.value));
    item.appendChild(input);

    const remove = document.createElement('button');
    remove.className = 'legend-item-remove';
    remove.textContent = '×';
    remove.title = 'Ta bort etikett "' + lg.label + '"';
    remove.addEventListener('click', e => {
      e.stopPropagation();
      removeLegendConfirm(lg);
    });
    item.appendChild(remove);

    item.addEventListener('click', e => {
      if(e.target === remove) return;
      if(state.editingLegend === lg.id) return;
      state.editingLegend = lg.id;
      render();
      setTimeout(() => {
        const inp = document.querySelector('.legend-item.editing .legend-input');
        if(inp){ inp.focus(); inp.select(); }
      }, 10);
    });
    legend.appendChild(item);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'legend-add-btn';
  addBtn.textContent = '+ Lägg till etikett';
  addBtn.addEventListener('click', openLegendAdd);
  legend.appendChild(addBtn);

  const hint = document.createElement('span');
  hint.className = 'legend-edit-hint';
  hint.textContent = 'klicka för att byta etikett';
  legend.appendChild(hint);
}

function saveLegendEdit(id, value){
  const lg = legendFor(id);
  if(lg && value.trim()) lg.label = value.trim();
  state.editingLegend = null;
  render();
}

function openLegendAdd(){
  document.getElementById('legend-name-input').value = '';
  document.getElementById('legend-color-input').value = '#7F77DD';
  document.getElementById('legend-modal-backdrop').classList.add('open');
  setTimeout(() => document.getElementById('legend-name-input').focus(), 50);
}

function closeLegendAdd(){
  document.getElementById('legend-modal-backdrop').classList.remove('open');
}

function saveLegendAdd(){
  const label = document.getElementById('legend-name-input').value.trim();
  const color = document.getElementById('legend-color-input').value;
  if(!label) return;
  const id = 'custom_' + Date.now();
  state.legend.push({id, label, color});
  closeLegendAdd();
  render();
}

function removeLegendConfirm(lg){
  const usingInits = state.initiatives.filter(i => i.type === lg.id);
  let body = 'Är du säker på att du vill ta bort etiketten "' + lg.label + '"?';
  if(usingInits.length > 0){
    body += ' ' + usingInits.length + ' initiativ använder denna etikett och tilldelas första kvarvarande etikett.';
  }
  confirmAction('Ta bort etikett', body, () => {
    const idx = state.legend.findIndex(x => x.id === lg.id);
    if(idx === -1) return;
    state.legend.splice(idx, 1);
    const fallback = state.legend[0];
    if(fallback){
      usingInits.forEach(init => {
        init.type = fallback.id;
        init.dashed = !!fallback.dashed;
      });
    }
    render();
  });
}

function select(id){
  state.selected = state.selected === id ? null : id;
  render();
}

function startInlineRename(id){
  const init = findInit(id);
  if(!init || init.adjustable === false) return;
  renamingId = id;
  render();
  // Focus and select after render
  setTimeout(() => {
    const inp = document.querySelector('.lbl-input');
    if(inp){ inp.focus(); inp.select(); }
  }, 30);
}

function commitInlineRename(value){
  if(!renamingId) return;
  const init = findInit(renamingId);
  if(init){
    const trimmed = (value || '').trim();
    if(trimmed) init.label = trimmed;
  }
  renamingId = null;
  render();
}

function cancelInlineRename(){
  renamingId = null;
  render();
}

function renderEditPanel(){
  const backdrop = document.getElementById('edit-modal-backdrop');
  if(!state.selected){ backdrop.classList.remove('open'); return; }
  const init = findInit(state.selected);
  if(!init || init.adjustable === false){ backdrop.classList.remove('open'); return; }
  backdrop.classList.add('open');
  document.getElementById('edit-title').textContent = init.label;
  document.getElementById('name-input').value = init.label;
  document.getElementById('weeks-input').value = init.weeks || '';
  const jiraVal = init.jira || '';
  document.getElementById('jira-input').value = jiraVal;
  document.getElementById('jira-open').disabled = !/^https?:\/\/\S+/i.test(jiraVal.trim());
  document.getElementById('deps-input').value = init.dependencies || '';
  document.getElementById('desc-input').value = init.description || '';

  const typeSelect = document.getElementById('type-select');
  typeSelect.innerHTML = '';
  state.legend.forEach(lg => {
    const o = document.createElement('option');
    o.value = lg.id;
    o.textContent = lg.label;
    if(lg.id === init.type) o.selected = true;
    typeSelect.appendChild(o);
  });

  updatePreview();
}

function updatePreview(){
  const init = findInit(state.selected);
  if(!init) return;
  const rows = document.getElementById('preview-rows');
  rows.innerHTML = '';
  const qs = months();
  const p = init.position || {s:0,e:0};
  const inRange = p.s >= 0 && p.e < qs.length;
  const fmt = m => m.label + ' ' + m.year;
  const t = inRange ? (fmt(qs[p.s]) + (p.s !== p.e ? ' - ' + fmt(qs[p.e]) : '')) : 'utanför tidsram';
  const addRow = (labelText, valueText) => {
    const r = document.createElement('div');
    r.className = 'preview-row';
    const left = document.createElement('span');
    left.textContent = labelText;
    const right = document.createElement('span');
    right.textContent = valueText;
    r.appendChild(left);
    r.appendChild(right);
    rows.appendChild(r);
  };
  addRow('Tidsperiod', t);
  const deps = (document.getElementById('deps-input').value || '').trim();
  if(deps) addRow('Beroenden', deps);
}

function applyChanges(){
  const init = findInit(state.selected);
  if(!init) return;
  const newLabel = document.getElementById('name-input').value.trim();
  if(newLabel) init.label = newLabel;
  init.type = document.getElementById('type-select').value;
  const w = document.getElementById('weeks-input').value;
  init.weeks = w === '' ? null : +w;
  init.jira = document.getElementById('jira-input').value;
  init.dependencies = document.getElementById('deps-input').value;
  init.description = document.getElementById('desc-input').value;
  const lg = legendFor(init.type);
  init.dashed = lg && lg.dashed ? true : false;
  state.selected = null;
  render();
}

function deleteInit(){
  const init = findInit(state.selected);
  if(!init) return;
  confirmAction('Ta bort initiativ',
    'Är du säker på att du vill ta bort "' + init.label + '"? Detta går inte att ångra.',
    () => {
      state.initiatives = state.initiatives.filter(x => x.id !== state.selected);
      state.selected = null;
      render();
    });
}

function addInit(){
  const id = 'new_' + Date.now();
  const qs = months();
  const startPos = Math.min(qs.length - 1, Math.floor(qs.length / 2));
  const newInit = {
    id, label:'Nytt initiativ',
    position: {s:startPos, e:startPos},
    type: state.legend[0] ? state.legend[0].id : 'new',
    adjustable: true, weeks: null,
    description:'', jira:'', dependencies:''
  };
  const lg = legendFor(newInit.type);
  newInit.dashed = lg && lg.dashed ? true : false;
  state.initiatives.push(newInit);
  // Start inline rename immediately so user can type name
  renamingId = id;
  render();
  setTimeout(() => {
    const inp = document.querySelector('.lbl-input');
    if(inp){ inp.focus(); inp.select(); }
  }, 30);
}

function removeYearConfirm(yearGroup){
  confirmAction('Ta bort år ' + yearGroup.label,
    'Året är tomt och kommer tas bort från tidslinjen. Vill du fortsätta?',
    () => { removeYear(yearGroup); });
}

function confirmAction(title, body, onConfirm){
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  state.pendingConfirm = onConfirm;
  document.getElementById('modal').classList.add('open');
}

// ----- Menu / Tauri integration -----

async function menuNew(){
  await invoke("new_window");
}

async function menuOpen(){
  try {
    const path = await invoke("open_dialog");
    if(!path) return;
    // If the current window is untitled and has no content, load into it.
    // Otherwise open a new window.
    if(!currentFilePath && state.initiatives.length === 0){
      await loadFromFile(path);
    } else {
      await invoke("open_file_in_window", { path });
    }
  } catch(e){
    console.error("[Roadmap] open failed:", e);
  }
}

async function menuSave(){
  if(currentFilePath){
    await persistToFile(currentFilePath);
    return;
  }
  await menuSaveAs();
}

async function menuSaveAs(){
  try {
    const defaultName = (basenameOf(currentFilePath) || 'Untitled') + '.roadmap';
    const path = await invoke("save_dialog", { defaultName });
    if(!path) return;
    currentFilePath = path;
    await persistToFile(path);
    await invoke("add_recent_file", { path });
    await invoke("refresh_menu");
    await updateWindowTitle();
  } catch(e){
    console.error("[Roadmap] save failed:", e);
  }
}

async function menuExportHtml(){
  try {
    const defaultName = (basenameOf(currentFilePath) || 'roadmap') + '.html';
    const path = await invoke("export_html_dialog", { defaultName });
    if(!path) return;
    const html = await generateExportHtml();
    await invoke("write_html_file", { path, contents: html });
  } catch(e){
    console.error("[Roadmap] export failed:", e);
  }
}

async function menuExportSvg(){
  try {
    if(state.initiatives.length === 0){
      alert("Roadmapen är tom - inget att exportera.");
      return;
    }
    const defaultName = (basenameOf(currentFilePath) || 'roadmap') + '.svg';
    const path = await invoke("export_svg_dialog", { defaultName });
    if(!path) return;
    const svg = generateExportSvg();
    await invoke('write_svg_file', { path, contents: svg });
  } catch(e){
    console.error("[Roadmap] SVG export failed:", e);
    alert("Kunde inte exportera SVG: " + (e && e.message ? e.message : e));
  }
}

// ----- SVG generator (builds vector export from state directly, no DOM rasterization) -----

function svgEscape(s){
  return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

function svgMeasureText(text, fontSize, fontWeight){
  if(!svgMeasureText._ctx){
    svgMeasureText._ctx = document.createElement('canvas').getContext('2d');
  }
  const ctx = svgMeasureText._ctx;
  ctx.font = (fontWeight || '400') + ' ' + fontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  return ctx.measureText(text || '').width;
}

function svgTruncate(text, maxW, fontSize, fontWeight){
  text = text || '';
  if(svgMeasureText(text, fontSize, fontWeight) <= maxW) return text;
  if(svgMeasureText('…', fontSize, fontWeight) > maxW) return '';
  let lo = 0, hi = text.length;
  while(lo < hi){
    const mid = Math.ceil((lo + hi) / 2);
    if(svgMeasureText(text.slice(0, mid) + '…', fontSize, fontWeight) <= maxW){ lo = mid; }
    else { hi = mid - 1; }
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

function generateExportSvg(){
  // Read live CSS variables so light/dark mode is auto-handled
  const root = document.querySelector('.gantt-root');
  const cs = getComputedStyle(root);
  const v = name => (cs.getPropertyValue(name) || '').trim();
  const C = {
    bgCard: v('--bg-card') || '#ffffff',
    bgSoft: v('--bg-soft') || '#f5f4ef',
    bgSofter: v('--bg-softer') || '#faf9f5',
    text1: v('--text-1') || '#1a1a1a',
    text2: v('--text-2') || '#5f5e5a',
    text3: v('--text-3') || '#a09e96',
    border1: v('--border-1') || '#c9c5b8',
    border3: v('--border-3') || '#ebe9e2',
    bgPage: getComputedStyle(document.body).backgroundColor || '#faf9f5'
  };
  // Quarter band colors - read from a live .gh.quarter-band cell if present, otherwise fall back
  const qbEl = document.querySelector('.gh.quarter-band');
  const C_QB_BG = qbEl ? getComputedStyle(qbEl).backgroundColor : '#DCEBE6';
  const C_QB_TEXT = qbEl ? getComputedStyle(qbEl).color : '#133933';

  const ms = months();
  const ys = years();
  const qBands = quarterBands();

  // Layout constants - mirror the in-app CSS
  const PAD = 20;
  const LABEL_W = state.config.labelColumnWidth || 200;
  const MONTH_W = MONTH_WIDTH_PX;
  const TIME_W = ms.length * MONTH_W;
  const GRID_W = LABEL_W + TIME_W;

  const TITLE_H = 42;
  const YEAR_H = 22;
  const QUARTER_H = 18;
  const MONTH_H = 28;
  const ROW_H = 38;
  const HEADER_H = YEAR_H + QUARTER_H + MONTH_H;
  const ROWS_H = state.initiatives.length * ROW_H;
  const GRID_H = HEADER_H + ROWS_H;

  // Legend wrapping
  const LEG_PAD_X = 14, LEG_PAD_Y = 10, LEG_GAP = 8, LEG_ROW_H = 22, LEG_ROW_GAP = 4;
  const LEG_CHIP_PAD_X = 8, LEG_SW = 14, LEG_FONT = 11;
  const chipW = lg => LEG_CHIP_PAD_X * 2 + LEG_SW + 6 + svgMeasureText(lg.label, LEG_FONT, '500');
  const maxLegW = GRID_W - LEG_PAD_X * 2;
  const legRows = [];
  let curRow = [], curW = 0;
  state.legend.forEach(lg => {
    const w = chipW(lg);
    if(curRow.length && curW + LEG_GAP + w > maxLegW){
      legRows.push(curRow); curRow = []; curW = 0;
    }
    curRow.push({lg, w});
    curW += w + (curRow.length > 1 ? LEG_GAP : 0);
  });
  if(curRow.length) legRows.push(curRow);
  const LEG_H = LEG_PAD_Y * 2 + legRows.length * LEG_ROW_H + Math.max(0, legRows.length - 1) * LEG_ROW_GAP;

  const SECTION_GAP = 14;
  const titleStr = basenameOf(currentFilePath) || 'Roadmap';
  const W = GRID_W + PAD * 2;
  const H = PAD + TITLE_H + SECTION_GAP + GRID_H + SECTION_GAP + LEG_H + PAD;

  const FONT = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, sans-serif';
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family='${FONT}'>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bgPage}"/>`);

  // ----- Title -----
  {
    const tx = PAD, ty = PAD;
    const size = 26;
    const sc = size / 24;
    const lx = tx, ly = ty + (TITLE_H - size) / 2;
    parts.push(`<rect x="${lx + 2 * sc}" y="${ly + 5 * sc}" width="${9 * sc}" height="${3 * sc}" rx="${1 * sc}" fill="#378ADD"/>`);
    parts.push(`<rect x="${lx + 6 * sc}" y="${ly + 10.5 * sc}" width="${12 * sc}" height="${3 * sc}" rx="${1 * sc}" fill="#1D9E75"/>`);
    parts.push(`<rect x="${lx + 10 * sc}" y="${ly + 16 * sc}" width="${10 * sc}" height="${3 * sc}" rx="${1 * sc}" fill="#BA7517"/>`);
    parts.push(`<text x="${tx + size + 10}" y="${ty + TITLE_H / 2}" font-size="18" font-weight="600" fill="${C.text1}" dominant-baseline="central">${svgEscape(titleStr)}</text>`);
  }

  // ----- Grid -----
  const gridX = PAD;
  const gridY = PAD + TITLE_H + SECTION_GAP;
  parts.push(`<rect x="${gridX}" y="${gridY}" width="${GRID_W}" height="${GRID_H}" fill="${C.bgCard}" stroke="${C.border1}" rx="8"/>`);

  // Sticky-col header background
  parts.push(`<rect x="${gridX}" y="${gridY}" width="${LABEL_W}" height="${HEADER_H}" fill="${C.bgSoft}"/>`);

  // Year band
  {
    let cx = gridX + LABEL_W;
    ys.forEach((yr, idx) => {
      const yW = yr.span * MONTH_W;
      const color = YEAR_BAND_COLORS[idx % YEAR_BAND_COLORS.length];
      parts.push(`<rect x="${cx}" y="${gridY}" width="${yW}" height="${YEAR_H}" fill="${color}"/>`);
      parts.push(`<text x="${cx + yW / 2}" y="${gridY + YEAR_H / 2}" font-size="11" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${svgEscape(yr.label)}</text>`);
      cx += yW;
    });
  }

  // Quarter band
  {
    const qbY = gridY + YEAR_H;
    let cx = gridX + LABEL_W;
    qBands.forEach(qb => {
      const qW = qb.span * MONTH_W;
      parts.push(`<rect x="${cx}" y="${qbY}" width="${qW}" height="${QUARTER_H}" fill="${C_QB_BG}"/>`);
      parts.push(`<text x="${cx + qW / 2}" y="${qbY + QUARTER_H / 2}" font-size="10" font-weight="500" fill="${C_QB_TEXT}" text-anchor="middle" dominant-baseline="central">${svgEscape(qb.label)}</text>`);
      cx += qW;
    });
  }

  // Month header row
  {
    const mhY = gridY + YEAR_H + QUARTER_H;
    parts.push(`<text x="${gridX + 12}" y="${mhY + MONTH_H / 2}" font-size="11" font-weight="600" fill="${C.text2}" dominant-baseline="central">Initiativ</text>`);
    let cx = gridX + LABEL_W, yearIdx = 0, used = 0;
    ms.forEach(m => {
      if(used >= ys[yearIdx].span){ yearIdx++; used = 0; }
      const tint = QUARTER_CELL_COLORS[yearIdx % QUARTER_CELL_COLORS.length];
      parts.push(`<rect x="${cx}" y="${mhY}" width="${MONTH_W}" height="${MONTH_H}" fill="${tint}"/>`);
      parts.push(`<text x="${cx + MONTH_W / 2}" y="${mhY + MONTH_H / 2}" font-size="11" font-weight="600" fill="#133933" text-anchor="middle" dominant-baseline="central">${svgEscape(m.label)}</text>`);
      cx += MONTH_W;
      used++;
    });
  }

  // Header dividers
  parts.push(`<line x1="${gridX}" y1="${gridY + HEADER_H}" x2="${gridX + GRID_W}" y2="${gridY + HEADER_H}" stroke="${C.border1}"/>`);
  parts.push(`<line x1="${gridX + LABEL_W}" y1="${gridY}" x2="${gridX + LABEL_W}" y2="${gridY + GRID_H}" stroke="${C.border1}"/>`);

  // ----- Initiative rows -----
  const rowsY0 = gridY + HEADER_H;
  state.initiatives.forEach((init, idx) => {
    const ry = rowsY0 + idx * ROW_H;

    // Label cell bg
    parts.push(`<rect x="${gridX}" y="${ry}" width="${LABEL_W}" height="${ROW_H}" fill="${C.bgSofter}"/>`);

    // Row number (right-aligned in its column)
    const rowNumXEnd = gridX + 12 + 22;
    parts.push(`<text x="${rowNumXEnd}" y="${ry + ROW_H / 2}" font-size="11" fill="${C.text3}" text-anchor="end" dominant-baseline="central">${idx + 1}</text>`);

    // Tag (legend label as small chip on right side)
    const lg = legendFor(init.type);
    const tagText = lg ? lg.label : '';
    const tagFont = 10, tagPadX = 6;
    const tagW = tagText ? svgMeasureText(tagText, tagFont, '500') + tagPadX * 2 : 0;

    // Label text
    const labelLeft = rowNumXEnd + 8;
    const labelMaxW = LABEL_W - (labelLeft - gridX) - (tagW ? tagW + 10 : 0) - 12;
    const labelTrunc = svgTruncate(init.label || '', labelMaxW, 12, '400');
    parts.push(`<text x="${labelLeft}" y="${ry + ROW_H / 2}" font-size="12" fill="${C.text1}" dominant-baseline="central">${svgEscape(labelTrunc)}</text>`);

    if(tagText){
      const tagX = gridX + LABEL_W - 12 - tagW;
      const tagY = ry + (ROW_H - 16) / 2;
      parts.push(`<rect x="${tagX}" y="${tagY}" width="${tagW}" height="16" rx="3" fill="${C.bgSoft}"/>`);
      parts.push(`<text x="${tagX + tagW / 2}" y="${ry + ROW_H / 2}" font-size="${tagFont}" font-weight="500" fill="${C.text3}" text-anchor="middle" dominant-baseline="central">${svgEscape(tagText)}</text>`);
    }

    // Month cell borders across the row
    let cx = gridX + LABEL_W;
    for(let i = 0; i < ms.length; i++){
      parts.push(`<rect x="${cx}" y="${ry}" width="${MONTH_W}" height="${ROW_H}" fill="none" stroke="${C.border3}"/>`);
      cx += MONTH_W;
    }

    // Bar
    const p = init.position;
    if(p && p.s >= 0 && p.e >= p.s && p.e < ms.length){
      const barColor = (lg && lg.color) || '#888780';
      const barX = gridX + LABEL_W + p.s * MONTH_W + 4;
      const barY = ry + 6;
      const barW = (p.e - p.s + 1) * MONTH_W - 8;
      const barH = ROW_H - 12;
      const barTxtMax = barW - 20;

      if(init.dashed){
        parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="none" stroke="${barColor}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
        const t = svgTruncate(init.label || '', barTxtMax, 11, '500');
        if(t){
          parts.push(`<text x="${barX + 10}" y="${ry + ROW_H / 2}" font-size="11" font-weight="500" font-style="italic" fill="${barColor}" dominant-baseline="central">${svgEscape(t)}</text>`);
        }
      } else {
        parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${barColor}"/>`);
        const t = svgTruncate(init.label || '', barTxtMax, 11, '600');
        if(t){
          parts.push(`<text x="${barX + 10}" y="${ry + ROW_H / 2}" font-size="11" font-weight="600" fill="#ffffff" dominant-baseline="central">${svgEscape(t)}</text>`);
        }
      }
    }

    // Row bottom border (light)
    parts.push(`<line x1="${gridX}" y1="${ry + ROW_H}" x2="${gridX + GRID_W}" y2="${ry + ROW_H}" stroke="${C.border3}"/>`);
  });

  // ----- Legend -----
  const legY = gridY + GRID_H + SECTION_GAP;
  parts.push(`<rect x="${gridX}" y="${legY}" width="${GRID_W}" height="${LEG_H}" rx="8" fill="${C.bgSoft}" stroke="${C.border3}"/>`);
  legRows.forEach((row, rowIdx) => {
    let cx = gridX + LEG_PAD_X;
    const rowY = legY + LEG_PAD_Y + rowIdx * (LEG_ROW_H + LEG_ROW_GAP);
    row.forEach(({lg, w}) => {
      const swX = cx + LEG_CHIP_PAD_X;
      const swY = rowY + (LEG_ROW_H - LEG_SW) / 2;
      parts.push(`<rect x="${swX}" y="${swY}" width="${LEG_SW}" height="${LEG_SW}" rx="3" fill="${lg.color}"/>`);
      parts.push(`<text x="${swX + LEG_SW + 6}" y="${rowY + LEG_ROW_H / 2}" font-size="${LEG_FONT}" font-weight="500" fill="${C.text2}" dominant-baseline="central">${svgEscape(lg.label)}</text>`);
      cx += w + LEG_GAP;
    });
  });

  parts.push('</svg>');
  return parts.join('');
}

async function menuClose(){
  try {
    const win = getCurrentWindow();
    await win.close();
  } catch(e){}
}

// Generate a self-contained HTML export with current state baked in.
// Re-uses the index.html structure but inlines the styles and state.
async function generateExportHtml(){
  // For v2 we just produce a snapshot HTML with the current rendered grid
  // serialized. The full self-contained interactive export with editable
  // state can come in a later session.
  const dataJson = JSON.stringify(buildSerializableData());
  const titleName = basenameOf(currentFilePath) || 'Roadmap';
  // Fetch the current page's CSS so we can inline it
  let css = '';
  try {
    const resp = await fetch('/src/styles.css');
    css = await resp.text();
  } catch(e){
    console.warn('[Roadmap] could not inline css:', e);
  }
  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<title>${titleName}</title>
<style>${css}</style>
</head>
<body>
<div class="gantt-root">
  <div class="gantt-header">
    <h1 class="gantt-title">${titleName}</h1>
  </div>
  <div class="gantt-grid-wrap">
    <div class="gantt-grid">${document.getElementById('grid').innerHTML}</div>
  </div>
  <div class="legend">${document.getElementById('legend').innerHTML}</div>
</div>
<script type="application/json" id="roadmap-data">${dataJson}</script>
</body>
</html>`;
}

// ----- Event wiring -----

function wireEvents(){
  document.getElementById('modal-confirm').addEventListener('click', () => {
    if(state.pendingConfirm) state.pendingConfirm();
    state.pendingConfirm = null;
    document.getElementById('modal').classList.remove('open');
  });
  document.getElementById('modal-cancel').addEventListener('click', () => {
    state.pendingConfirm = null;
    document.getElementById('modal').classList.remove('open');
  });
  document.getElementById('modal').addEventListener('click', e => {
    if(e.target === document.getElementById('modal')){
      state.pendingConfirm = null;
      document.getElementById('modal').classList.remove('open');
    }
  });

  document.getElementById('edit-modal-backdrop').addEventListener('click', e => {
    if(e.target === document.getElementById('edit-modal-backdrop')){
      state.selected = null;
      render();
    }
  });
  document.getElementById('edit-close').addEventListener('click', () => {
    state.selected = null;
    render();
  });

  // JIRA-link open button: enable only when a valid URL is present, then open
  // it in the system browser via the Rust open_external command.
  const jiraInput = document.getElementById('jira-input');
  const jiraOpenBtn = document.getElementById('jira-open');
  const isOpenableUrl = v => /^https?:\/\/\S+/i.test((v || '').trim());
  const refreshJiraBtn = () => { jiraOpenBtn.disabled = !isOpenableUrl(jiraInput.value); };
  jiraInput.addEventListener('input', refreshJiraBtn);
  jiraOpenBtn.addEventListener('click', async () => {
    const url = jiraInput.value.trim();
    if(!isOpenableUrl(url)) return;
    try { await invoke('open_external', { url }); }
    catch(e){ console.error('[Roadmap] open_external failed:', e); }
  });

  document.getElementById('legend-close').addEventListener('click', closeLegendAdd);
  document.getElementById('legend-cancel').addEventListener('click', closeLegendAdd);
  document.getElementById('legend-save').addEventListener('click', saveLegendAdd);
  document.getElementById('legend-modal-backdrop').addEventListener('click', e => {
    if(e.target === document.getElementById('legend-modal-backdrop')) closeLegendAdd();
  });
  document.getElementById('legend-name-input').addEventListener('keydown', e => {
    if(e.key === 'Enter') saveLegendAdd();
  });

  document.addEventListener('keydown', e => {
    if(e.key === 'Escape'){
      if(state.pendingConfirm){
        state.pendingConfirm = null;
        document.getElementById('modal').classList.remove('open');
      } else if(document.getElementById('legend-modal-backdrop').classList.contains('open')){
        closeLegendAdd();
      } else if(state.selected){
        state.selected = null;
        render();
      }
      return;
    }
    if((e.metaKey || e.ctrlKey) && e.key === 'Enter' && state.selected){
      e.preventDefault();
      applyChanges();
    }
  });

  document.getElementById('apply-btn').addEventListener('click', applyChanges);
  document.getElementById('cancel-btn').addEventListener('click', () => { state.selected = null; render(); });
  document.getElementById('delete-btn').addEventListener('click', deleteInit);
  document.getElementById('add-init').addEventListener('click', addInit);
  document.getElementById('add-year').addEventListener('click', addYearAtEnd);

  // Welcome view buttons - "new" just dismisses welcome in current window
  // (Cmd+N from menu opens a separate new window)
  document.getElementById('welcome-new').addEventListener('click', () => {
    welcomeDismissed = true;
    render();
  });
  document.getElementById('welcome-open').addEventListener('click', menuOpen);

  // About modal close
  document.getElementById('about-close').addEventListener('click', () => {
    document.getElementById('about-modal').classList.remove('open');
  });
  document.getElementById('about-modal').addEventListener('click', e => {
    if(e.target === document.getElementById('about-modal')){
      document.getElementById('about-modal').classList.remove('open');
    }
  });
}

async function wireMenuEvents(){
  await listen('menu:new', menuNew);
  await listen('menu:open', menuOpen);
  await listen('menu:save', menuSave);
  await listen('menu:save_as', menuSaveAs);
  await listen('menu:close', menuClose);
  await listen('menu:export_html', menuExportHtml);
  await listen('menu:export_svg', menuExportSvg);
  await listen('menu:about', () => {
    document.getElementById('about-modal').classList.add('open');
  });
  await listen('menu:open_recent', async (event) => {
    const path = event.payload;
    if(typeof path === 'string'){
      if(!currentFilePath && state.initiatives.length === 0){
        await loadFromFile(path);
      } else {
        await invoke('open_file_in_window', { path });
      }
    }
  });
}

// ----- Boot -----

async function init(){
  wireEvents();
  await wireMenuEvents();

  // If launched with ?file=... in URL, load that file
  const params = new URLSearchParams(window.location.search);
  const fileParam = params.get('file');
  if(fileParam){
    await loadFromFile(decodeURIComponent(fileParam));
    return;
  }

  // Main window only: try to auto-open the most recent file
  // New windows (from Cmd+N) keep their Untitled state
  try {
    const win = getCurrentWindow();
    if(win.label === 'main'){
      const recents = await invoke('get_recent_files');
      if(recents && recents.length > 0){
        await loadFromFile(recents[0]);
        return;
      }
    }
  } catch(e){
    console.warn('[Roadmap] auto-load most recent failed:', e);
  }

  await updateWindowTitle();
  render();
}

init().catch(e => {
  console.error('[Roadmap] init failed:', e);
});
