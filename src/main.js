// Roadmap - Tauri frontend
// Ported from the standalone HTML artifact, with localStorage swapped for
// Tauri file commands and the macOS native menu wired up.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

// ----- Constants -----

const SCHEMA_VERSION = 7;
const AUTOSAVE_DEBOUNCE_MS = 400;

const DEFAULT_CONFIG = {
  startYear: 2026,
  startMonth: 1,
  endYear: 2027,
  endMonth: 12,
  labelColumnWidth: 200,
  yearNotes: {}
};

const MONTH_LABELS = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

const LABEL_MIN_WIDTH = 100;
const LABEL_MAX_WIDTH = 500;
const MONTH_WIDTH_PX = 60;

const YEAR_BAND_COLORS = ['#2F7060', '#2F7060', '#2F7060', '#2F7060', '#2F7060', '#2F7060'];
const QUARTER_CELL_COLORS = ['#EFF6F3', '#EFF6F3', '#EFF6F3', '#EFF6F3', '#EFF6F3', '#EFF6F3'];

const LEGEND_DEFAULTS = [
  {id:'ongoing', label:'Ongoing', color:'#888780'},
  {id:'committed', label:'Committed', color:'#378ADD'},
  {id:'priority', label:'Prioritised', color:'#1D9E75'},
  {id:'maybe', label:'Maybe', color:'#BA7517'},
  {id:'growth', label:'Growth', color:'#7F77DD'},
  {id:'dependency', label:'Dependency', color:'#A32D2D', dashed:true},
  {id:'new', label:'New', color:'#D85A30'}
];

// ----- State -----

const DEFAULT_STRATEGY = {
  vision: '',
  mission: '',
  pillars: [
    { id: 'p1', title: '', description: '' },
    { id: 'p2', title: '', description: '' },
    { id: 'p3', title: '', description: '' }
  ],
  opportunities: [
    { id: 'o1', title: '', description: '' },
    { id: 'o2', title: '', description: '' },
    { id: 'o3', title: '', description: '' }
  ],
  goals: [
    { id: 'g1', title: '', target: '', description: '' },
    { id: 'g2', title: '', target: '', description: '' },
    { id: 'g3', title: '', target: '', description: '' }
  ],
  foundation: [
    { id: 'f1', title: '', description: '' },
    { id: 'f2', title: '', description: '' },
    { id: 'f3', title: '', description: '' }
  ]
};

const state = {
  config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  initiatives: [],
  legend: deepClone(LEGEND_DEFAULTS),
  strategy: JSON.parse(JSON.stringify(DEFAULT_STRATEGY)),
  activeTab: 'roadmap',
  selected: null,
  editingLegend: null,
  pendingConfirm: null,
  reorderDragId: null,
  reorderDropTarget: null,
  reorderDropPosition: null,
  searchQuery: ''
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

// ----- Undo/Redo -----

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 50;

function snapshotState(){
  return {
    config: deepClone(state.config),
    initiatives: deepClone(state.initiatives),
    legend: deepClone(state.legend)
  };
}

// Call BEFORE a user-initiated mutation. Clears the redo stack.
function captureSnapshot(){
  undoStack.push(snapshotState());
  if(undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

function applySnapshot(snap){
  state.config = snap.config;
  state.initiatives = snap.initiatives;
  state.legend = snap.legend;
  state.selected = null;
  invalidateCache();
}

function appUndo(){
  if(undoStack.length === 0) return false;
  redoStack.push(snapshotState());
  if(redoStack.length > MAX_UNDO) redoStack.shift();
  applySnapshot(undoStack.pop());
  render();
  scheduleAutosave();
  updateWindowTitle();
  return true;
}

function appRedo(){
  if(redoStack.length === 0) return false;
  undoStack.push(snapshotState());
  if(undoStack.length > MAX_UNDO) undoStack.shift();
  applySnapshot(redoStack.pop());
  render();
  scheduleAutosave();
  updateWindowTitle();
  return true;
}

// Called from the Edit > Undo/Redo menu items. If the user is currently
// typing in a text input or textarea, forward to the input's native undo
// (so they can undo individual keystrokes), otherwise apply app-level undo.
function handleUndoShortcut(kind){
  const active = document.activeElement;
  const isText = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if(isText){
    try { document.execCommand(kind); } catch(e){}
    return;
  }
  if(kind === 'redo') appRedo(); else appUndo();
}

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
  captureSnapshot();
  state.config.endYear++;
  state.config.endMonth = 12;
  invalidateCache();
  render();
}

// Add a year before the current start year. All existing initiatives keep
// their absolute calendar position - their position indices are shifted
// forward by the number of new months inserted at the front.
function addYearAtStart(){
  captureSnapshot();
  const oldStartMonth = state.config.startMonth;
  // New months added = months from new Jan to old start, exclusive of old start
  // e.g. old start = April (month 4) means we add Jan-Mar of old year (3 months)
  // plus the full previous year (12 months) = 15 months total
  const numAdded = (oldStartMonth - 1) + 12;
  state.initiatives.forEach(init => {
    init.position.s += numAdded;
    init.position.e += numAdded;
  });
  state.config.startYear--;
  state.config.startMonth = 1;
  invalidateCache();
  render();
}

function removeYear(yearGroup){
  captureSnapshot();
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

// Return a name that doesn't collide with any other initiative. If the desired
// name is taken, append (2), (3) etc. Case-insensitive comparison.
function uniqueInitName(desired, excludeId){
  const trimmed = (desired || '').trim();
  if(!trimmed) return trimmed;
  const taken = name => state.initiatives.some(i =>
    i.id !== excludeId && (i.label || '').trim().toLowerCase() === name.toLowerCase()
  );
  if(!taken(trimmed)) return trimmed;
  let n = 2;
  while(taken(trimmed + ' (' + n + ')')) n++;
  return trimmed + ' (' + n + ')';
}

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
    strategy: state.strategy,
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
      // Normalise done flag (optional - defaults to false for backward compat)
      init.done = init.done === true;
      // Convert quarter-index positions to month-index (each Q = 3 months)
      if(isQuarterFormat){
        init.position.s = init.position.s * 3;
        init.position.e = init.position.e * 3 + 2;
      }
    });
    state.initiatives = data.initiatives;
  }
  if(Array.isArray(data.legend)) state.legend = data.legend;
  // Strategy (added in schema v7). Older files default to empty strategy.
  if(data.strategy && typeof data.strategy === 'object'){
    const normCards = (arr, fallback, idPrefix, withTarget) => Array.isArray(arr) && arr.length > 0
      ? arr.map((c, i) => {
          const card = {
            id: c.id || (idPrefix + (i + 1)),
            title: typeof c.title === 'string' ? c.title : '',
            description: typeof c.description === 'string' ? c.description : ''
          };
          if(withTarget) card.target = typeof c.target === 'string' ? c.target : '';
          return card;
        })
      : JSON.parse(JSON.stringify(fallback));
    // Foundation used to be a single text field. We migrate old string content
    // into structured items by splitting on newlines and the first ":" of each
    // line, so "- Title: description" becomes { title, description }.
    let foundationItems;
    if(Array.isArray(data.strategy.foundation)){
      foundationItems = normCards(data.strategy.foundation, DEFAULT_STRATEGY.foundation, 'f');
    } else if(typeof data.strategy.foundation === 'string' && data.strategy.foundation.trim()){
      const parsed = data.strategy.foundation.split(/\r?\n/).filter(l => l.trim()).map((line, i) => {
        const cleaned = line.replace(/^\s*[-*•]\s*/, '').replace(/^\s*\d+[.)\-]\s*/, '').trim();
        const colonIdx = cleaned.indexOf(':');
        return colonIdx > 0
          ? { id: 'f' + (i + 1), title: cleaned.slice(0, colonIdx).trim(), description: cleaned.slice(colonIdx + 1).trim() }
          : { id: 'f' + (i + 1), title: cleaned, description: '' };
      });
      foundationItems = parsed.length > 0 ? parsed : JSON.parse(JSON.stringify(DEFAULT_STRATEGY.foundation));
    } else {
      foundationItems = JSON.parse(JSON.stringify(DEFAULT_STRATEGY.foundation));
    }
    state.strategy = {
      vision: typeof data.strategy.vision === 'string' ? data.strategy.vision : '',
      mission: typeof data.strategy.mission === 'string' ? data.strategy.mission : '',
      pillars: normCards(data.strategy.pillars, DEFAULT_STRATEGY.pillars, 'p'),
      opportunities: normCards(data.strategy.opportunities, DEFAULT_STRATEGY.opportunities, 'o'),
      // Migrate old `principles` field to new `goals` if present (pre-release rename)
      goals: normCards(data.strategy.goals || data.strategy.principles, DEFAULT_STRATEGY.goals, 'g', true),
      foundation: foundationItems
    };
  } else {
    state.strategy = JSON.parse(JSON.stringify(DEFAULT_STRATEGY));
  }
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
    autoFitLabelColumn();
    invalidateCache();
    suppressAutosave = false;
    currentFilePath = path;
    await invoke("add_recent_file", { path });
    await refreshMenu();
    await updateWindowTitle();
    await registerWindowFile(path);
    render();
    // Land the scroll position on the previous month so users see current
    // context with one month of history visible on the left. They can scroll
    // back further to see older content.
    scrollToPreviousMonth();
  } catch(e){
    console.error("[Roadmap] load failed:", e);
    alert("Could not open file: " + e);
  }
}

function scrollToPreviousMonth(){
  const wrap = document.querySelector('.gantt-grid-wrap');
  if(!wrap) return;
  const ms = months();
  if(ms.length === 0) return;
  const now = new Date();
  // Previous calendar month (1-12). getMonth() returns 0-11, which equals
  // (currentMonth - 1) in 1-12 terms - i.e. exactly the previous month.
  let y = now.getFullYear();
  let m = now.getMonth();
  if(m === 0){ y -= 1; m = 12; }
  // Find target month or clamp to roadmap range
  let targetIdx = ms.findIndex(x => x.year === y && x.month === m);
  if(targetIdx < 0){
    const targetAbs = y * 12 + m;
    const firstAbs = ms[0].year * 12 + ms[0].month;
    if(targetAbs < firstAbs) targetIdx = 0;
    else targetIdx = ms.length - 1;
  }
  wrap.scrollLeft = Math.max(0, targetIdx * MONTH_WIDTH_PX);
}

