// ui.js

const $ = s => document.querySelector(s);

const state = {
  filePath: null,
  chart: null,
  lastXs: [],
  lastYs: [],
  jobId: null,
  cancelling: false,
  outputPath: null,
  suggestedName: null,
  defaultInputDir: null,
  defaultOutputDir: null,
  presets: [],
};

const showBtn = $('#showBtn');
const playBtn = $('#playBtn');


function setStartBtnIdle() {
  const b = $('#startTrimBtn');
  b.classList.remove('danger');
  b.textContent = 'Start';
  b.disabled = false;
}
function setStartBtnActive() {
  const b = $('#startTrimBtn');
  b.classList.add('danger');
  b.textContent = 'Cancel';
  b.disabled = false;
}
function setStartBtnCancelling() {
  const b = $('#startTrimBtn');
  b.classList.add('danger');
  b.textContent = 'Cancelling…';
  b.disabled = true;
}

function showPostRenderActions(path) {
    state.outputPath = path;
    if (!showBtn || !playBtn) return;
    
    showBtn.disabled = false;
    playBtn.disabled = false;
    showBtn.classList.add('active');
    playBtn.classList.add('active');

    showBtn.onclick = () => window.sys.showInFolder(state.outputPath);
    playBtn.onclick = () => window.sys.openFile(state.outputPath);
}
function resetPostRenderActions() {
    if (!showBtn || !playBtn) return;

    showBtn.disabled = true;
    playBtn.disabled = true;
    showBtn.classList.remove('active');
    playBtn.classList.remove('active');
    showBtn.onclick = null;
    playBtn.onclick = null;
}


function setStatus(t){
    $('#status').textContent = t;
}
function setProgress(v){ $('#progress').value = Math.max(0, Math.min(1, v)); }

function handleAnalysisResult(data) {
    if (!data.ok || !Array.isArray(data.x)) {
        setStatus('Error during analysis.');
        setStartBtnIdle();
        return;
    }
    const { x: xs, y: ys } = data;
    state.lastXs = xs;
    state.lastYs = ys;

    const nz = xs.filter((x,i) => isFinite(ys[i]) && ys[i] > 0);
    const min = nz.length ? Math.min(...nz) : Math.min(...xs);
    const max = nz.length ? Math.max(...nz) : Math.max(...xs);

    const pad = 1;
    const lo = Math.floor(min) - pad;
    const hi = Math.ceil(max) + pad;
  
    minRange.step = "0.1";
    maxRange.step = "0.1";
  
    minRange.min = String(lo);
    minRange.max = String(hi);
    maxRange.min = String(lo);
    maxRange.max = String(hi);
  
    const noiseSlider = $('#noiseDb');
    noiseSlider.min = String(lo);
    noiseSlider.max = String(hi);
  
    const midpoint = (lo + hi) / 2;
    noiseSlider.value = String(Math.round(midpoint));
    noiseSlider.dispatchEvent(new Event('input'));
  
    minRange.value = String(Math.max(lo, Math.round(min)));
    maxRange.value = String(Math.min(hi, Math.round(max)));
  
    $('#minDb').value = String(Math.round(min));
    $('#maxDb').value = String(Math.round(max));
    updateRangeFill();
    renderHist(xs, ys, Number(minRange.value), Number(maxRange.value));
  
    setStatus('Histogram ready.');
    setProgress(0);
    state.jobId = null;
    setStartBtnIdle();
}

