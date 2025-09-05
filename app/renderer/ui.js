
"use strict";

const $ = (s) => document.querySelector(s);

const state = {
  files: [], 
  currentIndex: -1,
  batchJobId: null,
  totalBatchDuration: 0,
  batchStartTime: null,
  cancelling: false,
  chart: null,
  defaultInputDir: null,
  defaultOutputDir: null,
  currentPreview: 'raw',
  presets: [],
};

const DOM = {
  startTrimBtn: $("#startTrimBtn"),
  pickBtn: $("#pickBtn"),
  showBtn: $("#showBtn"),
  playBtn: $("#playBtn"),
  toggleViewBtn: $("#toggleViewBtn"), 
  postActions: $("#postActions"),
  postActionSep: $("#postActionSep"),
  inputDirBtn: $("#inputDirBtn"),
  outputDirBtn: $("#outputDirBtn"),
  addPresetBtn: $("#addPresetBtn"),
  viewPresetsBtn: $("#viewPresetsBtn"),
  resetParamsBtn: $("#resetParamsBtn"),
  paramInfoBtn: $("#paramInfoBtn"),
  applyNoiseBtn: $("#applyNoiseBtn"),
  fileInput: $("#fileInput"),
  minDbRange: $("#minDb"),
  maxDbRange: $("#maxDb"),
  noiseDbSlider: $("#noiseDb"),
  status: $("#status"),
  progress: $("#progress"),
  thumb: $("#thumb"),
  meta: $("#meta"),
  ioSummary: $("#ioSummary"),
  paramCard: $("#paramCard"),
  paramCardTitle: $("#paramCardTitle"),
  presetList: $("#presetList"),
  presetItemTemplate: $("#presetItemTemplate"),
  histChartCanvas: $("#histChart"),
  rangeWrap: $(".range-wrap"),
  rangeFill: $("#rangeFill"),
  batchNav: $("#batchNav"),
  prevBtn: $("#prevBtn"),
  nextBtn: $("#nextBtn"),
  navStatus: $("#navStatus"),
  customPrompt: $("#customPrompt"),
  promptTitle: $("#promptTitle"),
  promptInput: $("#promptInput"),
  promptCancelBtn: $("#promptCancelBtn"),
  promptSaveBtn: $("#promptSaveBtn"),
  customConfirm: $("#customConfirm"),
  confirmTitle: $("#confirmTitle"),
  confirmMessage: $("#confirmMessage"),
  confirmCancelBtn: $("#confirmCancelBtn"),
  confirmOkBtn: $("#confirmOkBtn"),
};

const paramMap = {
  noise_db: { slider: "#noiseDb" },
  silence: { slider: "#silenceS" },
  pad: { slider: "#padS" },
  keep: { slider: "#keepS" },
};

const DEFAULT_PRESETS = [
  {
    id: 'default_cinematic',
    title: 'Cinematic',
    settings: { noise_db: -25.0, silence: 0.1, pad: 0.08, keep: 0.60 }
  },
  {
    id: 'default_tiktok',
    title: 'Brainrot',
    settings: { noise_db: -25.0, silence: 0.05, pad: 0.05, keep: 0.4 }
  }
];

function initializeBackendEventHandler() {
  window.py.onEvent((msg) => {
    if (msg.event === "progress") handleProgressUpdate(msg);
    else if (msg.event === "job") handleJobStatusUpdate(msg);
    else if (msg.event === "analysis_result") handleAnalysisResult(msg);
  });
}