// Auto-expand the label column width to fit the longest initiative name on
// file load, so users never see trunkated names by default. Called only
// once per file open - user can still drag to override afterwards.
function autoFitLabelColumn(){
  if(!state.initiatives || state.initiatives.length === 0) return;
  const PAD_LEFT = 12 + 22 + 8;  // padding + row number + gap
  const PAD_RIGHT = 12 + 18 + 8; // padding + delete button + buffer
  let maxNeeded = 0;
  state.initiatives.forEach(init => {
    const nameW = svgMeasureText(init.label || '', 12, '400');
    const tagW = init.weeks ? svgMeasureText(init.weeks + 'v', 10, '500') + 12 : 0;
    const total = PAD_LEFT + nameW + (tagW ? tagW + 8 : 0) + PAD_RIGHT;
    if(total > maxNeeded) maxNeeded = total;
  });
  const cap = 400;
  const min = 150;
  const optimal = Math.max(min, Math.min(cap, Math.ceil(maxNeeded)));
  if((state.config.labelColumnWidth || 200) < optimal){
    state.config.labelColumnWidth = optimal;
  }
}

async function registerWindowFile(path){
  try {
    const win = getCurrentWindow();
    await invoke("register_window_file", { label: win.label, path });
  } catch(e){
    console.error("[Roadmap] register_window_file failed:", e);
  }
}

function basenameOf(path){
  if(!path) return null;
  const segs = path.split(/[\\/]/);
  const last = segs[segs.length - 1];
  return last.replace(/\.roadmap$/i, '');
}

async function updateWindowTitle(){
  // Display title falls back to the filename (without extension) when not set.
  // This lets users have a nice human-readable name independent of the file.
  const displayName = (state.config && state.config.title && state.config.title.trim())
    || basenameOf(currentFilePath)
    || 'Untitled';
  const title = displayName + ' — Roadmap';
  const titleEl = document.getElementById('gantt-title');
  if(titleEl) titleEl.textContent = displayName;
  document.title = title;
  renderLogo();
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

// ----- Tabs (Roadmap / Strategy) -----

function switchTab(tab){
  if(tab !== 'roadmap' && tab !== 'strategy') return;
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.view-container').forEach(view => {
    view.style.display = view.dataset.view === tab ? '' : 'none';
  });
  if(tab === 'strategy') renderStrategy();
  // Re-run fit-to-height when returning to the roadmap so row heights match
  // the now-visible legend/grid (when hidden their offsetHeight is 0)
  if(tab === 'roadmap') applyFitToHeight();
}

// Auto-grow a textarea: set its height to fit content + 1 extra row of breathing
// room. Called on input and on render so the box always matches what's typed.
function autoGrowTextarea(el){
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Size an <input> to fit its current content (or placeholder if empty).
function fitInputToContent(input){
  if(!input) return;
  if(!fitInputToContent._span){
    const s = document.createElement('span');
    s.style.cssText = 'visibility:hidden;position:absolute;white-space:pre;top:-9999px;left:-9999px';
    document.body.appendChild(s);
    fitInputToContent._span = s;
  }
  const span = fitInputToContent._span;
  const cs = getComputedStyle(input);
  span.style.font = cs.font;
  span.style.fontWeight = cs.fontWeight;
  span.style.fontSize = cs.fontSize;
  span.style.fontFamily = cs.fontFamily;
  span.style.letterSpacing = cs.letterSpacing;
  span.textContent = input.value || input.placeholder || '';
  input.style.width = (span.offsetWidth + 2) + 'px';
}

// Align all foundation titles to the width of the longest one so each
// description starts at the same x-position. Avoids the ragged look where
// the "rest" text begins at different columns depending on title length.
function alignFoundationTitles(){
  const titles = document.querySelectorAll('#strategy-foundation .strategy-pillar-title');
  if(titles.length === 0) return;
  // Lazy-init the measuring span via fitInputToContent
  if(!fitInputToContent._span) fitInputToContent(titles[0]);
  const span = fitInputToContent._span;
  if(!span) return;
  let maxW = 0;
  titles.forEach(input => {
    const cs = getComputedStyle(input);
    span.style.font = cs.font;
    span.style.fontWeight = cs.fontWeight;
    span.style.fontSize = cs.fontSize;
    span.style.fontFamily = cs.fontFamily;
    span.style.letterSpacing = cs.letterSpacing;
    span.textContent = input.value || input.placeholder || '';
    const w = span.offsetWidth;
    if(w > maxW) maxW = w;
  });
  titles.forEach(input => {
    input.style.width = (maxW + 2) + 'px';
  });
}

function renderStrategy(){
  const visionEl = document.getElementById('strategy-vision');
  const missionEl = document.getElementById('strategy-mission');
  if(visionEl && document.activeElement !== visionEl) visionEl.value = state.strategy.vision || '';
  if(missionEl && document.activeElement !== missionEl) missionEl.value = state.strategy.mission || '';
  autoGrowTextarea(visionEl);
  autoGrowTextarea(missionEl);
  renderStrategyCards('pillars', 'strategy-pillars', { label: 'Pillar', noun: 'pillar', placeholder: 'What this pillar means in practice', max: 5, idPrefix: 'p' });
  renderStrategyCards('opportunities', 'strategy-opportunities', { label: 'Opportunity', noun: 'opportunity', placeholder: 'Why this is worth pursuing', max: 8, idPrefix: 'o' });
  renderStrategyCards('goals', 'strategy-goals', { label: 'Goal', noun: 'goal', placeholder: 'Context, scope or measurement notes', max: 8, idPrefix: 'g', withTarget: true, targetPlaceholder: 'Target (e.g. 20% growth, 1M bookings)' });
  renderStrategyCards('foundation', 'strategy-foundation', { label: 'Principle', noun: 'principle', placeholder: 'What this principle means in practice', max: 10, idPrefix: 'f' });
  // Sync card heights row by row across the two columns so opposite cards align
  requestAnimationFrame(alignStrategyCardRows);
}

// Match the heights of opposing cards in opportunities/goals columns so each
// "row" across both columns shares the height of its taller card. Without this
// each card sizes individually and the grid looks uneven.
function alignStrategyCardRows(){
  const opps = document.querySelectorAll('#strategy-opportunities .strategy-pillar');
  const goals = document.querySelectorAll('#strategy-goals .strategy-pillar');
  const rows = Math.max(opps.length, goals.length);
  // Reset any previous min-height so we measure natural content height again
  opps.forEach(c => c.style.minHeight = '');
  goals.forEach(c => c.style.minHeight = '');
  // Read natural heights, then apply max as min-height to both columns
  const heights = [];
  for(let i = 0; i < rows; i++){
    const oppH = opps[i] ? opps[i].offsetHeight : 0;
    const goalH = goals[i] ? goals[i].offsetHeight : 0;
    heights.push(Math.max(oppH, goalH));
  }
  for(let i = 0; i < rows; i++){
    if(opps[i]) opps[i].style.minHeight = heights[i] + 'px';
    if(goals[i]) goals[i].style.minHeight = heights[i] + 'px';
  }
}

function renderStrategyCards(stateKey, containerId, opts){
  const wrap = document.getElementById(containerId);
  if(!wrap) return;
  const block = wrap.parentElement;
  const items = state.strategy[stateKey];
  // Preserve focus across re-renders by remembering which card field was active
  const activeEl = document.activeElement;
  let focusCardId = null, focusField = null, focusStart = 0, focusEnd = 0;
  if(activeEl && activeEl.dataset && activeEl.dataset.cardId && activeEl.dataset.section === stateKey){
    focusCardId = activeEl.dataset.cardId;
    focusField = activeEl.dataset.field;
    focusStart = activeEl.selectionStart;
    focusEnd = activeEl.selectionEnd;
  }
  wrap.innerHTML = '';
  // Remove any add button left from a previous render (it lives as a sibling
  // of the cards container so the cards-grid is free to auto-fit its tracks)
  if(block){
    block.querySelectorAll('.strategy-pillar-add').forEach(b => b.remove());
  }
  items.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'strategy-pillar';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'strategy-pillar-title';
    titleInput.placeholder = opts.label + ' ' + (idx + 1);
    titleInput.value = c.title || '';
    titleInput.dataset.cardId = c.id;
    titleInput.dataset.section = stateKey;
    titleInput.dataset.field = 'title';
    titleInput.addEventListener('input', e => {
      c.title = e.target.value;
      if(stateKey === 'foundation') fitInputToContent(e.target);
      scheduleAutosave();
    });
    card.appendChild(titleInput);
    // Foundation titles auto-size to content for clean inline layout
    if(stateKey === 'foundation'){
      requestAnimationFrame(() => fitInputToContent(titleInput));
    }
    // Optional target field (used by Goals to capture the measurable target value)
    let targetInput = null;
    if(opts.withTarget){
      targetInput = document.createElement('input');
      targetInput.type = 'text';
      targetInput.className = 'strategy-goal-target';
      targetInput.placeholder = opts.targetPlaceholder || 'Target';
      targetInput.value = c.target || '';
      targetInput.dataset.cardId = c.id;
      targetInput.dataset.section = stateKey;
      targetInput.dataset.field = 'target';
      targetInput.addEventListener('input', e => {
        c.target = e.target.value;
        scheduleAutosave();
      });
      card.appendChild(targetInput);
    }
    const descInput = document.createElement('textarea');
    descInput.className = 'strategy-pillar-desc';
    // rows=1 starts the textarea single-line; autoGrowTextarea expands it
    // when content actually wraps. Without this the default is rows=2 which
    // makes every empty card take a row of unused vertical space.
    descInput.rows = 1;
    descInput.placeholder = opts.placeholder;
    descInput.value = c.description || '';
    descInput.dataset.cardId = c.id;
    descInput.dataset.section = stateKey;
    descInput.dataset.field = 'description';
    descInput.addEventListener('input', e => {
      c.description = e.target.value;
      autoGrowTextarea(e.target);
      // Re-align row heights when typing in opp/goal cards expands the textarea
      if(stateKey === 'opportunities' || stateKey === 'goals') alignStrategyCardRows();
      scheduleAutosave();
    });
    card.appendChild(descInput);
    // Set initial height to match content right after the textarea is in the DOM
    requestAnimationFrame(() => autoGrowTextarea(descInput));
    // Remove button - only if more than 1 card remains
    if(items.length > 1){
      const rm = document.createElement('button');
      rm.className = 'strategy-pillar-remove';
      rm.textContent = '×';
      rm.title = 'Remove ' + opts.noun;
      rm.addEventListener('click', () => {
        captureSnapshot();
        state.strategy[stateKey] = items.filter(x => x.id !== c.id);
        scheduleAutosave();
        renderStrategyCards(stateKey, containerId, opts);
        if(stateKey === 'opportunities' || stateKey === 'goals') requestAnimationFrame(alignStrategyCardRows);
      });
      card.appendChild(rm);
    }
    wrap.appendChild(card);
    // Restore focus + caret position if this was the focused card
    if(focusCardId === c.id){
      let target = titleInput;
      if(focusField === 'description') target = descInput;
      else if(focusField === 'target' && targetInput) target = targetInput;
      target.focus();
      try { target.setSelectionRange(focusStart, focusEnd); } catch(e){}
    }
  });
  // Add-card button - placed as sibling of cards container (inside strategy-block)
  // so it doesn't disturb the grid auto-fit sizing of the cards
  if(items.length < opts.max){
    const add = document.createElement('button');
    add.className = 'strategy-pillar-add';
    add.textContent = '+ Add ' + opts.noun;
    add.addEventListener('click', () => {
      captureSnapshot();
      const nextId = opts.idPrefix + (Date.now().toString(36));
      state.strategy[stateKey].push({ id: nextId, title: '', description: '' });
      scheduleAutosave();
      renderStrategyCards(stateKey, containerId, opts);
    });
    (block || wrap).appendChild(add);
  }
}

