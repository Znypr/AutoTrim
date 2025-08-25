// ui.js
"use strict";

// ----------------------- Helpers & State -----------------------
const $ = (s) => document.querySelector(s);



const state = {
  filePath: null,
  outputPath: null,
  suggestedName: null,
  jobId: null,
  cancelling: false,
  chart: null,
  lastXs: [],
  lastYs: [],
  defaultInputDir: null,
  defaultOutputDir: null,
  presets: [],
  currentView: "raw",
};

const DOM = {
  startTrimBtn: $("#startTrimBtn"),
  pickBtn: $("#pickBtn"),
  outBtn: $("#outBtn"),
  showBtn: $("#showBtn"),
  playBtn: $("#playBtn"),
  toggleViewBtn: $("#toggleViewBtn"),
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
  outMeta: $("#outMeta"),
  ioSummary: $("#ioSummary"),
  paramCard: $("#paramCard"),
  paramCardTitle: $("#paramCardTitle"),
  presetList: $("#presetList"),
  presetItemTemplate: $("#presetItemTemplate"),
  histChartCanvas: $("#histChart"),
  rangeWrap: $(".range-wrap"),
  rangeFill: $("#rangeFill"),
};

const paramMap = {
  noise_db: { slider: "#noiseDb" },
  silence: { slider: "#silenceS" },
  pad: { slider: "#padS" },
  keep: { slider: "#keepS" },
};

window.__job = { id: null, t0: 0 };


// ----------------------- Backend Events -----------------------
function initializeBackendEventHandler() {
  window.py.onEvent((msg) => {
    if (msg.event === "progress") handleProgressUpdate(msg);
    else if (msg.event === "job") handleJobStatusUpdate(msg);
    else if (msg.event === "analysis_result" && msg.job_id === state.jobId) handleAnalysisResult(msg);
  });
}

function handleProgressUpdate(msg) {
  if (!state.jobId) return;

  const p = Math.max(0, Math.min(1, Number(msg.value) || 0));
  const stage = msg.stage || "working";
  const label = stage === "analyze" ? "Analyzing"
              : stage === "detect"  ? "Detecting silences"
              : stage === "render"  ? "Rendering"
              : "Working";

  // Prefer elapsed/p ETA (stable, independent of hint_total)
  let etaTxt = "";
  if (p > 0 && window.__job.t0) {
    const elapsed = (performance.now() - window.__job.t0) / 1000; // sec
    const remaining = elapsed * (1 - p) / p;
    // simple clamp to avoid jumpy first second
    const rem = Math.max(0, isFinite(remaining) ? remaining : 0);
    const m = Math.floor(rem / 60);
    const s = Math.round(rem % 60);
    etaTxt = ` • ETA ${m}:${String(s).padStart(2, '0')}`;
  }

  setProgress(p);
  setStatus(`${label} ${(p * 100) | 0}%${etaTxt}`);
}

function handleJobStatusUpdate(msg) {
  if (state.jobId && msg.id !== state.jobId) return;

  switch (msg.status) {
    case "started":
      state.jobId = msg.id;
      window.__job.id = msg.id;
      window.__job.t0 = performance.now();
      setStartBtnActive();
      setStatus(msg.kind === "trim" ? "Detecting silences…" : "Analyzing histogram…");
      setProgress(0.01);
      return;

    case "finished":
    case "cancelled":
    case "error":
      if (window.__prog?.raf) { cancelAnimationFrame(window.__prog.raf); window.__prog.raf = 0; }
      if (msg.status === "finished" && msg.kind === "trim" && msg.ok) {
        setStatus("Done.");
        showPostRenderActions(msg.output);
      } else {
        resetPostRenderActions();
        if (msg.status === "cancelled") setStatus("Cancelled.");
        else if (msg.status === "error") { setStatus("Error."); console.error(`${msg.kind || "Job"} error:`, msg.error); }
      }
      state.jobId = null;
      state.cancelling = false;
      window.__job.id = null;
      window.__job.t0 = 0;
      setStartBtnIdle();
      setProgress(0);
      if (window.__prog) window.__prog.pending = null;
      return;
  }
}

async function startAnalysisJob(path) {
  if (state.jobId) { setStatus("A job is already running."); return; }
  try {
    const res = await window.py.send("analyze", { path, min_db: -80, max_db: 0, bins: 0.1 });
    if (!res?.ok || !res.job) throw new Error(res?.error || "Failed to start analysis job.");
  } catch {
    setStatus("Error."); setStartBtnIdle(); setProgress(0);
  }
}