function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 1) return '...';
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m${String(sec).padStart(2, '0')}s`;
}

function updateCollectiveProgress() {
    if (!state.batchJobId || state.totalBatchDuration <= 0) return;

    let totalProgressSeconds = 0;
    for (const file of state.files) {
        if (file.status === 'finished') {
            totalProgressSeconds += file.duration;
        } else {
            totalProgressSeconds += (file.duration || 0) * (file.progress || 0);
        }
    }

    const collectiveFraction = totalProgressSeconds / state.totalBatchDuration;
    setProgress(collectiveFraction);

    const activeFiles = state.files.filter(f => f.status === 'started' && f.stage);
    const activeStages = [...new Set(activeFiles.map(f => f.stage))];

    let stageText = 'Processing';
    if (activeStages.length === 1) {
        const stage = activeStages[0];
        stageText = stage.charAt(0).toUpperCase() + stage.slice(1) + 'ing';
    }

    const percent = (collectiveFraction * 100).toFixed(0);
    let etaText = '';
    const elapsed = state.batchStartTime ? (Date.now() - state.batchStartTime) / 1000 : 0;

    if (elapsed > 2 && collectiveFraction > 0.01 && collectiveFraction < 1.0) {
        const totalEstimatedTime = elapsed / collectiveFraction;
        const remainingTime = totalEstimatedTime - elapsed;
        etaText = ` - ETA: ${formatEta(remainingTime)}`;
    }

    setStatus(`${stageText} ${percent}%${etaText}`);
}


function handleProgressUpdate(msg) {
  if (msg.stage === 'analyze') {
      const p = Math.max(0, Math.min(1, Number(msg.value) || 0));
      setProgress(p);
      setStatus(`Analyzing ${ (p * 100).toFixed(0) }%`);
      return;
  }

  if (state.batchJobId) {
    const file = state.files.find(f => f.jobId === msg.job_id || f.path === msg.source_path);
    if (file) {
      file.progress = Math.max(0, Math.min(1, Number(msg.value) || 0));
      file.stage = msg.stage || 'working';
      file.status = 'started';
      updateCollectiveProgress();
    }
  }
}

function resetPostRenderActions() {
  const i = state.currentIndex;
  const f = state.files?.[i];

  // hide/disable the toggle until we actually have a trimmed file
  DOM.toggleViewBtn.style.display = 'none';
  DOM.toggleViewBtn.disabled = true;
  DOM.toggleViewBtn.classList.remove('active');
  DOM.toggleViewBtn.title = "Switch to Trimmed";

  // default preview back to raw
  state.currentPreview = 'raw';

  // wire action buttons to the raw file (if any)
  if (f && f.path) {
    DOM.showBtn.disabled = false;
    DOM.playBtn.disabled = false;
    DOM.showBtn.onclick = () => window.sys.showInFolder(f.path);
    DOM.playBtn.onclick = () => window.sys.openFile(f.path);

    // refresh the info panel to reflect the raw file
    displayFileInformation(f.path);
  } else {
    // no file selected — disable actions
    DOM.showBtn.disabled = true;
    DOM.playBtn.disabled = true;
    DOM.showBtn.onclick = null;
    DOM.playBtn.onclick = null;
  }
}

function showPostRenderActions(outPath, sourcePath) {
  const idx = typeof sourcePath === "string"
    ? state.files.findIndex(f => f.path === sourcePath)
    : state.currentIndex;

  if (idx < 0) return;
  const f = state.files[idx];
  if (!outPath) return;

  f.outPath = outPath;
  f.status = 'finished';

  if (idx !== state.currentIndex) return;

  DOM.toggleViewBtn.style.display = 'inline-block';
  DOM.toggleViewBtn.disabled = false;

  state.currentPreview = 'trimmed';
  DOM.toggleViewBtn.classList.add('active');
  DOM.toggleViewBtn.title = "Switch to Raw";

  DOM.showBtn.disabled = false;
  DOM.playBtn.disabled = false;
  DOM.showBtn.onclick = () => sys.showInFolder(f.outPath);
  DOM.playBtn.onclick = () => sys.openFile(f.outPath);

  displayFileInformation(f.outPath);
  DOM.navStatus.textContent = `${idx + 1} of ${state.files.length}`;
}



function handleJobStatusUpdate(msg) {
  if (state.jobId && msg.id && msg.id !== state.jobId) return;

  switch (msg.status) {
    case "started":
      state.jobId = msg.id || state.jobId;
      setStartBtnActive();
      if (msg.kind === "trim") setStatus("Detecting silences…");
      else if (msg.kind === "analyze") setStatus("Analyzing histogram…");
      else setStatus("Working…");
      setProgress(0.01);
      break;

    case "progress":
      setProgress(Math.min(0.99, msg.progress ?? 0));
      break;

    case "finished":
      state._statusHoldUntil = Date.now() + 3000;
      state.jobId = null;
      state.cancelling = false;
      setStartBtnIdle();
      setStatus("Done.");
      setProgress(0);
      if (msg.kind === "trim" && msg.ok && msg.output) {
        showPostRenderActions(msg.output, msg.source_path); // <-- pass source_path
      } else {
        resetPostRenderActions && resetPostRenderActions();
      }
      break;

    case "error":
      state._statusHoldUntil = Date.now() + 2500;
      state.jobId = null;
      state.cancelling = false;
      setStartBtnIdle();
      setStatus("Failed.");
      setProgress(0);
      break;

    case "cancelled":
      state._statusHoldUntil = Date.now() + 1500;
      state.jobId = null;
      state.cancelling = false;
      setStartBtnIdle();
      setStatus("Ready.");
      setProgress(0);
      break;

    case "ready":
      // This will be ignored during the hold window by setStatus()
      setStatus("Ready.");
      setProgress(0);
      break;
  }
}


function handleAnalysisResult(msg) {
    const file = state.files.find(f => f.jobId === msg.job_id);
    if (!file) return;

    file.analysis = { xs: msg.x, ys: msg.y };

    if (state.files[state.currentIndex] === file) {
        const xs = msg.x, ys = msg.y;

        const nz = xs.filter((x, i) => isFinite(ys[i]) && ys[i] > 0.01);
        const dataMin = nz.length ? Math.min(...nz) : -60;
        const dataMax = nz.length ? Math.max(...nz) : 0;
        
        const pad = 2;
        const newMin = Math.floor(dataMin) - pad;
        const newMax = Math.ceil(dataMax) + pad;

        [DOM.minDbRange, DOM.maxDbRange, DOM.noiseDbSlider].forEach(slider => {
            if (slider) {
                slider.min = String(newMin);
                slider.max = String(newMax);
            }
        });

        DOM.minDbRange.value = String(Math.max(newMin, Math.round(dataMin)));
        DOM.maxDbRange.value = String(Math.min(newMax, Math.round(dataMax)));
        
        renderHist(xs, ys, Number(DOM.minDbRange.value), Number(DOM.maxDbRange.value));
        
        updateRangeFill();
        setStatus("Ready.");
        setProgress(0);
    }
}
async function startAnalysisForIndex(index) {
    const file = state.files[index];
    if (!file || file.jobId || file.analysis) return;
    setStatus(`Analyzing...`);
    renderHist([], [], -60, 0);
    try {
        const res = await window.py.send("analyze", { path: file.path, min_db: -80, max_db: 0, bins: 0.1 });
        if (res?.ok && res.job) {
            file.jobId = res.job;
        } else {
            throw new Error(res?.error || "Failed to start analysis.");
        }
    } catch (e) {
        setStatus("Analysis Error.");
        console.error(e);
    }
}

function setStatus(t) {
  const now = Date.now();
  if (t === "Ready." && state._statusHoldUntil && now < state._statusHoldUntil) return;
  DOM.status.textContent = t;
}

function setProgress(v) { DOM.progress.value = Math.max(0, Math.min(1, v)); }

function setStartBtnIdle() {
  const b = DOM.startTrimBtn; b.classList.remove("danger");
  b.textContent = state.files.length > 1 ? `Start Batch Trim (${state.files.length})` : "Start";
  b.disabled = false;
}

function setStartBtnActive() {
  const b = DOM.startTrimBtn; b.classList.add("danger"); b.textContent = "Cancel"; b.disabled = false;
}

function setStartBtnCancelling() {
  const b = DOM.startTrimBtn; b.classList.add("danger"); b.textContent = "Cancelling…"; b.disabled = true;
}

async function displayVideo(index) {
  if (index < 0 || index >= state.files.length) {
    DOM.showBtn.disabled = true;
    DOM.playBtn.disabled = true;
    DOM.toggleViewBtn.style.display = 'none';
    DOM.toggleViewBtn.disabled = true;
    DOM.showBtn.onclick = null;
    DOM.playBtn.onclick = null;
    return;
  }

  state.currentIndex = index;
  const file = state.files[index];

  DOM.showBtn.disabled = false;
  DOM.playBtn.disabled = false;
  DOM.showBtn.onclick = () => sys.showInFolder(file.path);
  DOM.playBtn.onclick = () => sys.openFile(file.path);

  if (file.outPath) {
    DOM.toggleViewBtn.style.display = 'inline-block';
    DOM.toggleViewBtn.disabled = false;
  } else {
    DOM.toggleViewBtn.style.display = 'none';
    DOM.toggleViewBtn.disabled = true;
  }

  state.currentPreview = 'raw';
  DOM.toggleViewBtn.classList.remove('active');
  DOM.toggleViewBtn.title = "Switch to Trimmed";

  DOM.navStatus.textContent = `${index + 1} of ${state.files.length}`;
  await displayFileInformation(file.path);

  if (file.analysis) {
    renderHist(file.analysis.xs, file.analysis.ys);
    setStatus("Ready.");
    setProgress(0);
  } else {
    startAnalysisForIndex(index);
  }
}


async function loadFiles(paths) {
    if (!paths || paths.length === 0) return;
    setStatus("Probing files...");
    setProgress(0);
    const filePromises = paths.map(async (p) => {
        const res = await window.py.send("probe", { path: p });
        return {
            path: p,
            duration: res.ok ? res.duration : 0,
            progress: 0,
            stage: null,
            thumb: null,
            analysis: null,
            jobId: null,
            outPath: null,
            status: null
        };
    });
    state.files = await Promise.all(filePromises);
    state.totalBatchDuration = state.files.reduce((sum, f) => sum + f.duration, 0);
    if (state.files.length > 1) {
        DOM.batchNav.style.display = 'flex';
        DOM.startTrimBtn.textContent = `Start Batch Trim (${state.files.length})`;
    } else {
        DOM.batchNav.style.display = 'none';
        DOM.startTrimBtn.textContent = "Start";
    }
    displayVideo(0);
}

async function displayFileInformation(filePath) {
  const { thumb, meta } = DOM;
  const metaTitle = meta.querySelector(".meta-title");
  const metaStats = meta.querySelector(".meta-stats");

  thumb.classList.add("skeleton");
  thumb.style.setProperty("--thumb-url", "none");
  if (metaTitle) metaTitle.textContent = "Loading info...";
  if (metaStats) metaStats.textContent = "";

  const base = filePath.split(/[/\\]/).pop() || "video.mp4";
  let durText = "—:—", sizeText = "— MB";
  const fileData = state.files.find(f => f.path === filePath);
  if (fileData && fileData.duration > 0) {
      durText = formatDuration(fileData.duration);
  } else {
    try {
        const pr = await window.py.send("probe", { path: filePath });
        if (pr?.ok && Number.isFinite(pr.duration)) durText = formatDuration(pr.duration);
    } catch { }
  }
  try {
    const st = await window.sys?.fsStat?.(filePath);
    if (st?.ok && typeof st.size === "number") sizeText = formatSize(st.size);
  } catch { }
  if (metaTitle && metaStats) {
    const MAX = 26, i = base.lastIndexOf("."), hasExt = i > 0 && base.length - i <= 5;
    let name = hasExt ? base.slice(0, i) : base; const ext = hasExt ? base.slice(i) : "";
    if (name.length > MAX) name = name.slice(0, MAX) + "..";
    metaTitle.textContent = name + ext;
    metaTitle.title = base;
    metaStats.innerHTML = `${durText} <span class="stats-sep">|</span> ${sizeText}`;
  }

  try {
    const th = await window.py.send("thumb", { path: filePath });
    if (th?.ok && th.dataUrl) {
      thumb.classList.remove("skeleton");
      thumb.style.setProperty("--thumb-url", `url(${th.dataUrl})`);
      const img = new Image();
      img.onload = () => {
        const portrait = img.naturalHeight > img.naturalWidth;
        thumb.style.setProperty("--thumb-fore-size", portrait ? "contain" : "cover");
      };
      img.src = th.dataUrl;
    }
  } catch { }
}

function getCurrentSliderValues() {
  const vals = {};
  for (const k in paramMap) {
    const el = $(paramMap[k].slider);
    if (el) vals[k] = parseFloat(el.value);
  }
  return vals;
}

async function loadSettings() {
  try {
    const res = await window.sys?.getSettings?.();
    const st = res?.settings || {};
    state.defaultInputDir = typeof st.defaultInputDir === "string" ? st.defaultInputDir : null;
    state.defaultOutputDir = typeof st.defaultOutputDir === "string" ? st.defaultOutputDir : null;
    
    const userPresets = Array.isArray(st.presets) ? st.presets : [];
    state.presets = [...DEFAULT_PRESETS, ...userPresets];

    renderPresets();
    updateIoSummary();
  } catch {}
}

async function savePresets() { 
  const userPresets = state.presets.filter(p => !String(p.id).startsWith('default_'));
  await window.sys.setSettings({ presets: userPresets }); 
}

function renderPresets() {
  const list = DOM.presetList, tpl = DOM.presetItemTemplate;
  if (!list || !tpl) return;
  list.innerHTML = state.presets.length > 0 ? "" : `<li class="preset-item-empty">No presets saved.</li>`;
  
  state.presets.forEach((p) => {
    const item = tpl.content.cloneNode(true).querySelector(".preset-item");
    item.querySelector(".preset-title").textContent = p.title;
    item.addEventListener("click", () => { applyPreset(p.id); showParamView("front"); });

    if (String(p.id).startsWith('default_')) {
        item.querySelector('.preset-actions').remove();
    } else {
        item.querySelector(".preset-edit").addEventListener("click", (e) => { e.stopPropagation(); editPreset(p.id); });
        item.querySelector(".preset-delete").addEventListener("click", (e) => { e.stopPropagation(); deletePreset(p.id); });
    }
    list.appendChild(item);
  });
}

function applyPreset(id) {
  const p = state.presets.find((x) => x.id === id); if (!p) return;
  for (const k in paramMap) {
    if (p.settings.hasOwnProperty(k)) {
      const s = $(paramMap[k].slider);
      if (s) { s.value = p.settings[k]; s.dispatchEvent(new Event("input")); }
    }
  }
}

async function editPreset(id) {
  const p = state.presets.find((x) => x.id === id); if (!p) return;
  const newTitle = await showPrompt({
    title: "Enter a new preset name",
    defaultValue: p.title
  });
  if (newTitle !== null && newTitle.trim()) {
    p.title = newTitle.trim();
    savePresets();
    renderPresets();
  }
}

async function deletePreset(id) {
  const p = state.presets.find((x) => x.id === id); if (!p) return;
  const confirmed = await showConfirm({
    title: "Confirm Deletion",
    message: `Are you sure you want to delete the preset "${p.title}"? This action cannot be undone.`
  });
  if (confirmed) {
    state.presets = state.presets.filter((x) => x.id !== id);
    savePresets();
    renderPresets();
  }
}

function ensureChart() {
  if (state.chart) return state.chart;
  const ctx = DOM.histChartCanvas.getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
    data: { datasets: [{ data: [], tension: 0.35, fill: true, borderWidth: 2, borderColor: "#1db954", backgroundColor: "rgba(29,185,84,.18)", pointRadius: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { type: "linear", ticks: { color: "#cfcfcf", count: 8, callback: (v) => Math.round(v).toString() }, grid: { color: "rgba(255,255,255,.06)" } },
        y: { ticks: { color: "#cfcfcf", callback: (v) => v + "%" }, grid: { color: "rgba(255,255,255,.06)" } },
      },
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
    },
  });
  return state.chart;
}

function renderHist(xs, ys, lo = null, hi = null) {
  const ch = ensureChart();
  if (!xs || xs.length === 0) {
    ch.data.datasets[0].data = [];
    ch.update();
    return;
  }
  if (lo === null) lo = Number(DOM.minDbRange.value);
  if (hi === null) hi = Number(DOM.maxDbRange.value);
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const sel = xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => p.x >= a && p.x <= b && Number.isFinite(p.y));
  ch.options.scales.x.min = a;
  ch.options.scales.x.max = b;
  ch.data.datasets[0].data = sel;
  ch.update();
}

function updateRangeFill() {
  const { minDbRange, maxDbRange, rangeWrap, rangeFill } = DOM;
  const min = Number(minDbRange.value), max = Number(maxDbRange.value);
  if (min > max) {
    if (document.activeElement === minDbRange) maxDbRange.value = String(min);
    else minDbRange.value = String(max);
  }
  const track = rangeWrap.clientWidth;
  const toX = (inp) => ((Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min))) * track;
  const x1 = toX(minDbRange), x2 = toX(maxDbRange);
  const left = Math.min(x1, x2), right = Math.max(x1, x2);
  rangeFill.style.left = `${left}px`;
  rangeFill.style.width = `${Math.max(0, right - left)}px`;
}

async function loadAndApplyParams() {
  try {
    const res = await window.py.send("get_params_config");
    if (!res?.ok) return;
    const cfg = res.config;
    for (const k in cfg) {
      if (!paramMap[k]) continue;
      const s = $(paramMap[k].slider);
      if (!s) continue;
      s.min = String(cfg[k].min);
      s.max = String(cfg[k].max);
      s.step = String(cfg[k].step);
      s.value = String(cfg[k].default);
      s.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch { }
}

function updateIoSummary() {
  const inDir = state.defaultInputDir || "Default (Downloads)";
  const outDir = state.defaultOutputDir || "Default (Downloads)";
  if (DOM.ioSummary) DOM.ioSummary.innerHTML = `<span class="io-label">Input:</span> ${inDir}  <span class="sep">|</span>  <span class="io-label">Output:</span> ${outDir}`;
}

function showParamView(view) {
  const c = DOM.paramCard, t = DOM.paramCardTitle;
  c.classList.remove("show-info", "show-presets");
  if (view === "info") { c.classList.add("show-info"); t.textContent = "Parameter Info"; }
  else if (view === "presets") { c.classList.add("show-presets"); t.textContent = "Presets"; }
  else t.textContent = "Trimming Parameters";
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb < 100) return `${mb.toPrecision(3)} MB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toPrecision(3)} GB`;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h${two(m)}m${two(sec)}s` : `${m}m${two(sec)}s`;
}