window.py.onEvent(msg => {
  if (msg.event === 'analysis_result' && msg.job_id === state.jobId) {
    handleAnalysisResult(msg);
    return;
  }
    
  if (msg.event === 'progress') {
    if (!window.__prog) window.__prog = { raf: 0 };
    window.__prog.pending = { stage: msg.stage, value: msg.value };
    if (!window.__prog.raf) {
        window.__prog.raf = requestAnimationFrame(() => {
            const p = window.__prog.pending;
            if (!p) return;
            const value = Math.max(0, Math.min(1, Number(p.value) || 0));
            const stage = p.stage || 'working';
            let label = stage === 'analyze' ? 'Analyzing…'
                      : stage === 'detect' ? 'Detecting…'
                      : stage === 'render' ? 'Rendering…'
                      : 'Working…';
            setProgress(value);
            setStatus(`${label} ${(value*100|0)}%`);
            window.__prog.raf = 0;
        });
    }
    return;
  }

  if (msg.event === 'job') {
    if (state.jobId && msg.id !== state.jobId) return;

    switch (msg.status) {
      case 'started':
        state.jobId = msg.id;
        setStartBtnActive();
        resetPostRenderActions();
        if (msg.kind === 'trim') setStatus('Detecting silences…');
        if (msg.kind === 'analyze') setStatus('Analyzing histogram…');
        setProgress(0.01);
        break;

      case 'finished':
        if (msg.kind === 'trim' && msg.ok) {
          setStatus('Done.');
          showPostRenderActions(msg.output);
        }
        state.jobId = null;
        state.cancelling = false;
        setStartBtnIdle();
        setProgress(0);
        if (window.__prog) window.__prog.pending = null;
        break;

      case 'cancelled':
      case 'error':
        if (msg.status === 'cancelled') setStatus('Cancelled.');
        if (msg.status === 'error') {
          setStatus(`Error: ${msg.error || 'Failed.'}`);
          console.error(`${msg.kind || 'Job'} error:`, msg.error);
        }
        state.jobId = null;
        state.cancelling = false;
        setStartBtnIdle();
        setProgress(0);
        resetPostRenderActions();
        if (window.__prog) window.__prog.pending = null;
        break;
    }
  }
});

const ioSummary = document.getElementById('ioSummary');
const inputDirBtn = document.getElementById('inputDirBtn');
const outputDirBtn = document.getElementById('outputDirBtn');

function updateIoSummary(){
  const inDir = state.defaultInputDir || 'Default (Downloads)';
  const outDir = state.defaultOutputDir || 'Default (Downloads)';
  if (ioSummary) ioSummary.innerHTML = `<span class="io-label">Input:</span> ${inDir}  <span class="sep">|</span>  <span class="io-label">Output:</span> ${outDir}`;
}

async function loadSettings(){
  try {
    const res = await window.sys?.getSettings?.();
    const st = res?.settings || {};
    state.defaultInputDir = typeof st.defaultInputDir === 'string' ? st.defaultInputDir : null;
    state.defaultOutputDir = typeof st.defaultOutputDir === 'string' ? st.defaultOutputDir : null;
    state.presets = Array.isArray(st.presets) ? st.presets : [];
    renderPresets();
    updateIoSummary();
  } catch {}
}

async function savePresets() {
    await window.sys.setSettings({ presets: state.presets });
}

function renderPresets() {
    const list = $('#presetList');
    const template = $('#presetItemTemplate');
    if (!list || !template) return;

    list.innerHTML = '';
    if (state.presets.length === 0) {
        list.innerHTML = `<li class="preset-item-empty">No presets saved.</li>`;
    }

    state.presets.forEach(preset => {
        const item = template.content.cloneNode(true).querySelector('.preset-item');
        item.querySelector('.preset-title').textContent = preset.title;

        item.addEventListener('click', () => {
            applyPreset(preset.id);
            showParamView('front');
        });

        item.querySelector('.preset-edit').addEventListener('click', e => {
            e.stopPropagation();
            editPreset(preset.id);
        });

        item.querySelector('.preset-delete').addEventListener('click', e => {
            e.stopPropagation();
            deletePreset(preset.id);
        });

        list.appendChild(item);
    });
}

// --- FIX: This map now correctly links backend keys to HTML slider IDs ---
const paramMap = {
  noise_db:      { slider: '#noiseDb' },
  silence:       { slider: '#silenceS' },
  pad:           { slider: '#padS' },
  keep:          { slider: '#keepS' },
  merge_silence: { slider: '#mergeS' }
};

function applyPreset(id) {
    const preset = state.presets.find(p => p.id === id);
    if (!preset) return;

    // Iterate over the canonical list of params from the map for safety
    for (const key in paramMap) {
        if (preset.settings.hasOwnProperty(key)) {
            const mapping = paramMap[key];
            const slider = $(mapping.slider);
            const value = preset.settings[key];

            if (slider) {
                slider.value = value;
                slider.dispatchEvent(new Event('input'));
            }
        }
    }
}