// ----------------------- UI State -----------------------
function setStatus(t) { if (DOM.status) DOM.status.textContent = t; }
function setProgress(v) { if (DOM.progress) DOM.progress.value = Math.max(0, Math.min(1, v)); }

function setStartBtnIdle() {
  const b = DOM.startTrimBtn; b.classList.remove("danger"); b.textContent = "Start"; b.disabled = false;
}
function setStartBtnActive() {
  const b = DOM.startTrimBtn; b.classList.add("danger"); b.textContent = "Cancel"; b.disabled = false;
}
function setStartBtnCancelling() {
  const b = DOM.startTrimBtn; b.classList.add("danger"); b.textContent = "Cancelling…"; b.disabled = true;
}

function showPostRenderActions(path) {
  state.outputPath = path;
  const t = DOM.toggleViewBtn; if (!t) return;
  t.disabled = false;
  state.currentView = "cut";
  t.classList.add("active");
  t.title = "Switch to Raw video";
  displayFileInformation(state.outputPath);
}

function resetPostRenderActions() {
  const { showBtn, playBtn, toggleViewBtn } = DOM;
  [showBtn, playBtn].forEach((b) => { if (b) { b.disabled = true; b.classList.remove("active"); b.onclick = null; } });
  if (toggleViewBtn) { toggleViewBtn.disabled = true; toggleViewBtn.classList.remove("active"); }
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

// ----------------------- File Handling -----------------------
async function displayFileInformation(filePath) {
  const { thumb, meta, showBtn, playBtn } = DOM;
  const metaTitle = meta.querySelector(".meta-title");
  const metaStats = meta.querySelector(".meta-stats");

  thumb.classList.add("skeleton");
  thumb.style.setProperty("--thumb-url", "none");
  if (metaTitle) metaTitle.textContent = "Loading info...";
  if (metaStats) metaStats.textContent = "";

  const base = filePath.split(/[/\\]/).pop() || "video.mp4";
  let durText = "—:—", sizeText = "— MB";

  try {
    const pr = await window.py.send("probe", { path: filePath });
    if (pr?.ok && Number.isFinite(pr.duration)) durText = formatDuration(pr.duration);
  } catch {}
  try {
    const st = await window.sys?.fsStat?.(filePath);
    if (st?.ok && typeof st.size === "number") sizeText = formatSize(st.size);
  } catch {}

  if (metaTitle && metaStats) {
    const MAX = 26, i = base.lastIndexOf("."), hasExt = i > 0 && base.length - i <= 5;
    let name = hasExt ? base.slice(0, i) : base; const ext = hasExt ? base.slice(i) : "";
    if (name.length > MAX) name = name.slice(0, MAX) + "..";
    metaTitle.textContent = name + ext;
    metaTitle.title = base;
    metaStats.innerHTML = `${durText} <span class="stats-sep">|</span> ${sizeText}`;
  } else {
    meta.innerHTML = `${base} <span class="stats-sep">|</span> ${durText} <span class="stats-sep">|</span> ${sizeText}`;
  }

  if (showBtn && playBtn) {
    showBtn.disabled = false; playBtn.disabled = false;
    showBtn.classList.add("active"); playBtn.classList.add("active");
    showBtn.onclick = async () => { const r = await window.sys.showInFolder(filePath); if (!r?.ok) console.error("showInFolder failed:", r?.error); };
    playBtn.onclick = async () => { const r = await window.sys.openFile(filePath); if (!r?.ok) console.error("openFile failed:", r?.error); };
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
  } catch {}
}

async function handleFileSelection(backendPath) {
  resetPostRenderActions();
  state.filePath = backendPath;
  state.outputPath = null;
  state.currentView = "raw";
  updateSuggestedName();
  await displayFileInformation(state.filePath);
  startAnalysisJob(state.filePath);
}

function updateSliderFill(slider) {
  const p = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty("--p", `${p}%`);
}

// ----------------------- Suggested Name -----------------------
function getCurrentSliderValues() {
  const vals = {};
  for (const k in paramMap) {
    const el = $(paramMap[k].slider);
    if (el) vals[k] = parseFloat(el.value);
  }
  return vals;
}

function updateSuggestedName() {
  if (!state.filePath) return;
  const fileName = state.filePath.split(/[/\\]/).pop(); if (!fileName) return;
  const base = fileName.replace(/\.[^.]+$/, "");
  const v = getCurrentSliderValues();
  const n = Math.abs(parseInt(v.noise_db)), s = parseInt(v.silence * 100), p = parseInt(v.pad * 100), k = parseInt(v.keep * 100);
  //state.suggestedName = `${base}-N${n}-S${s}-P${p}-C${k}.mp4`;
  state.suggestedName = `${base}-trim.mp4`;

  if (DOM.outMeta) DOM.outMeta.textContent = `Output: ${state.suggestedName}`;
}

// ----------------------- Settings & Presets -----------------------
async function loadSettings() {
  try {
    const res = await window.sys?.getSettings?.();
    const st = res?.settings || {};
    state.defaultInputDir = typeof st.defaultInputDir === "string" ? st.defaultInputDir : null;
    state.defaultOutputDir = typeof st.defaultOutputDir === "string" ? st.defaultOutputDir : null;
    state.presets = Array.isArray(st.presets) ? st.presets : [];
    renderPresets();
    updateIoSummary();
  } catch {}
}
async function savePresets() { await window.sys.setSettings({ presets: state.presets }); }

function renderPresets() {
  const list = DOM.presetList, tpl = DOM.presetItemTemplate;
  if (!list || !tpl) return;
  list.innerHTML = state.presets.length ? "" : `<li class="preset-item-empty">No presets saved.</li>`;
  state.presets.forEach((p) => {
    const item = tpl.content.cloneNode(true).querySelector(".preset-item");
    item.querySelector(".preset-title").textContent = p.title;
    item.addEventListener("click", () => { applyPreset(p.id); showParamView("front"); });
    item.querySelector(".preset-edit").addEventListener("click", (e) => { e.stopPropagation(); editPreset(p.id); });
    item.querySelector(".preset-delete").addEventListener("click", (e) => { e.stopPropagation(); deletePreset(p.id); });
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

function editPreset(id) {
  const p = state.presets.find((x) => x.id === id); if (!p) return;
  const t = prompt("Enter a new name for the preset:", p.title);
  if (t && t.trim()) { p.title = t.trim(); savePresets(); renderPresets(); }
}

function deletePreset(id) {
  const p = state.presets.find((x) => x.id === id); if (!p) return;
  if (confirm(`Delete preset "${p.title}"?`)) { state.presets = state.presets.filter((x) => x.id !== id); savePresets(); renderPresets(); }
}

// ----------------------- Chart & Ranges -----------------------
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

function renderHist(xs, ys, lo, hi) {
  if (!xs.length) return;
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const sel = xs
    .map((x, i) => ({ x, y: ys[i] }))
    .filter((p) => p.x >= a && p.x <= b && Number.isFinite(p.y));
  if (!sel.length) return;
  const ch = ensureChart();
  if (!ch) {
    console.warn("Histogram chart unavailable.");
    return;
  }
  ch.options.scales.x.min = a;
  ch.options.scales.x.max = b;
  ch.data.datasets[0].data = sel;
  ch.update();
}

function handleAnalysisResult(data) {
  if (!data.ok || !Array.isArray(data.x)) { setStatus("Error during analysis."); setStartBtnIdle(); return; }
  const xs = data.x, ys = data.y;
  state.lastXs = xs; state.lastYs = ys;

  const nz = xs.filter((x, i) => isFinite(ys[i]) && ys[i] > 0);
  const min = nz.length ? Math.min(...nz) : Math.min(...xs);
  const max = nz.length ? Math.max(...nz) : Math.max(...xs);
  const pad = 1, lo = Math.floor(min) - pad, hi = Math.ceil(max) + pad;

  [DOM.minDbRange, DOM.maxDbRange].forEach((r) => { r.step = "0.1"; r.min = String(lo); r.max = String(hi); });
  DOM.noiseDbSlider.min = String(lo);
  DOM.noiseDbSlider.max = String(hi);

  DOM.noiseDbSlider.value = String(Math.round((lo + hi) / 2));
  DOM.noiseDbSlider.dispatchEvent(new Event("input"));

  DOM.minDbRange.value = String(Math.max(lo, Math.round(min)));
  DOM.maxDbRange.value = String(Math.min(hi, Math.round(max)));
  DOM.minDbRange.dispatchEvent(new Event("input"));

  setStatus("Histogram ready.");
  setProgress(0);
  state.jobId = null;
  setStartBtnIdle();
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

// ----------------------- Params -----------------------
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
  } catch {}
}

function bindVal(id, fmt) {
  const i = $(id), v = $(id + "Val");
  const up = () => { if (v) v.textContent = fmt(i.value); };
  i.addEventListener("input", up); up();
}

function makeSliderValueEditable(valueId, inputSelector, parse) {
  const valEl = $(valueId), input = $(inputSelector);
  if (!valEl || !input) return;
  valEl.contentEditable = "true";
  valEl.setAttribute("role", "spinbutton");
  valEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); valEl.blur(); } });
  valEl.addEventListener("blur", () => {
    const n = parse(valEl.textContent);
    if (Number.isFinite(n)) { input.value = String(n); input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
}

// ----------------------- Utils -----------------------
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

function firstFrameURL(file, t = 0) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto"; v.muted = true; v.playsInline = true;
    v.src = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(v.src);
    let dur = 0;

    const draw = () => {
      if (!v.videoWidth || !v.videoHeight) return false;
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      const frameUrl = c.toDataURL("image/jpeg", 0.9);
      cleanup(); resolve({ frameUrl, duration: dur }); return true;
    };

    v.addEventListener("loadedmetadata", () => {
      dur = Number.isFinite(v.duration) ? v.duration : 0;
      try { v.currentTime = Math.min(Math.max(t, 0), isFinite(v.duration) ? v.duration : 0); } catch {}
    }, { once: true });

    v.addEventListener("loadeddata", () => {
      if (draw()) return;
      try { v.currentTime = (v.currentTime || 0) + 0.000001; } catch {}
    }, { once: true });

    v.addEventListener("seeked", () => {
      if (draw()) return;
      requestAnimationFrame(() => { if (!draw()) reject(new Error("Could not decode first frame")); });
    }, { once: true });

    if ("requestVideoFrameCallback" in v) {
      v.requestVideoFrameCallback(() => { if (draw()) return; });
    }
    v.addEventListener("error", () => { cleanup(); reject(v.error || new Error("video load error")); }, { once: true });
  });
}