async function handleStartTrimClick() {
  // If a batch is "active", this click cancels it
  if (state.batchJobId && !state.cancelling) {
    state.cancelling = true; setStartBtnCancelling();
    for (const file of state.files) {
      if (file.jobId) await window.py.send("cancel", { job: file.jobId });
    }
    state.batchJobId = null;
    state.batchStartTime = null;
    state.cancelling = false;
    setStartBtnIdle();
    setStatus("Ready.");
    setProgress(0);
    return;
  }

  if (state.files.length === 0) { setStatus("Select File(s)."); return; }

  // Prepare a new batch
  setStartBtnActive();
  setProgress(0);
  setStatus("Starting…");
  state.batchJobId = crypto.randomUUID();
  state.batchStartTime = Date.now();

  // reset per-file state
  state.files.forEach(f => {
    f.progress = 0;
    f.status = null;
    f.jobId = null;
    f.stage = null;
    f.outPath = null;
  });

  let started = 0;     // <— track if any job actually starts
  let errors  = 0;

  // Kick off jobs (or mark error if user cancels save dialog)
  for (const file of state.files) {
    const suggestedName = (file.path.split(/[/\\]/).pop().replace(/\.[^.]+$/, "") || "video") + "-trim.mp4";
    const outRes = await window.sys.getDefaultSavePath({ suggestedName });
    if (!outRes.ok) { file.status = 'error'; errors++; continue; }

    const payload = { ...getCurrentSliderValues(), path: file.path, out: outRes.path };
    try {
      const trimRes = await window.py.send("trim", payload);
      if (trimRes?.ok && trimRes.job) {
        file.jobId = trimRes.job;
        file.status = 'started';
        started++;
      } else {
        file.status = 'error';
        errors++;
      }
    } catch {
      file.status = 'error';
      errors++;
    }
  }

  // If nothing started, clear the batch state so the next click isn't treated as "Cancel"
  if (started === 0) {
    state.batchJobId = null;
    state.batchStartTime = null;
    setStartBtnIdle();
    setStatus(errors > 0 ? "Ready. (Nothing started)" : "Ready.");
    setProgress(0);
  }
}