function editPreset(id) {
    const preset = state.presets.find(p => p.id === id);
    if (!preset) return;

    const newTitle = prompt('Enter a new name for the preset:', preset.title);
    if (newTitle && newTitle.trim()) {
        preset.title = newTitle.trim();
        savePresets();
        renderPresets();
    }
}

function deletePreset(id) {
    const preset = state.presets.find(p => p.id === id);
    if (!preset) return;

    if (confirm(`Are you sure you want to delete the preset "${preset.title}"?`)) {
        state.presets = state.presets.filter(p => p.id !== id);
        savePresets();
        renderPresets();
    }
}

function getCurrentSliderValues() {
    const values = {};
    // Use the map to get current values with correct backend keys
    for (const key in paramMap) {
        const slider = $(paramMap[key].slider);
        if (slider) {
            // The key from the map IS the correct backend key (e.g., 'noise_db')
            // parseFloat ensures we save a number, not a string.
            values[key] = parseFloat(slider.value);
        }
    }
    return values;
}

function showParamView(viewName) {
    const card = $('#paramCard');
    const title = $('#paramCardTitle');
    card.classList.remove('show-info', 'show-presets');

    if (viewName === 'info') {
        card.classList.add('show-info');
        title.textContent = 'Parameter Info';
    } else if (viewName === 'presets') {
        card.classList.add('show-presets');
        title.textContent = 'Presets';
    } else {
        title.textContent = 'Trimming Parameters';
    }
}

$('#addPresetBtn')?.addEventListener('click', () => {
    const title = prompt('Enter a name for this preset:');
    if (!title || !title.trim()) return;

    const newPreset = {
        id: Date.now(),
        title: title.trim(),
        settings: getCurrentSliderValues()
    };
    state.presets.push(newPreset);
    savePresets();
    renderPresets();
    showParamView('presets');
});

$('#viewPresetsBtn')?.addEventListener('click', () => {
    const card = $('#paramCard');
    if (card.classList.contains('show-presets')) {
        showParamView('front');
    } else {
        showParamView('presets');
    }
});

loadSettings();

const paramInfoBtn = document.getElementById('paramInfoBtn');
paramInfoBtn?.addEventListener('click', ()=>{
    const card = $('#paramCard');
    if (card.classList.contains('show-info')) {
        showParamView('front');
    } else {
        showParamView('info');
    }
});

outputDirBtn?.addEventListener('click', async () => {
  try {
    const res = await window.sys?.chooseDir?.({ title: 'Select default output folder', defaultPath: state.defaultOutputDir || '' });
    if (res?.ok && res.path) {
      state.defaultOutputDir = res.path;
      await window.sys?.setSettings?.({ defaultOutputDir: res.path });
      updateIoSummary();
    }
  } catch {}
});

const outBtn = document.getElementById('outBtn');
if (outBtn && window.sys?.chooseSave) {
  outBtn.addEventListener('click', async () => {
    try {
      const res = await window.sys.chooseSave({ suggestedName: state.suggestedName || 'trimmed.mp4' });
      if (res?.ok && res.path) {
        state.outputPath = res.path;
        const outMeta = document.getElementById('outMeta');
        if (outMeta) outMeta.textContent = `Output: ${res.path}`;
      }
    } catch (e) {
      console.error('chooseSave failed', e);
    }
  });
}



function formatDuration(totalSeconds){
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

async function firstFrameURL(file, t = 0) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(file);

    const cleanup = () => URL.revokeObjectURL(v.src);
    let mediaDuration = 0;

    const draw = () => {
      if (!v.videoWidth || !v.videoHeight) return false;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const frameUrl = c.toDataURL('image/jpeg', 0.9);
      cleanup();
      resolve({ frameUrl, duration: mediaDuration });
      return true;
    };

    v.addEventListener('loadedmetadata', () => {
      mediaDuration = Number.isFinite(v.duration) ? v.duration : 0;
      try { v.currentTime = Math.min(Math.max(t, 0), (isFinite(v.duration) ? v.duration : 0)); }
      catch {}
    }, { once: true });

    v.addEventListener('loadeddata', () => {
      if (draw()) return;
      try { v.currentTime = (v.currentTime || 0) + 0.000001; } catch {}
    }, { once: true });

    v.addEventListener('seeked', () => {
      if (draw()) return;
      requestAnimationFrame(() => { if (!draw()) reject(new Error('Could not decode first frame')); });
    }, { once: true });

    if ('requestVideoFrameCallback' in v) {
      v.requestVideoFrameCallback(() => {
        if (draw()) return;
      });
    }

    v.addEventListener('error', () => {
      cleanup();
      reject(v.error || new Error('video load error'));
    }, { once: true });
  });
}