// ----------------------- Event Handlers -----------------------
async function handleStartTrimClick() {
  if (state.jobId && !state.cancelling) {
    state.cancelling = true; setStartBtnCancelling();
    try { await window.py.send("cancel", { job: state.jobId }); }
    catch (e) { console.error(e); state.cancelling = false; setStartBtnActive(); }
    return;
  }
  if (!state.filePath || state.jobId) { setStatus("Please select a file first."); return; }

  DOM.startTrimBtn.disabled = true;
  try {
    let outPath = state.outputPath || null;
    if (!outPath && state.defaultOutputDir && state.suggestedName && window.sys?.pathJoin) {
      const r = await window.sys.pathJoin(state.defaultOutputDir, state.suggestedName);
      if (r?.ok && r.path) outPath = r.path;
    }
    const payload = { ...getCurrentSliderValues(), path: state.filePath };
    if (outPath) payload.out = outPath;
    const res = await window.py.send("trim", payload);
    if (!res?.ok) throw new Error(res?.error || "Trim failed to start.");
  } catch (e) {
    console.error(e); setStatus("Error."); setProgress(0); setStartBtnIdle();
  }
}

async function handlePickFileClick() {
  if (state.jobId) return;
  resetPostRenderActions();
  try {
    const res = await window.sys.chooseOpen({});
    const picked = res?.ok ? (Array.isArray(res.paths) ? res.paths[0] : res.path) : null;
    if (picked) {
      await handleFileSelection(picked);
    } else {
      DOM.fileInput.click();
    }
  } catch {
    DOM.fileInput.click();
  }
}