async function handlePickFileClick() {
  try {
    const res = await window.sys.chooseOpen({ defaultPath: state.defaultInputDir });
    if (res?.ok && res.paths?.length) {
      await loadFiles(res.paths);
    }
  } catch (e) {
    DOM.fileInput.click();
  }
}

async function handleFileInputChange(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  const paths = Array.from(files).map(f => f.path).filter(Boolean);
  if (paths.length > 0) {
    await loadFiles(paths);
  } else {
    setStatus("File Path Error.");
  }
}

function handleAddPreset() {
  const title = `Preset ${state.presets.filter(p => !p.id.startsWith('default_')).length + 1}`;
  state.presets.push({ id: `user_${Date.now()}`, title: title, settings: getCurrentSliderValues() });
  savePresets();
  renderPresets();
  showParamView("presets");
}

function showPrompt({ title, defaultValue = '' }) {
  return new Promise((resolve) => {
    DOM.promptTitle.textContent = title;
    DOM.promptInput.value = defaultValue;
    DOM.customPrompt.classList.add("visible");
    DOM.promptInput.focus();
    DOM.promptInput.select();
    const cleanup = (value) => {
      DOM.customPrompt.classList.remove("visible");
      DOM.promptSaveBtn.onclick = null;
      DOM.promptCancelBtn.onclick = null;
      document.removeEventListener('keydown', handleKey);
      resolve(value);
    };
    const handleKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); cleanup(DOM.promptInput.value); } 
        else if (e.key === 'Escape') { cleanup(null); }
    };
    DOM.promptSaveBtn.onclick = () => cleanup(DOM.promptInput.value);
    DOM.promptCancelBtn.onclick = () => cleanup(null);
    document.addEventListener('keydown', handleKey);
  });
}