function wireStrategyInputs(){
  const visionEl = document.getElementById('strategy-vision');
  const missionEl = document.getElementById('strategy-mission');
  if(visionEl){
    visionEl.addEventListener('input', e => {
      state.strategy.vision = e.target.value;
      autoGrowTextarea(e.target);
      scheduleAutosave();
    });
  }
  if(missionEl){
    missionEl.addEventListener('input', e => {
      state.strategy.mission = e.target.value;
      autoGrowTextarea(e.target);
      scheduleAutosave();
    });
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
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
  if(addYearBtn) addYearBtn.textContent = '+ Add year ' + (state.config.endYear + 1);
  renderGrid();
  renderEditPanel();
  renderLegend();
  renderWelcome();
  renderStrategy();
  applyFitToHeight();
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

  // Compute month-indices where a new year begins (used to draw dividers)
  const yearStartIndices = new Set();
  let acc = 0;
  for(let i = 0; i < ys.length; i++){
    if(i > 0) yearStartIndices.add(acc);
    acc += ys[i].span;
  }

  // Empty sticky-col header that spans the year + quarter band rows. The
  // logo + roadmap title used to live here, but they now live in the
  // app-header above the grid (shared across Roadmap and Strategy tabs).
  const stickyHeader = document.createElement('div');
  stickyHeader.className = 'gh sticky-col title-cell';
  stickyHeader.style.gridRow = '1 / span 2';
  grid.appendChild(stickyHeader);
  ys.forEach((y, idx) => {
    const c = document.createElement('div');
    c.className = 'gh year-band';
    c.style.background = YEAR_BAND_COLORS[idx % YEAR_BAND_COLORS.length];
    c.style.gridColumn = 'span ' + y.span;
    // On the first year, prepend a "+" button to add a year before
    if(idx === 0){
      const addPrev = document.createElement('button');
      addPrev.className = 'year-add';
      addPrev.textContent = '+';
      addPrev.title = 'Add year ' + (state.config.startYear - 1);
      addPrev.addEventListener('click', e => {
        e.stopPropagation();
        addYearAtStart();
      });
      c.appendChild(addPrev);
    }
    const labelSpan = document.createElement('span');
    labelSpan.textContent = y.label;
    c.appendChild(labelSpan);
    // Year notes: edit button (visible on hover) + indicator dot if notes exist
    const hasNote = !!(state.config.yearNotes && state.config.yearNotes[y.label] && state.config.yearNotes[y.label].trim());
    const noteBtn = document.createElement('button');
    noteBtn.className = 'year-note-btn' + (hasNote ? ' has-note' : '');
    noteBtn.textContent = hasNote ? '●' : '✎';
    noteBtn.title = hasNote ? 'Edit notes for ' + y.label : 'Add notes for ' + y.label;
    noteBtn.addEventListener('click', e => {
      e.stopPropagation();
      openYearNotesModal(y.label);
    });
    c.appendChild(noteBtn);
    if(canRemoveYear(y)){
      const rm = document.createElement('button');
      rm.className = 'year-remove';
      rm.textContent = '×';
      rm.title = 'Remove year ' + y.label + ' (empty)';
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
      add.title = 'Add year ' + (state.config.endYear + 1);
      add.addEventListener('click', e => {
        e.stopPropagation();
        addYearAtEnd();
      });
      c.appendChild(add);
    }
    grid.appendChild(c);
  });

  // Quarter band cells. The sticky-col for this row is covered by the
  // title cell above (which spans 2 rows), so we only add the time-area cells.
  const qBands = quarterBands();
  qBands.forEach((qb) => {
    const c = document.createElement('div');
    c.className = 'gh quarter-band';
    c.style.gridColumn = 'span ' + qb.span;
    c.textContent = qb.label;
    grid.appendChild(c);
  });

  const blank = document.createElement('div');
  blank.className = 'gh sticky-col search-cell';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'search-input';
  searchInput.placeholder = 'Initiative';
  searchInput.value = state.searchQuery || '';
  searchInput.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    render();
    // After re-render, refocus the new input and restore cursor position
    setTimeout(() => {
      const fresh = document.querySelector('.search-input');
      if(fresh){ fresh.focus(); fresh.setSelectionRange(state.searchQuery.length, state.searchQuery.length); }
    }, 0);
  });
  blank.appendChild(searchInput);
  // Show a toggle in the search cell when any initiatives are marked as done.
  // Clicking flips the Hide Completed setting. Hidden when nothing is done so
  // the search cell stays compact for fresh roadmaps.
  const doneCount = state.initiatives.filter(i => i.done).length;
  if(doneCount > 0){
    const hideBtn = document.createElement('button');
    hideBtn.className = 'hide-completed-toggle' + (hideCompleted ? ' active' : '');
    hideBtn.title = hideCompleted
      ? 'Show ' + doneCount + ' completed initiative' + (doneCount === 1 ? '' : 's')
      : 'Hide ' + doneCount + ' completed initiative' + (doneCount === 1 ? '' : 's');
    hideBtn.textContent = hideCompleted ? 'Show done (' + doneCount + ')' : 'Hide done (' + doneCount + ')';
    hideBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleHideCompleted();
    });
    blank.appendChild(hideBtn);
  }
  grid.appendChild(blank);

  let yearIdx = 0;
  let yearMonthsUsed = 0;
  qs.forEach((mObj, mIdx) => {
    if(yearMonthsUsed >= ys[yearIdx].span){
      yearIdx++;
      yearMonthsUsed = 0;
    }
    const c = document.createElement('div');
    // First month of a new year (but not the very first month) gets a divider
    const isYearStart = yearMonthsUsed === 0 && yearIdx > 0;
    c.className = 'gh' + (isYearStart ? ' year-start' : '');
    c.style.background = QUARTER_CELL_COLORS[yearIdx % QUARTER_CELL_COLORS.length];
    c.style.color = '#133933';
    c.textContent = mObj.label;
    grid.appendChild(c);
    yearMonthsUsed++;
  });

  const q = (state.searchQuery || '').trim().toLowerCase();
  state.initiatives.forEach((init, idx) => {
    // Filter: hide rows that don't match the search query
    if(q && !(init.label || '').toLowerCase().includes(q)) return;
    // Filter: hide completed initiatives when the View toggle is on
    if(hideCompleted && init.done) return;

    const isDragging = state.reorderDragId === init.id;
    const isDropTarget = state.reorderDropTarget === init.id;
    const dropClass = isDropTarget ? 'drop-' + state.reorderDropPosition : '';
    const qcellDropClass = isDropTarget ? 'row-drop-' + state.reorderDropPosition : '';

    const lc = document.createElement('div');
    lc.className = 'lbl-cell';
    const li = document.createElement('div');
    const isRenaming = renamingId === init.id;
    li.className = 'row-label' + (state.selected === init.id ? ' selected' : '') + (isDragging ? ' dragging-row' : '') + (dropClass ? ' ' + dropClass : '') + (init.done ? ' done' : '');
    const num = document.createElement('span');
    num.className = 'row-number' + (init.adjustable !== false ? ' drag-handle' : '');
    num.textContent = (idx + 1);
    if(init.adjustable !== false){
      num.title = 'Drag to reorder';
    }
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
    // Done toggle button (visible on hover, persistent when done)
    if(!isRenaming){
      const doneBtn = document.createElement('button');
      doneBtn.className = 'row-done-toggle' + (init.done ? ' active' : '');
      doneBtn.textContent = '✓';
      doneBtn.title = init.done ? 'Mark as not done' : 'Mark as done';
      doneBtn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        captureSnapshot();
        init.done = !init.done;
        render();
      });
      doneBtn.addEventListener('mousedown', e => e.stopPropagation()); // don't start drag
      li.appendChild(doneBtn);
    }
    // Row delete button (visible on hover)
    if(init.adjustable !== false && !isRenaming){
      const rm = document.createElement('button');
      rm.className = 'row-remove';
      rm.textContent = '×';
      rm.title = 'Delete initiative';
      rm.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        confirmAction('Delete initiative',
          'Are you sure you want to delete "' + init.label + '"? This cannot be undone.',
          () => {
            captureSnapshot();
            state.initiatives = state.initiatives.filter(x => x.id !== init.id);
            if(state.selected === init.id) state.selected = null;
            render();
          });
      });
      rm.addEventListener('mousedown', e => e.stopPropagation()); // don't start drag
      li.appendChild(rm);
    }
    if(init.adjustable !== false && !isRenaming){
      // Single-click on the name opens the edit modal; double-click triggers
      // inline rename (Finder-style). The click handler uses a small timer so
      // double-click can pre-empt it.
      const txtEl = li.querySelector('.lbl-text');
      if(txtEl){
        txtEl.addEventListener('click', e => {
          if(state.reorderDragId) return;
          if(clickTimer){ clearTimeout(clickTimer); clickTimer = null; }
          const id = init.id;
          clickTimer = setTimeout(() => {
            clickTimer = null;
            state.selected = id;
            render();
          }, CLICK_DELAY_MS);
        });
      }
      li.addEventListener('dblclick', () => {
        if(state.reorderDragId) return;
        if(clickTimer){ clearTimeout(clickTimer); clickTimer = null; }
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
      const yearStartClass = yearStartIndices.has(qi) ? ' year-start' : '';
      c.className = 'qcell' + (isDragging ? ' row-dragging' : '') + (qcellDropClass ? ' ' + qcellDropClass : '') + yearStartClass;
      if(qi === range.s && range.s >= 0 && range.s < qs.length){
        const b = document.createElement('div');
        const cls = ['bar'];
        if(init.dashed) cls.push('dashed');
        if(init.adjustable !== false) cls.push('adj');
        if(init.done) cls.push('done');
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

        // Dependency indicator: small dot top-right when init.dependencies is non-empty
        if(init.dependencies && init.dependencies.trim()){
          const depDot = document.createElement('span');
          depDot.className = 'dep-dot';
          depDot.title = 'Dependencies: ' + init.dependencies;
          b.appendChild(depDot);
        }

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

  // Ghost row: "+ Add initiative" at the end of the grid
  const ghostLc = document.createElement('div');
  ghostLc.className = 'lbl-cell ghost-cell';
  const ghostLi = document.createElement('div');
  ghostLi.className = 'row-label ghost-row';
  ghostLi.textContent = '+ Add initiative';
  ghostLi.title = 'Add a new initiative';
  ghostLi.addEventListener('click', addInit);
  ghostLc.appendChild(ghostLi);
  grid.appendChild(ghostLc);
  qs.forEach((_, qi) => {
    const c = document.createElement('div');
    const yearStartClass = yearStartIndices.has(qi) ? ' year-start' : '';
    c.className = 'qcell ghost-cell' + yearStartClass;
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
  resizeHandle.title = 'Drag to change the width of the label column';
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
  captureSnapshot();
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
    captureSnapshot(); // user actually moving - record state for undo
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
    sw.title = 'Click to change colour';
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
    let colorChanged = false;
    colorInput.addEventListener('input', e => {
      if(!colorChanged){ captureSnapshot(); colorChanged = true; }
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
    remove.title = 'Remove label "' + lg.label + '"';
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
  addBtn.textContent = '+ Add label';
  addBtn.addEventListener('click', openLegendAdd);
  legend.appendChild(addBtn);

  const hint = document.createElement('span');
  hint.className = 'legend-edit-hint';
  hint.textContent = 'click to edit label';
  legend.appendChild(hint);
}

function saveLegendEdit(id, value){
  const lg = legendFor(id);
  if(lg && value.trim() && lg.label !== value.trim()){
    captureSnapshot();
    lg.label = value.trim();
  }
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
  captureSnapshot();
  const id = 'custom_' + Date.now();
  state.legend.push({id, label, color});
  closeLegendAdd();
  render();
}

function removeLegendConfirm(lg){
  const usingInits = state.initiatives.filter(i => i.type === lg.id);
  let body = 'Are you sure you want to delete the label "' + lg.label + '"?';
  if(usingInits.length > 0){
    body += ' ' + usingInits.length + ' initiative(s) use this label and will be reassigned to the first remaining one.';
  }
  confirmAction('Delete label', body, () => {
    const idx = state.legend.findIndex(x => x.id === lg.id);
    if(idx === -1) return;
    captureSnapshot();
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
    if(trimmed && trimmed !== init.label){
      captureSnapshot();
      init.label = uniqueInitName(trimmed, init.id);
    }
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
  document.getElementById('done-input').checked = !!init.done;

  const typeSelect = document.getElementById('type-select');
  typeSelect.innerHTML = '';
  state.legend.forEach(lg => {
    const o = document.createElement('option');
    o.value = lg.id;
    o.textContent = lg.label;
    // Tint option background (works in some WebKit configurations; harmless if not)
    o.style.backgroundColor = lg.color;
    o.style.color = '#ffffff';
    if(lg.id === init.type) o.selected = true;
    typeSelect.appendChild(o);
  });
  updateCategoryColorSwatch();
  typeSelect.onchange = updateCategoryColorSwatch;

  updatePreview();
}

function updateCategoryColorSwatch(){
  const select = document.getElementById('type-select');
  const swatch = document.getElementById('category-color-swatch');
  if(!select || !swatch) return;
  const lg = legendFor(select.value);
  swatch.style.background = (lg && lg.color) || 'transparent';
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
  const t = inRange ? (fmt(qs[p.s]) + (p.s !== p.e ? ' - ' + fmt(qs[p.e]) : '')) : 'outside timeline';
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
  addRow('Time period', t);
  const deps = (document.getElementById('deps-input').value || '').trim();
  if(deps) addRow('Dependencies', deps);
}

function applyChanges(){
  const init = findInit(state.selected);
  if(!init) return;
  captureSnapshot();
  const newLabel = document.getElementById('name-input').value.trim();
  if(newLabel) init.label = uniqueInitName(newLabel, init.id);
  init.type = document.getElementById('type-select').value;
  const w = document.getElementById('weeks-input').value;
  init.weeks = w === '' ? null : +w;
  init.jira = document.getElementById('jira-input').value;
  init.dependencies = document.getElementById('deps-input').value;
  init.description = document.getElementById('desc-input').value;
  init.done = document.getElementById('done-input').checked;
  const lg = legendFor(init.type);
  init.dashed = lg && lg.dashed ? true : false;
  state.selected = null;
  render();
}

function deleteInit(){
  const init = findInit(state.selected);
  if(!init) return;
  confirmAction('Delete initiative',
    'Are you sure you want to delete "' + init.label + '"? This cannot be undone.',
    () => {
      captureSnapshot();
      state.initiatives = state.initiatives.filter(x => x.id !== state.selected);
      state.selected = null;
      render();
    });
}

// ----- Year notes -----

let yearNotesEditingYear = null;

function openYearNotesModal(year){
  yearNotesEditingYear = String(year);
  document.getElementById('year-notes-title').textContent = 'Notes for ' + year;
  const notes = (state.config.yearNotes && state.config.yearNotes[year]) || '';
  document.getElementById('year-notes-input').value = notes;
  document.getElementById('year-notes-modal-backdrop').classList.add('open');
  setTimeout(() => document.getElementById('year-notes-input').focus(), 30);
}

function closeYearNotesModal(){
  yearNotesEditingYear = null;
  document.getElementById('year-notes-modal-backdrop').classList.remove('open');
}

function saveYearNotes(){
  if(!yearNotesEditingYear) return;
  if(!state.config.yearNotes) state.config.yearNotes = {};
  const val = document.getElementById('year-notes-input').value;
  const current = state.config.yearNotes[yearNotesEditingYear] || '';
  if(val !== current){
    captureSnapshot();
    if(val.trim()){
      state.config.yearNotes[yearNotesEditingYear] = val;
    } else {
      delete state.config.yearNotes[yearNotesEditingYear];
    }
  }
  closeYearNotesModal();
  render();
}

function clearYearNotes(){
  if(!yearNotesEditingYear) return;
  if(state.config.yearNotes && state.config.yearNotes[yearNotesEditingYear]){
    captureSnapshot();
    delete state.config.yearNotes[yearNotesEditingYear];
  }
  closeYearNotesModal();
  render();
}

function addInit(){
  captureSnapshot();
  const id = 'new_' + Date.now();
  const qs = months();
  const startPos = Math.min(qs.length - 1, Math.floor(qs.length / 2));
  const newInit = {
    id, label: uniqueInitName('New initiative', null),
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
  confirmAction('Remove year ' + yearGroup.label,
    'The year is empty and will be removed from the timeline. Continue?',
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
    // If another window already has this file open, focus it instead of
    // loading a duplicate (open_file_in_window handles the focus logic).
    const existingLabel = await invoke("find_window_for_file", { path });
    if(existingLabel){
      await invoke("open_file_in_window", { path });
      return;
    }
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
    // For brand new roadmaps, leave the filename blank so the user is forced
    // to pick a real name instead of accepting "Untitled". For Save-As on an
    // existing file, pre-fill with current name so they can tweak.
    const baseName = basenameOf(currentFilePath);
    const defaultName = baseName ? baseName + '.roadmap' : '';
    const path = await invoke("save_dialog", { defaultName });
    if(!path) return;
    currentFilePath = path;
    await persistToFile(path);
    await invoke("add_recent_file", { path });
    await refreshMenu();
    await updateWindowTitle();
    await registerWindowFile(path);
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

async function menuExportSvg(opts){
  try {
    if(state.initiatives.length === 0){
      alert("The roadmap is empty - nothing to export.");
      return;
    }
    const visibleOnly = opts && opts.visibleOnly;
    const suffix = visibleOnly ? '-visible' : '';
    const defaultName = (basenameOf(currentFilePath) || 'roadmap') + suffix + '.svg';
    const path = await invoke("export_svg_dialog", { defaultName });
    if(!path) return;
    const svg = generateExportSvg({ visibleOnly });
    await invoke('write_svg_file', { path, contents: svg });
  } catch(e){
    console.error("[Roadmap] SVG export failed:", e);
    alert("Could not export SVG: " + (e && e.message ? e.message : e));
  }
}

// Render an SVG string to PNG bytes via an offscreen canvas.
// scale = 2 gives a crisp 2x-DPI raster suitable for Google Slides.
function svgToPng(svgString, scale){
  return new Promise((resolve, reject) => {
    try {
      // Pull pixel dimensions from the root <svg> width/height attributes.
      const m = svgString.match(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"[^>]*\sheight="(\d+(?:\.\d+)?)"/);
      if(!m){ reject(new Error("Could not read SVG dimensions")); return; }
      const w = parseFloat(m[1]);
      const h = parseFloat(m[2]);
      const s = scale || 2;
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * s);
          canvas.height = Math.round(h * s);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          canvas.toBlob(async (pngBlob) => {
            if(!pngBlob){ reject(new Error("Canvas produced no PNG blob")); return; }
            const buf = await pngBlob.arrayBuffer();
            resolve(Array.from(new Uint8Array(buf)));
          }, 'image/png');
        } catch(err){ reject(err); }
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(new Error("SVG image failed to load for rasterization"));
      };
      img.src = url;
    } catch(err){ reject(err); }
  });
}

async function menuExportPng(opts){
  try {
    if(state.initiatives.length === 0){
      alert("The roadmap is empty - nothing to export.");
      return;
    }
    const visibleOnly = opts && opts.visibleOnly;
    const suffix = visibleOnly ? '-visible' : '';
    const defaultName = (basenameOf(currentFilePath) || 'roadmap') + suffix + '.png';
    const path = await invoke("export_png_dialog", { defaultName });
    if(!path) return;
    const svg = generateExportSvg({ visibleOnly });
    const bytes = await svgToPng(svg, 2);
    await invoke('write_png_file', { path, bytes });
  } catch(e){
    console.error("[Roadmap] PNG export failed:", e);
    alert("Could not export PNG: " + (e && e.message ? e.message : e));
  }
}

async function menuExportStrategySvg(){
  try {
    const defaultName = (basenameOf(currentFilePath) || 'roadmap') + '-strategy.svg';
    const path = await invoke("export_svg_dialog", { defaultName });
    if(!path) return;
    const svg = generateStrategySvg();
    await invoke('write_svg_file', { path, contents: svg });
  } catch(e){
    console.error("[Roadmap] Strategy SVG export failed:", e);
    alert("Could not export strategy SVG: " + (e && e.message ? e.message : e));
  }
}

async function menuExportStrategyPng(){
  try {
    const defaultName = (basenameOf(currentFilePath) || 'roadmap') + '-strategy.png';
    const path = await invoke("export_png_dialog", { defaultName });
    if(!path) return;
    const svg = generateStrategySvg();
    const bytes = await svgToPng(svg, 2);
    await invoke('write_png_file', { path, bytes });
  } catch(e){
    console.error("[Roadmap] Strategy PNG export failed:", e);
    alert("Could not export strategy PNG: " + (e && e.message ? e.message : e));
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

// Word-wrap a string into lines that each fit within maxW pixels at the given
// font. Long words that overflow alone are pushed to their own line as-is
// (we don't break inside words for v1).
function svgWrapText(text, maxW, fontSize, fontWeight){
  if(!text) return [];
  const lines = [];
  // Preserve user-inserted line breaks - wrap each input line independently
  text.split(/\r?\n/).forEach(raw => {
    const words = raw.split(/\s+/).filter(Boolean);
    if(words.length === 0){ lines.push(''); return; }
    let current = '';
    for(const word of words){
      const test = current ? current + ' ' + word : word;
      if(svgMeasureText(test, fontSize, fontWeight) <= maxW){
        current = test;
      } else {
        if(current) lines.push(current);
        current = word;
      }
    }
    if(current) lines.push(current);
  });
  return lines;
}

function generateExportSvg(opts){
  // Optional opts.visibleOnly = true to crop the timeline to what is currently
  // visible in the grid scroll area (useful when the roadmap is very wide and
  // the user wants to export a focused section)
  const visibleOnly = opts && opts.visibleOnly;
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

  let ms = months();
  let ys = years();
  let qBands = quarterBands();
  // Respect the "Hide completed" toggle in the export too - if the user
  // has it on in the app, they don't want done initiatives in the export.
  let initiatives = hideCompleted ? state.initiatives.filter(i => !i.done) : state.initiatives;

  // Crop to visible area if requested
  if(visibleOnly){
    const wrap = document.querySelector('.gantt-grid-wrap');
    if(wrap){
      const scrollLeft = wrap.scrollLeft;
      const clientWidth = wrap.clientWidth;
      const labelW = state.config.labelColumnWidth || 200;
      let startM = Math.max(0, Math.floor(scrollLeft / MONTH_WIDTH_PX));
      // ceil-1 gives the last fully-visible month index (excludes the one
      // that would start exactly at the right edge of the viewport)
      let endM = Math.min(ms.length - 1, Math.ceil((scrollLeft + clientWidth - labelW) / MONTH_WIDTH_PX) - 1);
      if(endM < startM) endM = startM;
      ms = ms.slice(startM, endM + 1);
      // Regroup years and quarters from the sliced months
      ys = []; qBands = [];
      let curY = null, curQ = null;
      ms.forEach((m, idx) => {
        const yKey = String(m.year);
        if(curY && curY.label === yKey){ curY.span++; curY.endIdx = idx; }
        else { curY = {label: yKey, span: 1, startIdx: idx, endIdx: idx}; ys.push(curY); }
        const qNum = Math.floor((m.month - 1) / 3) + 1;
        const qKey = m.year + '-Q' + qNum;
        if(curQ && curQ.key === qKey){ curQ.span++; }
        else { curQ = {key: qKey, label: 'Q' + qNum, span: 1, year: m.year}; qBands.push(curQ); }
      });
      // Filter and clip initiatives to the visible range
      initiatives = state.initiatives.map(init => {
        if(!init.position) return null;
        if(init.position.e < startM || init.position.s > endM) return null;
        const clipped = Object.assign({}, init, {
          position: {
            s: Math.max(0, init.position.s - startM),
            e: Math.min(ms.length - 1, init.position.e - startM)
          }
        });
        return clipped;
      }).filter(Boolean);
    }
  }

  // Layout constants - mirror the in-app CSS
  const PAD = 20;
  const LABEL_W = state.config.labelColumnWidth || 200;
  const MONTH_W = MONTH_WIDTH_PX;
  const TIME_W = ms.length * MONTH_W;
  const GRID_W = LABEL_W + TIME_W;

  const YEAR_H = 22;
  const QUARTER_H = 18;
  const MONTH_H = 28;
  // Read the actual row height from a live row in the grid so the SVG export
  // matches whatever the user sees (responsive heights, fit-to-height, etc).
  const sampleQcell = document.querySelector('.qcell');
  const ROW_H = sampleQcell ? Math.round(sampleQcell.getBoundingClientRect().height) : 38;
  const HEADER_H = YEAR_H + QUARTER_H + MONTH_H;
  const TITLE_AREA_H = YEAR_H + QUARTER_H; // logo + title span these two rows in sticky col
  const ROWS_H = initiatives.length * ROW_H;
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
  const titleStr = (state.config.title && state.config.title.trim()) || basenameOf(currentFilePath) || 'Roadmap';
  const W = GRID_W + PAD * 2;
  const H = PAD + GRID_H + SECTION_GAP + LEG_H + PAD;

  const FONT = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, sans-serif';
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family='${FONT}'>`);
  // Page background intentionally omitted - export is transparent outside the card
  // so it can be dropped onto any slide background cleanly.

  // ----- Grid -----
  const gridX = PAD;
  const gridY = PAD;
  parts.push(`<rect x="${gridX}" y="${gridY}" width="${GRID_W}" height="${GRID_H}" fill="${C.bgCard}" stroke="${C.border1}" rx="8"/>`);

  // Sticky-col header background (covers all 3 header rows)
  parts.push(`<rect x="${gridX}" y="${gridY}" width="${LABEL_W}" height="${HEADER_H}" fill="${C.bgSoft}"/>`);

  // ----- Title (logo + name) in the sticky-col, spanning year+quarter rows -----
  {
    const titleY = gridY;
    const logoSize = 22;
    const lx = gridX + 12;
    const ly = titleY + (TITLE_AREA_H - logoSize) / 2;
    const logoVal = state.config.logo || '';
    if(logoVal.startsWith('data:')){
      parts.push(`<image x="${lx}" y="${ly}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet" href="${svgEscape(logoVal)}"/>`);
    } else if(logoVal){
      parts.push(`<text x="${lx + logoSize / 2}" y="${ly + logoSize / 2}" font-size="18" text-anchor="middle" dominant-baseline="central">${svgEscape(logoVal)}</text>`);
    } else {
      const sc = logoSize / 24;
      parts.push(`<rect x="${lx + 2 * sc}" y="${ly + 5 * sc}" width="${9 * sc}" height="${3 * sc}" rx="${1 * sc}" fill="#378ADD"/>`);
      parts.push(`<rect x="${lx + 6 * sc}" y="${ly + 10.5 * sc}" width="${12 * sc}" height="${3 * sc}" rx="${1 * sc}" fill="#1D9E75"/>`);
      parts.push(`<rect x="${lx + 10 * sc}" y="${ly + 16 * sc}" width="${10 * sc}" height="${3 * sc}" rx="${1 * sc}" fill="#BA7517"/>`);
    }
    // Title text next to logo, truncated to fit label column
    const titleX = lx + logoSize + 8;
    const titleMaxW = LABEL_W - (titleX - gridX) - 12;
    const titleTrunc = svgTruncate(titleStr, titleMaxW, 15, '600');
    parts.push(`<text x="${titleX}" y="${titleY + TITLE_AREA_H / 2}" font-size="15" font-weight="600" fill="${C.text1}" dominant-baseline="central">${svgEscape(titleTrunc)}</text>`);
  }

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
    parts.push(`<text x="${gridX + 12}" y="${mhY + MONTH_H / 2}" font-size="11" font-weight="600" fill="${C.text2}" dominant-baseline="central">Initiative</text>`);
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
  initiatives.forEach((init, idx) => {
    const ry = rowsY0 + idx * ROW_H;

    // Label cell bg
    parts.push(`<rect x="${gridX}" y="${ry}" width="${LABEL_W}" height="${ROW_H}" fill="${C.bgSofter}"/>`);

    // Row number (right-aligned in its column)
    const rowNumXEnd = gridX + 12 + 22;
    parts.push(`<text x="${rowNumXEnd}" y="${ry + ROW_H / 2}" font-size="11" fill="${C.text3}" text-anchor="end" dominant-baseline="central">${idx + 1}</text>`);

    // Tag (dev weeks as small chip on right side, matching the UI)
    const lg = legendFor(init.type);
    const tagText = init.weeks ? init.weeks + 'v' : '';
    const tagFont = 10, tagPadX = 6;
    const tagW = tagText ? svgMeasureText(tagText, tagFont, '500') + tagPadX * 2 : 0;

    // Label text
    const labelLeft = rowNumXEnd + 8;
    const labelMaxW = LABEL_W - (labelLeft - gridX) - (tagW ? tagW + 10 : 0) - 12;
    const labelTrunc = svgTruncate(init.label || '', labelMaxW, 12, '400');
    const labelFill = init.done ? C.text3 : C.text1;
    const labelDeco = init.done ? ' text-decoration="line-through"' : '';
    parts.push(`<text x="${labelLeft}" y="${ry + ROW_H / 2}" font-size="12" fill="${labelFill}" dominant-baseline="central"${labelDeco}>${svgEscape(labelTrunc)}</text>`);

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
      // Done initiatives render at reduced opacity (mirrors the app)
      const groupOpen = init.done ? `<g opacity="0.45">` : '';
      const groupClose = init.done ? `</g>` : '';
      const textDeco = init.done ? ' text-decoration="line-through"' : '';

      if(init.dashed){
        parts.push(groupOpen + `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="none" stroke="${barColor}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
        const t = svgTruncate(init.label || '', barTxtMax, 11, '500');
        if(t){
          parts.push(`<text x="${barX + 10}" y="${ry + ROW_H / 2}" font-size="11" font-weight="500" font-style="italic" fill="${barColor}" dominant-baseline="central"${textDeco}>${svgEscape(t)}</text>`);
        }
        parts.push(groupClose);
      } else {
        parts.push(groupOpen + `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${barColor}"/>`);
        const t = svgTruncate(init.label || '', barTxtMax, 11, '600');
        if(t){
          parts.push(`<text x="${barX + 10}" y="${ry + ROW_H / 2}" font-size="11" font-weight="600" fill="#ffffff" dominant-baseline="central"${textDeco}>${svgEscape(t)}</text>`);
        }
        parts.push(groupClose);
      }

      // Dependency dot (small circle in top-right corner)
      if(init.dependencies && init.dependencies.trim()){
        parts.push(`<circle cx="${barX + barW - 1}" cy="${barY + 1}" r="4.5" fill="#D85A30" stroke="${C.bgCard}" stroke-width="2"/>`);
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

// ----- Strategy SVG generator -----
// Renders the strategy house (vision, mission, pillars, opportunities, goals,
// foundation) as a single static SVG. Lays out vertically with a fixed total
// width, dynamic height based on content text wrap.
function generateStrategySvg(){
  const root = document.querySelector('.gantt-root');
  const cs = root ? getComputedStyle(root) : null;
  const cssVar = (name, fallback) => {
    if(!cs) return fallback;
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  const C = {
    bgCard: cssVar('--bg-card', '#fdfaf1'),
    border1: cssVar('--border-1', '#c9c5b8'),
    text1: cssVar('--text-1', '#1a1a1a'),
    text2: cssVar('--text-2', '#5f5e5a'),
    text3: cssVar('--text-3', '#a09e96'),
    infoText: cssVar('--info-text', '#185FA5')
  };
  const FONT = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, sans-serif';
  const W = 1200;
  const PAD = 24;
  const SECTION_GAP = 14;
  const CARD_PAD = 14;
  const CARD_RADIUS = 8;
  const CARD_GAP = 12;
  const LABEL_FONT = 11;
  const LABEL_GAP = 6;
  const parts = [];
  let y = PAD;

  // Helper: render a label-above-block (used for pillars/opportunities/goals
  // section headers since their labels sit outside the card).
  function renderSectionLabel(text){
    parts.push(`<text x="${PAD}" y="${y + LABEL_FONT}" font-size="${LABEL_FONT}" font-weight="600" fill="${C.text3}" letter-spacing="0.88">${svgEscape(text.toUpperCase())}</text>`);
    y += LABEL_FONT + LABEL_GAP;
  }

  // Helper: render a full-width text card with label inside (vision, mission, foundation)
  function renderTextCard(label, text, headline, placeholder){
    const contentW = W - 2*PAD - 2*CARD_PAD;
    const isEmpty = !text;
    const display = text || placeholder || '';
    const fontSize = headline ? 18 : 14;
    const lineHeight = headline ? 26 : 21;
    const weight = headline ? '600' : '400';
    const lines = svgWrapText(display, contentW, fontSize, weight);
    const renderLines = lines.length > 0 ? lines : [''];
    const textBlockH = renderLines.length * lineHeight;
    const cardH = CARD_PAD + LABEL_FONT + LABEL_GAP + textBlockH + CARD_PAD;
    const cardX = PAD, cardY = y;
    parts.push(`<rect x="${cardX}" y="${cardY}" width="${W - 2*PAD}" height="${cardH}" rx="${CARD_RADIUS}" fill="${C.bgCard}" stroke="${C.border1}"/>`);
    parts.push(`<text x="${cardX + CARD_PAD}" y="${cardY + CARD_PAD + LABEL_FONT - 1}" font-size="${LABEL_FONT}" font-weight="600" fill="${C.text3}" letter-spacing="0.88">${svgEscape(label.toUpperCase())}</text>`);
    let ty = cardY + CARD_PAD + LABEL_FONT + LABEL_GAP + fontSize - 2;
    const fill = isEmpty ? C.text3 : C.text1;
    const fontStyleAttr = isEmpty ? ' font-style="italic"' : '';
    renderLines.forEach((line, i) => {
      parts.push(`<text x="${cardX + CARD_PAD}" y="${ty + i*lineHeight}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}"${fontStyleAttr}>${svgEscape(line)}</text>`);
    });
    y = cardY + cardH + SECTION_GAP;
  }

  // Helper: render a horizontal grid of cards (used for pillars). Cards share
  // a single computed height based on the tallest content.
  function renderCardRow(items, cardWidth, placeholderTitle, placeholderDesc, idPrefix){
    const titleFont = 14, titleLH = 20;
    const descFont = 12, descLH = 18;
    const contentW = cardWidth - 2*CARD_PAD;
    const cardData = items.map((c, idx) => {
      const hasDesc = !!c.description;
      const titleDisplay = c.title || (placeholderTitle + ' ' + (idx + 1));
      const titleLines = svgWrapText(titleDisplay, contentW, titleFont, '600');
      const descLines = hasDesc ? svgWrapText(c.description, contentW, descFont, '400') : [];
      return {
        titleLines: titleLines.length ? titleLines : [''],
        descLines,
        hasDesc,
        titleEmpty: !c.title
      };
    });
    const maxH = Math.max(...cardData.map(d => CARD_PAD + d.titleLines.length*titleLH + (d.hasDesc ? 6 + d.descLines.length*descLH : 0) + CARD_PAD));
    cardData.forEach((d, i) => {
      const cardX = PAD + i * (cardWidth + CARD_GAP);
      parts.push(`<rect x="${cardX}" y="${y}" width="${cardWidth}" height="${maxH}" rx="${CARD_RADIUS}" fill="${C.bgCard}" stroke="${C.border1}"/>`);
      let ty = y + CARD_PAD + titleFont - 2;
      d.titleLines.forEach((line, idx) => {
        const fill = d.titleEmpty ? C.text3 : C.text1;
        const style = d.titleEmpty ? ' font-style="italic"' : '';
        parts.push(`<text x="${cardX + CARD_PAD}" y="${ty + idx*titleLH}" font-size="${titleFont}" font-weight="600" fill="${fill}"${style}>${svgEscape(line)}</text>`);
      });
      if(d.hasDesc){
        ty += d.titleLines.length*titleLH + 6 + descFont - 4;
        d.descLines.forEach((line, idx) => {
          parts.push(`<text x="${cardX + CARD_PAD}" y="${ty + idx*descLH}" font-size="${descFont}" fill="${C.text2}">${svgEscape(line)}</text>`);
        });
      }
    });
    y += maxH + SECTION_GAP;
  }

  // Helper: render a single card stack (used for opportunities/goals columns).
  // Returns the bottom Y position so callers can align columns.
  // Compute the natural height a single card needs based on its content
  function computeCardHeight(c, cardWidth, withTarget){
    const titleFont = 14, titleLH = 20;
    const targetFont = 13, targetLH = 19;
    const descFont = 12, descLH = 18;
    const contentW = cardWidth - 2*CARD_PAD;
    const hasTarget = withTarget && !!c.target;
    const hasDesc = !!c.description;
    const titleDisplay = c.title || 'Placeholder';
    const titleLines = svgWrapText(titleDisplay, contentW, titleFont, '600');
    const renderTitleCount = titleLines.length || 1;
    let h = CARD_PAD + renderTitleCount * titleLH;
    if(hasTarget){
      const targetLines = svgWrapText(c.target, contentW, targetFont, '600');
      h += 4 + targetLines.length * targetLH;
    }
    if(hasDesc){
      const descLines = svgWrapText(c.description, contentW, descFont, '400');
      h += 4 + descLines.length * descLH;
    }
    h += CARD_PAD;
    return h;
  }

  // Render a card at an explicit Y and explicit row height (so siblings can align)
  function renderCardAt(c, cardX, cardY, cardWidth, rowH, withTarget, placeholderTitle, idx){
    const titleFont = 14, titleLH = 20;
    const targetFont = 13, targetLH = 19;
    const descFont = 12, descLH = 18;
    const contentW = cardWidth - 2*CARD_PAD;
    const hasTarget = withTarget && !!c.target;
    const hasDesc = !!c.description;
    const titleDisplay = c.title || (placeholderTitle + ' ' + (idx + 1));
    const titleLines = svgWrapText(titleDisplay, contentW, titleFont, '600');
    const targetLines = hasTarget ? svgWrapText(c.target, contentW, targetFont, '600') : [];
    const descLines = hasDesc ? svgWrapText(c.description, contentW, descFont, '400') : [];
    const renderTitle = titleLines.length ? titleLines : [''];
    parts.push(`<rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${rowH}" rx="${CARD_RADIUS}" fill="${C.bgCard}" stroke="${C.border1}"/>`);
    let ty = cardY + CARD_PAD + titleFont - 2;
    const titleEmpty = !c.title;
    renderTitle.forEach((line, i) => {
      const fill = titleEmpty ? C.text3 : C.text1;
      const style = titleEmpty ? ' font-style="italic"' : '';
      parts.push(`<text x="${cardX + CARD_PAD}" y="${ty + i*titleLH}" font-size="${titleFont}" font-weight="600" fill="${fill}"${style}>${svgEscape(line)}</text>`);
    });
    ty += renderTitle.length * titleLH;
    if(hasTarget){
      ty += 4 + targetFont - 4;
      targetLines.forEach((line, i) => {
        parts.push(`<text x="${cardX + CARD_PAD}" y="${ty + i*targetLH}" font-size="${targetFont}" font-weight="600" fill="${C.infoText}">${svgEscape(line)}</text>`);
      });
      ty += targetLines.length * targetLH;
    }
    if(hasDesc){
      ty += 4 + descFont - 4;
      descLines.forEach((line, i) => {
        parts.push(`<text x="${cardX + CARD_PAD}" y="${ty + i*descLH}" font-size="${descFont}" fill="${C.text2}">${svgEscape(line)}</text>`);
      });
    }
  }

  // Render foundation items as a bullet list with bold titles. Each item is
  // "• Title: description" wrapped to multiple lines as needed.
  function renderFoundationCard(){
    const items = state.strategy.foundation.filter(item => item.title || item.description);
    if(items.length === 0) return;
    renderSectionLabel('Foundation');
    const cardX = PAD;
    const cardW = W - 2*PAD;
    const cardPad = CARD_PAD;
    const itemFont = 13;
    const itemLH = 20;
    const itemGap = 6;
    const bulletText = '• ';
    const bulletW = svgMeasureText(bulletText, itemFont, '600');
    const indentX = cardX + cardPad + bulletW + 2;
    const innerLeftX = cardX + cardPad;
    const itemLayouts = items.map(item => {
      const title = item.title || '';
      const description = item.description || '';
      const hasTitle = !!title;
      const hasDesc = !!description;
      const titleText = hasTitle ? (title + (hasDesc ? ': ' : '')) : '';
      const titleW = hasTitle ? svgMeasureText(titleText, itemFont, '600') : 0;
      const firstLineDescX = indentX + titleW;
      const firstLineDescW = cardW - cardPad - (firstLineDescX - cardX);
      const subsLineDescW = cardW - cardPad - (indentX - cardX);
      let descLines = [];
      if(hasDesc){
        const words = description.split(/\s+/);
        let current = '';
        let availableW = firstLineDescW;
        for(const word of words){
          const test = current ? current + ' ' + word : word;
          const w = svgMeasureText(test, itemFont, '400');
          if(w <= availableW){
            current = test;
          } else {
            if(current){
              descLines.push(current);
              availableW = subsLineDescW;
            }
            current = word;
          }
        }
        if(current) descLines.push(current);
      }
      return { titleText, titleW, hasTitle, hasDesc, descLines, lineCount: Math.max(1, descLines.length) };
    });
    let totalH = cardPad * 2;
    itemLayouts.forEach((layout, idx) => {
      totalH += layout.lineCount * itemLH;
      if(idx < itemLayouts.length - 1) totalH += itemGap;
    });
    parts.push(`<rect x="${cardX}" y="${y}" width="${cardW}" height="${totalH}" rx="${CARD_RADIUS}" fill="${C.bgCard}" stroke="${C.border1}"/>`);
    let cy = y + cardPad;
    itemLayouts.forEach((layout, idx) => {
      const baselineY = cy + itemFont - 2;
      parts.push(`<text x="${innerLeftX}" y="${baselineY}" font-size="${itemFont}" font-weight="700" fill="${C.text3}">•</text>`);
      if(layout.hasTitle){
        parts.push(`<text x="${indentX}" y="${baselineY}" font-size="${itemFont}" font-weight="600" fill="${C.text1}">${svgEscape(layout.titleText)}</text>`);
      }
      layout.descLines.forEach((line, i) => {
        const lineX = i === 0 ? (indentX + layout.titleW) : indentX;
        const lineY = baselineY + i * itemLH;
        parts.push(`<text x="${lineX}" y="${lineY}" font-size="${itemFont}" font-weight="400" fill="${C.text2}">${svgEscape(line)}</text>`);
      });
      cy += layout.lineCount * itemLH + itemGap;
    });
    y += totalH;
  }

  // Render two columns of cards row-by-row so opposite rows share the same
  // height (the taller of the two cards in that row), giving a clean grid.
  function renderTwoColumnCards(leftItems, rightItems, leftX, rightX, colW, leftWithTarget, rightWithTarget, leftPlaceholderTitle, rightPlaceholderTitle, startY){
    const rows = Math.max(leftItems.length, rightItems.length);
    let cy = startY;
    for(let i = 0; i < rows; i++){
      const lc = leftItems[i];
      const rc = rightItems[i];
      const lh = lc ? computeCardHeight(lc, colW, leftWithTarget) : 0;
      const rh = rc ? computeCardHeight(rc, colW, rightWithTarget) : 0;
      const rowH = Math.max(lh, rh);
      if(lc) renderCardAt(lc, leftX, cy, colW, rowH, leftWithTarget, leftPlaceholderTitle, i);
      if(rc) renderCardAt(rc, rightX, cy, colW, rowH, rightWithTarget, rightPlaceholderTitle, i);
      cy += rowH;
      if(i < rows - 1) cy += 10;
    }
    return cy;
  }

  // We need total height before we can write the <svg> tag, so we run the
  // layout into `parts` and track `y`, then prepend the <svg> wrapper.

  // Vision (headline)
  renderTextCard('Vision', state.strategy.vision, true, 'A clear, ambitious picture of where we want to be');
  // Mission
  renderTextCard('Mission', state.strategy.mission, false, 'What we do, for whom, and why');

  // Pillars
  renderSectionLabel('Pillars');
  const pillarCount = state.strategy.pillars.length || 1;
  const totalRowW = W - 2*PAD;
  const pillarCardW = (totalRowW - CARD_GAP*(pillarCount-1)) / pillarCount;
  renderCardRow(state.strategy.pillars, pillarCardW, 'Pillar', 'What this pillar means in practice', 'p');

  // Opportunities + Goals (2 columns)
  const colW = (totalRowW - 20) / 2;
  const leftX = PAD;
  const rightX = PAD + colW + 20;
  // Render labels
  parts.push(`<text x="${leftX}" y="${y + LABEL_FONT}" font-size="${LABEL_FONT}" font-weight="600" fill="${C.text3}" letter-spacing="0.88">${svgEscape('OPPORTUNITIES')}</text>`);
  parts.push(`<text x="${rightX}" y="${y + LABEL_FONT}" font-size="${LABEL_FONT}" font-weight="600" fill="${C.text3}" letter-spacing="0.88">${svgEscape('GOALS')}</text>`);
  y += LABEL_FONT + LABEL_GAP;
  y = renderTwoColumnCards(state.strategy.opportunities, state.strategy.goals, leftX, rightX, colW, false, true, 'Opportunity', 'Goal', y) + SECTION_GAP;

  // Foundation as a bullet list with bold titles
  renderFoundationCard();

  const totalH = y - SECTION_GAP + PAD; // last SECTION_GAP added by renderTextCard isn't needed
  const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" font-family='${FONT}'>`;
  return svgOpen + parts.join('') + '</svg>';
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
  // Tab strip + strategy field inputs
  wireStrategyInputs();

  // Inline rename the roadmap title (H1). Saves to state.config.title.
  const titleEl = document.getElementById('gantt-title');
  if(titleEl){
    titleEl.addEventListener('click', () => startRoadmapTitleRename());
  }

  // Logo click: open modal where user picks image OR emoji
  const logoBtn = document.getElementById('gantt-logo-btn');
  if(logoBtn){
    logoBtn.addEventListener('click', () => openLogoModal());
  }

  // Logo modal buttons
  document.getElementById('logo-upload-btn').addEventListener('click', () => pickLogoImage());
  document.getElementById('logo-emoji-input').addEventListener('input', e => updateLogoPreview('emoji', e.target.value.trim()));
  document.getElementById('logo-cancel-btn').addEventListener('click', closeLogoModal);
  document.getElementById('logo-reset-btn').addEventListener('click', () => {
    pendingLogo = '';
    updateLogoPreview('none', null);
    document.getElementById('logo-emoji-input').value = '';
  });
  document.getElementById('logo-save-btn').addEventListener('click', saveLogoModal);
  document.getElementById('logo-modal').addEventListener('click', e => {
    if(e.target === document.getElementById('logo-modal')) closeLogoModal();
  });

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
      } else if(document.getElementById('about-modal').classList.contains('open')){
        document.getElementById('about-modal').classList.remove('open');
      } else if(document.getElementById('logo-modal').classList.contains('open')){
        closeLogoModal();
      } else if(document.getElementById('shortcuts-modal').classList.contains('open')){
        document.getElementById('shortcuts-modal').classList.remove('open');
      } else if(document.getElementById('year-notes-modal-backdrop').classList.contains('open')){
        closeYearNotesModal();
      } else if(document.getElementById('legend-modal-backdrop').classList.contains('open')){
        closeLegendAdd();
      } else if(state.selected){
        state.selected = null;
        render();
      }
      return;
    }
    if((e.metaKey || e.ctrlKey) && e.key === 'Enter'){
      // Year notes modal: save and close
      if(document.getElementById('year-notes-modal-backdrop').classList.contains('open')){
        e.preventDefault();
        saveYearNotes();
        return;
      }
      // Edit modal: apply changes
      if(state.selected){
        e.preventDefault();
        applyChanges();
      }
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

  // Shortcuts modal close
  document.getElementById('shortcuts-close').addEventListener('click', () => {
    document.getElementById('shortcuts-modal').classList.remove('open');
  });
  document.getElementById('shortcuts-modal').addEventListener('click', e => {
    if(e.target === document.getElementById('shortcuts-modal')){
      document.getElementById('shortcuts-modal').classList.remove('open');
    }
  });

  // GitHub link in About modal: open in system browser via Tauri open_external
  document.getElementById('about-github').addEventListener('click', async e => {
    e.preventDefault();
    try { await invoke('open_external', { url: 'https://github.com/sievertz/roadmap-app' }); }
    catch(err){ console.error('[Roadmap] open_external failed:', err); }
  });

  // Year notes modal wiring
  document.getElementById('year-notes-close').addEventListener('click', closeYearNotesModal);
  document.getElementById('year-notes-cancel').addEventListener('click', closeYearNotesModal);
  document.getElementById('year-notes-save').addEventListener('click', saveYearNotes);
  document.getElementById('year-notes-clear').addEventListener('click', clearYearNotes);
  document.getElementById('year-notes-modal-backdrop').addEventListener('click', e => {
    if(e.target === document.getElementById('year-notes-modal-backdrop')) closeYearNotesModal();
  });
}

async function wireMenuEvents(){
  await listen('menu:new', menuNew);
  await listen('menu:open', menuOpen);
  await listen('menu:save', menuSave);
  await listen('menu:save_as', menuSaveAs);
  await listen('menu:export_html', menuExportHtml);
  await listen('menu:export_svg', () => menuExportSvg());
  await listen('menu:export_svg_visible', () => menuExportSvg({ visibleOnly: true }));
  await listen('menu:export_png', () => menuExportPng());
  await listen('menu:export_png_visible', () => menuExportPng({ visibleOnly: true }));
  await listen('menu:export_strategy_svg', () => menuExportStrategySvg());
  await listen('menu:export_strategy_png', () => menuExportStrategyPng());
  await listen('menu:tab', (event) => {
    const tab = event.payload; // 'roadmap' | 'strategy'
    switchTab(tab);
  });
  await listen('menu:check_updates', () => checkForUpdates({ verbose: true }));
  await listen('menu:fit_to_height', toggleFitToHeight);
  await listen('menu:hide_completed', toggleHideCompleted);
  // Rust emits this when it needs JS to rebuild the menu (e.g. after Clear Recent
  // because the native handler doesn't know the current toggle state)
  await listen('menu:request_refresh', () => refreshMenu());
  await listen('menu:undo', () => handleUndoShortcut('undo'));
  await listen('menu:redo', () => handleUndoShortcut('redo'));
  await listen('menu:shortcuts', () => {
    document.getElementById('shortcuts-modal').classList.add('open');
  });
  await listen('menu:theme', (event) => {
    const theme = event.payload; // 'auto' | 'light' | 'dark'
    applyTheme(theme);
  });
  const triggerPrint = () => {
    // Close any open modals so they don't appear in print preview
    if(state.selected){ state.selected = null; render(); }
    document.querySelectorAll('.edit-modal-backdrop, .legend-modal-backdrop, .modal-backdrop')
      .forEach(el => el.classList.remove('open'));
    // Small delay so DOM updates before print dialog opens
    setTimeout(() => window.print(), 50);
  };
  await listen('menu:print', triggerPrint);
  await listen('menu:about', () => {
    document.getElementById('about-modal').classList.add('open');
  });
  await listen('menu:open_recent', async (event) => {
    const path = event.payload;
    if(typeof path === 'string'){
      // Check if file is already open elsewhere first
      const existingLabel = await invoke('find_window_for_file', { path });
      if(existingLabel){
        await invoke('open_file_in_window', { path });
        return;
      }
      if(!currentFilePath && state.initiatives.length === 0){
        await loadFromFile(path);
      } else {
        await invoke('open_file_in_window', { path });
      }
    }
  });
}

// ----- Custom logo -----

const DEFAULT_LOGO_SVG = '<svg class="gantt-logo" id="gantt-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="2" y="5" width="9" height="3" rx="1" fill="#378ADD"/>' +
  '<rect x="6" y="10.5" width="12" height="3" rx="1" fill="#1D9E75"/>' +
  '<rect x="10" y="16" width="10" height="3" rx="1" fill="#BA7517"/>' +
  '</svg>';

// state.config.logo can be either a data URL (image) or a short emoji string.
// pendingLogo holds the modal's draft value during editing.
let pendingLogo = '';

function isImageLogo(v){ return typeof v === 'string' && v.startsWith('data:'); }
function isEmojiLogo(v){ return typeof v === 'string' && v.length > 0 && !v.startsWith('data:'); }

function openLogoModal(){
  pendingLogo = state.config.logo || '';
  const emojiInput = document.getElementById('logo-emoji-input');
  emojiInput.value = isEmojiLogo(pendingLogo) ? pendingLogo : '';
  if(isImageLogo(pendingLogo)) updateLogoPreview('image', pendingLogo);
  else if(isEmojiLogo(pendingLogo)) updateLogoPreview('emoji', pendingLogo);
  else updateLogoPreview('default', null);
  document.getElementById('logo-modal').classList.add('open');
  setTimeout(() => emojiInput.focus(), 30);
}

function closeLogoModal(){
  document.getElementById('logo-modal').classList.remove('open');
  pendingLogo = '';
}

function updateLogoPreview(kind, value){
  const preview = document.getElementById('logo-modal-preview');
  if(!preview) return;
  preview.innerHTML = '';
  if(kind === 'image' && value){
    const img = document.createElement('img');
    img.src = value;
    img.className = 'logo-preview-image';
    preview.appendChild(img);
    pendingLogo = value;
  } else if(kind === 'emoji' && value){
    const span = document.createElement('span');
    span.className = 'logo-preview-emoji';
    span.textContent = value;
    preview.appendChild(span);
    pendingLogo = value;
  } else {
    const tmpl = document.createElement('div');
    tmpl.innerHTML = DEFAULT_LOGO_SVG;
    tmpl.firstChild.style.width = '40px';
    tmpl.firstChild.style.height = '40px';
    preview.appendChild(tmpl.firstChild);
    pendingLogo = '';
  }
}

async function pickLogoImage(){
  try {
    const path = await invoke('pick_image_dialog');
    if(!path) return;
    const dataUrl = await invoke('read_image_as_data_url', { path, maxBytes: 500_000 });
    document.getElementById('logo-emoji-input').value = '';
    updateLogoPreview('image', dataUrl);
  } catch(e){
    alert('Could not load image: ' + (e && e.message ? e.message : e));
  }
}

function saveLogoModal(){
  // Re-read emoji input directly at save time. Some input methods
  // (including macOS Ctrl+Cmd+Space emoji picker) bypass the 'input' event,
  // so pendingLogo may be stale.
  const emojiInputVal = document.getElementById('logo-emoji-input').value.trim();
  let finalLogo = pendingLogo;
  if(!isImageLogo(pendingLogo)){
    finalLogo = emojiInputVal; // empty string clears, non-empty sets emoji
  }
  const current = state.config.logo || '';
  if(finalLogo !== current){
    captureSnapshot();
    if(finalLogo) state.config.logo = finalLogo;
    else delete state.config.logo;
    scheduleAutosave();
    renderLogo();
  }
  closeLogoModal();
}

function renderLogo(){
  const btn = document.getElementById('gantt-logo-btn');
  if(!btn) return;
  const existing = btn.querySelector('.gantt-logo, .gantt-logo-emoji');
  if(existing) existing.remove();
  const logo = state.config && state.config.logo;
  if(isImageLogo(logo)){
    const img = document.createElement('img');
    img.src = logo;
    img.className = 'gantt-logo';
    img.alt = 'Logo';
    btn.appendChild(img);
  } else if(isEmojiLogo(logo)){
    const span = document.createElement('span');
    span.className = 'gantt-logo-emoji';
    span.textContent = logo;
    btn.appendChild(span);
  } else {
    const tmpl = document.createElement('div');
    tmpl.innerHTML = DEFAULT_LOGO_SVG;
    btn.appendChild(tmpl.firstChild);
  }
}

// ----- Roadmap title inline rename -----

function startRoadmapTitleRename(){
  const h = document.getElementById('gantt-title');
  if(!h || h.querySelector('input')) return; // already editing
  const current = (state.config.title && state.config.title.trim()) || basenameOf(currentFilePath) || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-rename-input';
  input.value = current;
  input.placeholder = 'Roadmap title';
  h.textContent = '';
  h.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if(done) return; done = true;
    const val = input.value.trim();
    const newTitle = val || '';
    if(newTitle !== (state.config.title || '')){
      captureSnapshot();
      state.config.title = newTitle;
      scheduleAutosave();
    }
    updateWindowTitle();
  };
  const cancel = () => {
    if(done) return; done = true;
    updateWindowTitle(); // re-render with current value
  };
  input.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); commit(); }
    if(e.key === 'Escape'){ e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

// ----- Hide completed initiatives -----

const HIDE_COMPLETED_KEY = 'roadmap.hideCompleted';
let hideCompleted = false;
try { hideCompleted = localStorage.getItem(HIDE_COMPLETED_KEY) === 'true'; } catch(e){}

// Helper: rebuilds the native menu and passes current toggle state so the
// View menu can render correct check marks next to Fit and Hide Completed.
async function refreshMenu(){
  try {
    await invoke('refresh_menu', { fitToHeight, hideCompleted });
  } catch(e){
    console.warn('[Roadmap] refresh_menu failed:', e);
  }
}

function toggleHideCompleted(){
  hideCompleted = !hideCompleted;
  try { localStorage.setItem(HIDE_COMPLETED_KEY, hideCompleted ? 'true' : 'false'); } catch(e){}
  refreshMenu();
  render();
}

// ----- Fit rows to window height -----

const FIT_HEIGHT_KEY = 'roadmap.fitToHeight';
let fitToHeight = false;
try { fitToHeight = localStorage.getItem(FIT_HEIGHT_KEY) === 'true'; } catch(e){}

function applyFitToHeight(){
  const root = document.querySelector('.gantt-root');
  if(!root) return;
  // Toggle the body class so CSS knows we're in fit mode (compact legend etc)
  document.body.classList.toggle('fit-mode', !!fitToHeight);
  if(!fitToHeight){
    // Let CSS media queries decide the row height
    root.style.removeProperty('--row-h');
    return;
  }
  // Skip recalculation when the roadmap view isn't on screen - measuring
  // hidden elements gives zero values and corrupts the result.
  if(state.activeTab && state.activeTab !== 'roadmap') return;
  // Count only the rows that will actually be visible after search + hide-done filters
  const q = (state.searchQuery || '').trim().toLowerCase();
  const visibleRows = state.initiatives.filter(init => {
    if(hideCompleted && init.done) return false;
    if(q && !(init.label || '').toLowerCase().includes(q)) return false;
    return true;
  }).length;
  if(visibleRows === 0){
    root.style.removeProperty('--row-h');
    return;
  }
  // Compute available row height by measuring fixed chrome above (top of first
  // row) and assuming the bottom chrome is the legend + root padding. Using the
  // window's bottom edge (not the current legend position) avoids a feedback
  // loop where small rows -> legend high up -> calc thinks little room -> rows stay small.
  const wrap = document.querySelector('.gantt-grid-wrap');
  const legendEl = document.getElementById('legend');
  if(!wrap || !legendEl) return;
  const firstRow = wrap.querySelector('.row-label');
  if(!firstRow) return;
  const rowsTop = firstRow.getBoundingClientRect().top;
  const legendH = legendEl.offsetHeight || 40;
  // Bottom chrome between rows and window edge: grid-wrap border-bottom (1) +
  // horizontal scrollbar (~14) + legend margin-top (8) + gantt-root padding-bottom (16)
  // + small safety buffer. NOTE: padding is already accounted for since the global
  // `* { box-sizing: border-box }` rule means --row-h equals total visual row height.
  const BOTTOM_CHROME = 44;
  const available = window.innerHeight - rowsTop - legendH - BOTTOM_CHROME;
  if(available <= 0) return;
  // Total visible row slots = initiative rows + 1 ghost "+ Add initiative" row
  const totalSlots = visibleRows + 1;
  const optimal = Math.max(28, Math.min(80, Math.floor(available / totalSlots)));
  root.style.setProperty('--row-h', optimal + 'px');
}

function toggleFitToHeight(){
  fitToHeight = !fitToHeight;
  try { localStorage.setItem(FIT_HEIGHT_KEY, fitToHeight ? 'true' : 'false'); } catch(e){}
  refreshMenu();
  applyFitToHeight();
}

window.addEventListener('resize', () => {
  if(fitToHeight) applyFitToHeight();
});

// ----- Auto-updater -----

async function checkForUpdates(opts){
  const verbose = opts && opts.verbose;
  try {
    const update = await check();
    if(!update){
      if(verbose) await message('You are running the latest version.', { title: 'No updates', kind: 'info', okLabel: 'OK' });
      return;
    }
    const wantUpdate = await showUpdateModal(update.version);
    if(wantUpdate){
      await update.downloadAndInstall();
      await relaunch();
    }
  } catch(e){
    console.error('[Roadmap] Update check failed:', e);
    if(verbose){
      await message('Could not check for updates: ' + (e && e.message ? e.message : e), { title: 'Update check failed', kind: 'warning', okLabel: 'OK' });
    }
  }
}

// Show the in-app update modal. Returns true if user clicked Install.
function showUpdateModal(version){
  return new Promise(resolve => {
    const backdrop = document.getElementById('update-modal');
    const versionText = document.getElementById('update-version-text');
    const releaseLink = document.getElementById('update-release-notes');
    const installBtn = document.getElementById('update-install');
    const laterBtn = document.getElementById('update-later');

    const releaseUrl = `https://github.com/sievertz/roadmap-app/releases/tag/v${version}`;
    versionText.textContent = `Roadmap ${version} is available.`;

    const cleanup = (answer) => {
      backdrop.classList.remove('open');
      installBtn.removeEventListener('click', onInstall);
      laterBtn.removeEventListener('click', onLater);
      releaseLink.removeEventListener('click', onLink);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(answer);
    };
    const onInstall = () => cleanup(true);
    const onLater = () => cleanup(false);
    const onBackdrop = (e) => { if(e.target === backdrop) cleanup(false); };
    const onLink = async (e) => {
      e.preventDefault();
      try { await invoke('open_external', { url: releaseUrl }); }
      catch(err){ console.error('[Roadmap] open_external failed:', err); }
    };

    installBtn.addEventListener('click', onInstall);
    laterBtn.addEventListener('click', onLater);
    releaseLink.addEventListener('click', onLink);
    backdrop.addEventListener('click', onBackdrop);
    backdrop.classList.add('open');
  });
}

// ----- Theme -----

const THEME_KEY = 'roadmap.theme';

function applyTheme(theme){
  const root = document.querySelector('.gantt-root');
  if(!root) return;
  if(theme === 'light' || theme === 'dark'){
    root.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e){}
  } else {
    root.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme');
    try { localStorage.removeItem(THEME_KEY); } catch(e){}
  }
}

function loadTheme(){
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if(saved === 'light' || saved === 'dark') applyTheme(saved);
  } catch(e){}
}

// ----- Boot -----

async function init(){
  loadTheme();
  wireEvents();
  await wireMenuEvents();
  // Rebuild the menu with check marks reflecting saved toggle state from localStorage
  await refreshMenu();

  // Populate version in About modal from tauri.conf.json
  try {
    const v = await getVersion();
    const verEl = document.getElementById('about-version');
    if(verEl) verEl.textContent = 'Version ' + v;
  } catch(e){}

  // NOTE: We previously registered onCloseRequested to unregister the window
  // from the file-window map, but Tauri 2 has a quirk where having any
  // listener on close-requested blocks the default close behavior. Instead
  // we clean up stale entries lazily in Rust when open_file_in_window finds
  // a label that no longer corresponds to a real window.

  // Schedule the auto update-check NOW (before any early returns below).
  // Only from the main window so multiple open windows don't all check.
  try {
    const w = getCurrentWindow();
    if(w.label === 'main') setTimeout(checkForUpdates, 2000);
  } catch(e){}

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