async function handleFileInputChange(e) {
  if (state.jobId) return;
  resetPostRenderActions();
  const file = e.target.files?.[0]; if (!file) return;

  try {
    const { frameUrl } = await firstFrameURL(file);
    const thumb = DOM.thumb;
    thumb.classList.remove("skeleton");
    thumb.style.backgroundImage = `url(${frameUrl})`;
    thumb.style.backgroundSize = "cover";
    thumb.style.backgroundPosition = "center";
  } catch {}

  let backendPath = file.path;
  if (!backendPath) {
    const ab = await file.arrayBuffer();
    const ext = file.name.split(".").pop() || "mp4";
    backendPath = await window.py.saveTemp(ab, ext);
  }
  await handleFileSelection(backendPath);
}

async function handleOutFileClick() {
  try {
    const res = await window.sys.chooseSave({ suggestedName: state.suggestedName || "trimmed.mp4" });
    if (res?.ok && res.path) { state.outputPath = res.path; if (DOM.outMeta) DOM.outMeta.textContent = `Output: ${res.path}`; }
  } catch (e) { console.error("chooseSave failed", e); }
}

function handleAddPreset() {
  const title = prompt("Enter a name for this preset:"); if (!title || !title.trim()) return;
  state.presets.push({ id: Date.now(), title: title.trim(), settings: getCurrentSliderValues() });
  savePresets(); renderPresets(); showParamView("presets");
}