async function startAnalysisJob(path) {
    if (state.jobId) {
        setStatus('A job is already running.');
        return;
    }
    try {
        const payload = { path: path, min_db: -80, max_db: 0, bins: 0.1 };
        const res = await window.py.send('analyze', payload);
        if (!res?.ok || !res.job) {
            throw new Error(res?.error || 'Failed to start analysis job.');
        }
    } catch (e) {
        setStatus(`Error: ${e.message || e}`);
        setStartBtnIdle();
        setProgress(0);
    }
}

function updateSuggestedName() {
  if (!state.filePath) return;
  const fileName = state.filePath.split(/[/\\]/).pop();
  if (!fileName) return;

  const baseNameNoExt = fileName.replace(/\.[^\.]+$/, '');
  const vals = getCurrentSliderValues();
  const nVal = Math.abs(parseInt(vals.noise_db));
  const sVal = parseInt(vals.silence * 100);
  const mVal = parseInt(vals.merge_silence * 100);
  const pVal = parseInt(vals.pad * 100);
  const kVal = parseInt(vals.keep * 100);

  state.suggestedName = `${baseNameNoExt}-N${nVal}-S${sVal}-M${mVal}-P${pVal}-C${kVal}.mp4`;
}

Object.values(paramMap).forEach(m => {
  const el = document.querySelector(m.slider);
  if (el) el.addEventListener('input', updateSuggestedName);
});


async function handleFileSelection(backendPath, fileName) {
    resetPostRenderActions();
    state.filePath = backendPath;
    const base = fileName.split(/[/\\]/).pop() || 'video.mp4';
    const baseNameNoExt = base.replace(/\.[^\.]+$/, '');

    const vals = getCurrentSliderValues();
    const nVal = Math.abs(parseInt(vals.noise_db));
    const sVal = parseInt(vals.silence * 100);
    const mVal = parseInt(vals.merge_silence * 100);
    const pVal = parseInt(vals.pad * 100);
    const kVal = parseInt(vals.keep * 100);

    state.suggestedName = `${baseNameNoExt}-N${nVal}-S${sVal}-M${mVal}-P${pVal}-C${kVal}.mp4`;

    state.outputPath = null;

    let durText = '—:—';
    let sizeText = '— MB';
    try {
      const pr = await window.py.send('probe', { path: state.filePath });
      if (pr?.ok && Number.isFinite(pr.duration)) durText = formatDuration(pr.duration);
    } catch {}
    try {
      const st = await window.sys?.fsStat?.(state.filePath);
      if (st?.ok && typeof st.size === 'number') sizeText = `${(st.size/1024/1024).toFixed(1)} MB`;
    } catch {}
    $('#meta').textContent = `${base} • ${durText} • ${sizeText}`;

    try {
      const th = await window.py.send('thumb', { path: state.filePath });
      if (th?.ok && th.dataUrl) {
        const thumb = $('#thumb');
        thumb.classList.remove('skeleton');
        thumb.style.backgroundImage = `url(${th.dataUrl})`;
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
      }
    } catch {}

    startAnalysisJob(state.filePath);
}