function toggleParamView(viewName) {
  const currentView = DOM.paramCard.classList.contains(`show-${viewName}`) ? "front" : viewName;
  showParamView(currentView);
}

function showConfirm({ title, message }) {
  return new Promise((resolve) => {
    DOM.confirmTitle.textContent = title;
    DOM.confirmMessage.textContent = message;
    DOM.customConfirm.classList.add("visible");
    DOM.confirmOkBtn.focus();
    const cleanup = (value) => {
      DOM.customConfirm.classList.remove("visible");
      DOM.confirmOkBtn.onclick = null;
      DOM.confirmCancelBtn.onclick = null;
      document.removeEventListener('keydown', handleKey);
      resolve(value);
    };
    const handleKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup(true); } 
      else if (e.key === 'Escape') { cleanup(false); }
    };
    DOM.confirmOkBtn.onclick = () => cleanup(true);
    DOM.confirmCancelBtn.onclick = () => cleanup(false);
    document.addEventListener('keydown', handleKey);
  });
}

function wireEventListeners() {
  DOM.startTrimBtn?.addEventListener("click", handleStartTrimClick);
  DOM.pickBtn?.addEventListener("click", handlePickFileClick);
  DOM.fileInput?.addEventListener("change", handleFileInputChange);

  DOM.toggleViewBtn?.addEventListener("click", () => {
    const file = state.files[state.currentIndex];
    if (!file || !file.outPath) return;

    if (state.currentPreview === 'raw') {
        state.currentPreview = 'trimmed';
        displayFileInformation(file.outPath);
        DOM.toggleViewBtn.classList.add('active');
        DOM.toggleViewBtn.title = "Switch to Raw";
        DOM.showBtn.onclick = () => window.sys.showInFolder(file.outPath);
        DOM.playBtn.onclick = () => window.sys.openFile(file.outPath);
    } else {
        state.currentPreview = 'raw';
        displayFileInformation(file.path);
        DOM.toggleViewBtn.classList.remove('active');
        DOM.toggleViewBtn.title = "Switch to Trimmed";
        DOM.showBtn.onclick = () => window.sys.showInFolder(file.path);
        DOM.playBtn.onclick = () => window.sys.openFile(file.path);
    }
  });

  DOM.prevBtn?.addEventListener("click", () => {
    if (state.currentIndex > 0) displayVideo(state.currentIndex - 1);
  });
  DOM.nextBtn?.addEventListener("click", () => {
    if (state.currentIndex < state.files.length - 1) displayVideo(state.currentIndex + 1);
  });

  DOM.inputDirBtn?.addEventListener("click", async () => {
    const res = await window.sys?.chooseDir?.({ title: "Select default input folder", defaultPath: state.defaultInputDir || "" });
    if (res?.ok && res.path) { state.defaultInputDir = res.path; await window.sys?.setSettings?.({ defaultInputDir: res.path }); updateIoSummary(); }
  });
  DOM.outputDirBtn?.addEventListener("click", async () => {
    const res = await window.sys?.chooseDir?.({ title: "Select default output folder", defaultPath: state.defaultOutputDir || "" });
    if (res?.ok && res.path) { state.defaultOutputDir = res.path; await window.sys?.setSettings?.({ defaultOutputDir: res.path }); updateIoSummary(); }
  });

  document.querySelectorAll(".vslider").forEach((s) => {
    const p = ((s.value - s.min) / (s.max - s.min)) * 100;
    s.style.setProperty("--p", `${p}%`);
    s.addEventListener("input", () => {
      const p = ((s.value - s.min) / (s.max - s.min)) * 100;
      s.style.setProperty("--p", `${p}%`);
    });
  });

  DOM.paramInfoBtn?.addEventListener("click", () => toggleParamView("info"));
  DOM.viewPresetsBtn?.addEventListener("click", () => toggleParamView("presets"));
  DOM.addPresetBtn?.addEventListener("click", handleAddPreset);
  DOM.resetParamsBtn?.addEventListener("click", loadAndApplyParams);
  DOM.applyNoiseBtn?.addEventListener("click", () => {
    const lo = Math.min(Number(DOM.minDbRange.value), Number(DOM.maxDbRange.value));
    if (DOM.noiseDbSlider) { DOM.noiseDbSlider.value = String(lo); DOM.noiseDbSlider.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  
  const bindVal = (id, fmt) => {
      const i = $(id), v = $(id + "Val");
      const up = () => { if (v) v.textContent = fmt(i.value); };
      i.addEventListener("input", up); up();
  };
  bindVal("#noiseDb", (v) => Number(v).toFixed(1));
  bindVal("#silenceS", (v) => Number(v).toFixed(2));
  bindVal("#padS", (v) => Number(v).toFixed(2));
  bindVal("#keepS", (v) => Number(v).toFixed(2));
  
  [DOM.minDbRange, DOM.maxDbRange].forEach((inp) => inp?.addEventListener("input", () => {
    updateRangeFill();
    if (state.files[state.currentIndex]?.analysis) {
      renderHist(state.files[state.currentIndex].analysis.xs, state.files[state.currentIndex].analysis.ys);
    }
  }));

  DOM.histChartCanvas?.addEventListener('click', (e) => {
    if (!state.chart) return;

    const chart = state.chart;
    const xScale = chart.scales.x;
    if (!xScale) return;

    const rect = DOM.histChartCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const dbValue = xScale.getValueForPixel(clickX);
    if (!Number.isFinite(dbValue)) return;
    
    const min = Number(DOM.minDbRange.min);
    const max = Number(DOM.minDbRange.max);
    const clampedValue = Math.max(min, Math.min(max, dbValue));

    DOM.minDbRange.value = clampedValue;
    DOM.minDbRange.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function initializeApp() {
  wireEventListeners();
  initializeBackendEventHandler();
  await loadSettings();
  await loadAndApplyParams();
  updateRangeFill();
  ensureChart();
}

document.addEventListener("DOMContentLoaded", initializeApp);