// ----------------------- Chart UX -----------------------
function wireRangeEditors() {
  const { minDbRange, maxDbRange } = DOM;
  const makeEditable = (id, onCommit) => {
    const span = $(`#${id}`); if (!span) return;
    span.contentEditable = "true";
    span.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } });
    span.addEventListener("blur", () => {
      const val = Number(span.textContent);
      if (Number.isFinite(val)) onCommit(val);
      updateRangeFill();
    });
  };
  makeEditable("rangeLo", (v) => {
    minDbRange.value = String(v);
    if (Number(minDbRange.value) > Number(maxDbRange.value)) maxDbRange.value = String(v);
    minDbRange.dispatchEvent(new Event("input", { bubbles: true }));
  });
  makeEditable("rangeHi", (v) => {
    maxDbRange.value = String(v);
    if (Number(maxDbRange.value) < Number(minDbRange.value)) minDbRange.value = String(v);
    maxDbRange.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function wireChartContextMenu() {
  const canvas = DOM.histChartCanvas; if (!canvas) return;
  const setRangeFromClick = (val) => {
    const { minDbRange, maxDbRange } = DOM;
    const curMin = Number(minDbRange.value), curMax = Number(maxDbRange.value);
    const target = Math.abs(val - curMin) <= Math.abs(val - curMax) ? minDbRange : maxDbRange;
    target.value = String(val);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const getClickValue = (e) => {
    const { minDbRange, maxDbRange } = DOM;
    const ch = ensureChart();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const xScale = ch.scales?.x;
    const approx = xScale?.getValueForPixel(px) ?? 0;
    return Math.min(Number(maxDbRange.max), Math.max(Number(minDbRange.min), Math.round(Number.isFinite(approx) ? approx : 0)));
  };
  canvas.addEventListener("click", (e) => { try { setRangeFromClick(getClickValue(e)); } catch {} });
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    try {
      const seed = getClickValue(e);
      const entered = window.prompt("Enter dB value (e.g., -47):", String(seed));
      if (entered == null) return;
      const num = Number(String(entered).replace(/[^-\d.]+/g, ""));
      if (!Number.isFinite(num)) return;
      const { minDbRange, maxDbRange } = DOM;
      const loLim = Number(minDbRange.min), hiLim = Number(maxDbRange.max);
      const val = Math.min(hiLim, Math.max(loLim, Math.round(num)));
      setRangeFromClick(val);
    } catch {}
  });
}

// ----------------------- Initialization -----------------------
function wireEventListeners() {
  const { minDbRange, maxDbRange, rangeWrap, toggleViewBtn } = DOM;

  DOM.startTrimBtn?.addEventListener("click", handleStartTrimClick);
  DOM.pickBtn?.addEventListener("click", handlePickFileClick);
  DOM.fileInput?.addEventListener("change", handleFileInputChange);
  DOM.outBtn?.addEventListener("click", handleOutFileClick);

  toggleViewBtn?.addEventListener("click", () => {
    if (!state.outputPath) return;
    state.currentView = state.currentView === "raw" ? "cut" : "raw";
    if (state.currentView === "raw") {
      toggleViewBtn.classList.remove("active");
      toggleViewBtn.title = "Switch to Trimmed video";
      displayFileInformation(state.filePath);
    } else {
      toggleViewBtn.classList.add("active");
      toggleViewBtn.title = "Switch to Raw video";
      displayFileInformation(state.outputPath);
    }
  });

  DOM.inputDirBtn?.addEventListener("click", async () => {
    try {
      const res = await window.sys?.chooseDir?.({ title: "Select default input folder", defaultPath: state.defaultInputDir || "" });
      if (res?.ok && res.path) { state.defaultInputDir = res.path; await window.sys?.setSettings?.({ defaultInputDir: res.path }); updateIoSummary(); }
    } catch {}
  });
  DOM.outputDirBtn?.addEventListener("click", async () => {
    try {
      const res = await window.sys?.chooseDir?.({ title: "Select default output folder", defaultPath: state.defaultOutputDir || "" });
      if (res?.ok && res.path) { state.defaultOutputDir = res.path; await window.sys?.setSettings?.({ defaultOutputDir: res.path }); updateIoSummary(); }
    } catch {}
  });

  document.querySelectorAll(".vslider").forEach((s) => { updateSliderFill(s); s.addEventListener("input", () => updateSliderFill(s)); });

  DOM.paramInfoBtn?.addEventListener("click", () => toggleParamView("info"));
  DOM.viewPresetsBtn?.addEventListener("click", () => toggleParamView("presets"));
  DOM.addPresetBtn?.addEventListener("click", handleAddPreset);
  DOM.resetParamsBtn?.addEventListener("click", loadAndApplyParams);
  DOM.applyNoiseBtn?.addEventListener("click", () => {
    const lo = Math.min(Number(minDbRange.value), Number(maxDbRange.value));
    if (DOM.noiseDbSlider) { DOM.noiseDbSlider.value = String(lo); DOM.noiseDbSlider.dispatchEvent(new Event("input", { bubbles: true })); }
  });

  Object.values(paramMap).forEach((m) => $(m.slider)?.addEventListener("input", updateSuggestedName));
  bindVal("#noiseDb", (v) => Number(v).toFixed(1));
  bindVal("#silenceS", (v) => Number(v).toFixed(2));
  bindVal("#padS", (v) => Number(v).toFixed(2));
  bindVal("#keepS", (v) => Number(v).toFixed(2));
  makeSliderValueEditable("#noiseDbVal", "#noiseDb", Number);
  makeSliderValueEditable("#silenceSVal", "#silenceS", Number);
  makeSliderValueEditable("#padSVal", "#padS", Number);
  makeSliderValueEditable("#keepSVal", "#keepS", Number);

  [minDbRange, maxDbRange].forEach((inp) => inp?.addEventListener("input", () => {
    updateRangeFill();
    renderHist(state.lastXs, state.lastYs, Number(minDbRange.value), Number(maxDbRange.value));
  }));
  wireRangeEditors();

  function bringNearestFront(clientX) {
    const rect = rangeWrap.getBoundingClientRect();
    const x = clientX - rect.left;
    const valX = (inp) => ((Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min) || 1)) * rangeWrap.clientWidth;
    const xMin = valX(minDbRange), xMax = valX(maxDbRange);
    const minIsNearest = Math.abs(x - xMin) <= Math.abs(x - xMax);
    minDbRange.classList.toggle("front", minIsNearest);
    maxDbRange.classList.toggle("front", !minIsNearest);
  }
  rangeWrap?.addEventListener("pointerdown", (e) => { if (Number.isFinite(e.clientX)) bringNearestFront(e.clientX); }, { capture: true });
  ["mousemove", "touchmove", "pointermove"].forEach((evt) => {
    rangeWrap?.addEventListener(evt, (e) => {
      const cx = evt === "touchmove" ? e.touches?.[0]?.clientX ?? NaN : e.clientX ?? NaN;
      if (Number.isFinite(cx)) bringNearestFront(cx);
    }, { passive: true });
  });
  [minDbRange, maxDbRange].forEach((inp) => inp?.addEventListener("pointerdown", () => {
    minDbRange.classList.toggle("front", inp === minDbRange);
    maxDbRange.classList.toggle("front", inp === maxDbRange);
  }));

  wireChartContextMenu();
}

function initializePlaceholderChart() {
  try {
    const xs = []; for (let x = -55; x <= -10; x += 0.1) xs.push(Number(x.toFixed(1)));
    const ysRaw = xs.map((x) => {
      const a = Math.exp(-Math.pow((x + 28) / 2.3, 2));
      const b = 0.8 * Math.exp(-Math.pow((x + 21) / 3.2, 2));
      return (a + b) * 1000;
    });
    const total = ysRaw.reduce((s, v) => s + v, 0) || 1;
    const ys = ysRaw.map((v) => (v / total) * 100);
    state.lastXs = xs; state.lastYs = ys;
    renderHist(xs, ys, -50, -5);
  } catch {}
}

async function initializeApp() {
  wireEventListeners();
  initializeBackendEventHandler();
  await loadSettings();
  await loadAndApplyParams();
  resetPostRenderActions();
  updateRangeFill();
  initializePlaceholderChart();
}

document.addEventListener("DOMContentLoaded", initializeApp);