$('#pickBtn').addEventListener('click', async ()=>{
  if (state.jobId) return;
  resetPostRenderActions();
  if (window.sys?.chooseOpen) {
    try {
      const res = await window.sys.chooseOpen({});
      if (res?.ok && res.path) {
        handleFileSelection(res.path, res.path);
        return;
      }
    } catch(e) { console.error(e) }
  }
  $('#fileInput').click();
});
$('#fileInput').addEventListener('change', async (e)=>{
  if (state.jobId) return;
  resetPostRenderActions();
  const file = e.target.files?.[0];
  if (!file) return;

  const { frameUrl, duration } = await firstFrameURL(file);
  const thumb = $('#thumb');
  thumb.classList.remove('skeleton');
  thumb.style.backgroundImage = `url(${frameUrl})`;
  thumb.style.backgroundSize = 'cover';
  thumb.style.backgroundPosition = 'center';

  let backendPath = file.path;
  if (!backendPath) {
    const ab = await file.arrayBuffer();
    const ext = file.name.split('.').pop() || 'mp4';
    backendPath = await window.py.saveTemp(ab, ext);
  }
  handleFileSelection(backendPath, file.name);
});

function ensureChart(){
  if(state.chart) return state.chart;
  const ctx = $('#histChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [{
      data: [], tension: .35, fill:true, borderWidth:2,
      borderColor:'#1db954', backgroundColor:'rgba(29,185,84,.18)', pointRadius:0
    }]},
    options: {
      responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ type:'linear', ticks:{ color:'#cfcfcf', count: 8, callback:v=>Math.round(v).toString() }, grid:{ color:'rgba(255,255,255,.06)'} },
        y:{ ticks:{ color:'#cfcfcf', callback:v=>v+'%' }, grid:{ color:'rgba(255,255,255,.06)'} }
      },
      plugins:{ legend:{ display:false }, tooltip:{ mode:'index', intersect:false } }
    }
  });
  return state.chart;
}

function renderHist(xs, ys, lo, hi){
  if(!xs.length) return;
  const a = Math.min(lo,hi), b = Math.max(lo,hi);
  const sel = xs.map((x,i)=>({x, y:ys[i]})).filter(p=>p.x>=a && p.x<=b);
  if(!sel.length) return;
  const ch = ensureChart();
  ch.options.scales.x.min = a;
  ch.options.scales.x.max = b;
  ch.data.datasets[0].data = sel;
  ch.update();
}

(function wireChartContextMenu(){
  const canvas = document.getElementById('histChart');
  if (!canvas) return;
  canvas.addEventListener('click', (e)=>{
    try {
      const ch = ensureChart();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const xScale = ch.scales?.x;
      const approxVal = xScale && typeof xScale.getValueForPixel === 'function' ? xScale.getValueForPixel(px) : 0;
      const val = Math.min(Number(maxRange.max), Math.max(Number(minRange.min), Math.round(Number.isFinite(approxVal) ? approxVal : 0)));
      const curMin = Number(minRange.value), curMax = Number(maxRange.value);
      const toMin = Math.abs(val - curMin), toMax = Math.abs(val - curMax);
      if (toMin <= toMax) {
        minRange.value = String(val);
        minRange.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        maxRange.value = String(val);
        maxRange.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch {}
  });
  canvas.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    try {
      const ch = ensureChart();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const xScale = ch.scales?.x;
      const approxVal = xScale && typeof xScale.getValueForPixel === 'function' ? xScale.getValueForPixel(px) : 0;
      const seed = Math.round(Number.isFinite(approxVal) ? approxVal : 0);
      const entered = window.prompt('Enter dB value (e.g., -47):', String(seed));
      if (entered == null) return;
      const num = Number(String(entered).replace(/[^-\d.]+/g, ''));
      if (!Number.isFinite(num)) return;
      const loLim = Number(minRange.min), hiLim = Number(minRange.max);
      const val = Math.min(hiLim, Math.max(loLim, Math.round(num)));
      const curMin = Number(minRange.value), curMax = Number(maxRange.value);
      const toMin = Math.abs(val - curMin), toMax = Math.abs(val - curMax);
      if (toMin <= toMax) {
        minRange.value = String(val);
        minRange.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        maxRange.value = String(val);
        maxRange.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch {}
  });
})();

// --- FIX: This function was broken. It's now simplified and correct. ---
async function loadAndApplyParams() {
  try {
    const res = await window.py.send('get_params_config');
    if (!res || !res.ok) {
      console.error('Failed to fetch param config from backend:', res?.error);
      return;
    }
    const config = res.config;

    // The paramMap keys MUST be the snake_case keys from Python
    for (const key in config) {
        const mapping = paramMap[key];
        if (mapping) {
            const slider = $(mapping.slider);
            if (slider) {
                slider.min = String(config[key].min);
                slider.max = String(config[key].max);
                slider.step = String(config[key].step);
                slider.value = String(config[key].default);
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }
  } catch (e) {
    console.error('Error applying param config:', e);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  loadAndApplyParams();
  resetPostRenderActions(); // Ensure buttons are disabled on startup

  const resetParamsBtn = $('#resetParamsBtn');
  if (resetParamsBtn) {
    resetParamsBtn.addEventListener('click', () => {
      loadAndApplyParams(); 
    });
  }

  try {
    const ch = ensureChart();
    const xs = [];
    for (let x = -55; x <= -10; x += 0.1) xs.push(Number(x.toFixed(1)));
    const ysRaw = xs.map(x => {
      const a = Math.exp(-Math.pow((x + 28) / 2.3, 2));
      const b = 0.8 * Math.exp(-Math.pow((x + 21) / 3.2, 2));
      return (a + b) * 1000;
    });
    const total = ysRaw.reduce((s,v)=>s+v,0) || 1;
    const ys = ysRaw.map(v => (v / total) * 100);
    state.lastXs = xs;
    state.lastYs = ys;
    renderHist(xs, ys, -50, -5);
  } catch {}
});


const minRange = $('#minDb'), maxRange = $('#maxDb');
function updateRangeFill(){
  const min = Number(minRange.value), max = Number(maxRange.value);
  if(min > max){
    if(document.activeElement === minRange) maxRange.value = String(min);
    else minRange.value = String(max);
  }
  const wrap = document.querySelector('.range-wrap');
  const track = wrap.clientWidth;
  const toX = (inp) => ((Number(inp.value)-Number(inp.min)) / (Number(inp.max)-Number(inp.min))) * track;
  const x1 = toX(minRange), x2 = toX(maxRange);
  const left = Math.min(x1,x2), right = Math.max(x1,x2);
  const fill = $('#rangeFill');
  fill.style.left = `${left}px`;
  fill.style.width = `${Math.max(0,right-left)}px`;
}
[minRange, maxRange].forEach(inp=>{
  inp.addEventListener('input', ()=>{ updateRangeFill(); renderHist(state.lastXs, state.lastYs, Number(minRange.value), Number(maxRange.value)); });
});
updateRangeFill();
wireRangeEditors();

function makeEditableSpan(id, onCommit){
  const span = document.getElementById(id);
  if (!span) return;
  span.contentEditable = 'true';
  span.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
  });
  span.addEventListener('blur', ()=>{
    const val = Number(span.textContent);
    if (Number.isFinite(val)) onCommit(val);
    updateRangeFill();
  });
}

function wireRangeEditors(){
  makeEditableSpan('rangeLo', (v)=>{
    minRange.value = String(v);
    if (Number(minRange.value) > Number(maxRange.value)) maxRange.value = String(v);
    minRange.dispatchEvent(new Event('input', { bubbles: true }));
  });
  makeEditableSpan('rangeHi', (v)=>{
    maxRange.value = String(v);
    if (Number(maxRange.value) < Number(minRange.value)) minRange.value = String(v);
    maxRange.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const wrap = document.querySelector('.range-wrap');

function valueToX(inp){
  const min = Number(inp.min), max = Number(inp.max);
  const frac = (Number(inp.value) - min) / (max - min || 1);
  return frac * wrap.clientWidth;
}
function bringNearestFront(clientX){
  const rect = wrap.getBoundingClientRect();
  const x = clientX - rect.left;
  const xMin = valueToX(minRange);
  const xMax = valueToX(maxRange);
  const minIsNearest = Math.abs(x - xMin) <= Math.abs(x - xMax);

  minRange.classList.toggle('front', minIsNearest);
  maxRange.classList.toggle('front', !minIsNearest);
}

wrap.addEventListener('pointerdown', (e) => {
  const cx = e.clientX;
  if (Number.isFinite(cx)) bringNearestFront(cx);
}, { capture: true });

['mousemove','touchmove','pointermove'].forEach(evt=>{
  wrap.addEventListener(evt, (e)=>{
    const cx =
      evt === 'touchmove' ? (e.touches?.[0]?.clientX ?? NaN) :
      'clientX' in e ? e.clientX : NaN;
    if (Number.isFinite(cx)) bringNearestFront(cx);
  }, { passive: true });
});

[minRange, maxRange].forEach(inp=>{
  inp.addEventListener('pointerdown', ()=> {
    minRange.classList.toggle('front', inp === minRange);
    maxRange.classList.toggle('front', inp === maxRange);
  });
  inp.addEventListener('focus', ()=> {
    minRange.classList.toggle('front', inp === minRange);
    maxRange.classList.toggle('front', inp === maxRange);
  });
  inp.addEventListener('input', ()=> {
    minRange.classList.toggle('front', inp === minRange);
    maxRange.classList.toggle('front', inp === maxRange);
  });
});

function bindVal(id, fmt){ const i=$(id), v=$(id+'Val'); const up=()=> { if (v) v.textContent=fmt(i.value); }; i.addEventListener('input',up); up(); }
bindVal('#noiseDb', v=>Number(v).toFixed(1));
bindVal('#silenceS', v=>Number(v).toFixed(2));
bindVal('#mergeS', v=>Number(v).toFixed(2));
bindVal('#padS',     v=>Number(v).toFixed(2));
bindVal('#keepS',    v=>Number(v).toFixed(2));

document.getElementById('applyNoiseBtn')?.addEventListener('click', ()=>{
  const lo = Math.min(Number(minRange.value), Number(maxRange.value));
  const noise = $('#noiseDb');
  if (!noise) return;
  noise.value = String(lo);
  noise.dispatchEvent(new Event('input', { bubbles: true }));
});

function makeSliderValueEditable(valueId, inputSelector, parse){
  const valEl = document.querySelector(valueId);
  const input = document.querySelector(inputSelector);
  if (!valEl || !input) return;
  valEl.setAttribute('contenteditable','true');
  valEl.setAttribute('role','spinbutton');
  valEl.addEventListener('keydown', (e)=>{ if (e.key === 'Enter'){ e.preventDefault(); valEl.blur(); } });
  valEl.addEventListener('blur', ()=>{
    const n = parse(valEl.textContent);
    if (Number.isFinite(n)) { input.value = String(n); input.dispatchEvent(new Event('input', { bubbles:true })); }
  });
}
makeSliderValueEditable('#noiseDbVal', '#noiseDb', v=>Number(v));
makeSliderValueEditable('#silenceSVal', '#silenceS', v=>Number(v));
makeSliderValueEditable('#padSVal', '#padS', v=>Number(v));
makeSliderValueEditable('#keepSVal', '#keepS', v=>Number(v));
makeSliderValueEditable('#mergeSVal', '#mergeS', v=>Number(v));


$('#startTrimBtn').addEventListener('click', async ()=>{
  if (state.jobId && !state.cancelling) {
    state.cancelling = true;
    setStartBtnCancelling();
    try {
      await window.py.send('cancel', { job: state.jobId });
    } catch (e) {
      console.error(e);
      state.cancelling = false;
      setStartBtnActive();
    }
    return;
  }

  if (!state.filePath || state.jobId){
      setStatus('Please select a file first.');
      return;
  }

  const btn = $('#startTrimBtn');
  btn.disabled = true;

  try {
    let outPath = state.outputPath || null;
    if (!outPath && state.defaultOutputDir && state.suggestedName && window.sys?.pathJoin) {
      try {
        const r = await window.sys.pathJoin(state.defaultOutputDir, state.suggestedName);
        if (r?.ok && r.path) outPath = r.path;
      } catch {}
    }

    const payload = getCurrentSliderValues();
    payload.path = state.filePath;
    if (outPath) payload.out = outPath;
    
    console.debug('Starting trim with payload:', payload);
    const res = await window.py.send('trim', payload);

    if (!res?.ok) throw new Error(res?.error || 'Trim failed to start.');
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message || e}`);
    setProgress(0);
    setStartBtnIdle();
  }
});