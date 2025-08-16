// ui.js

"use strict";

// =============================================================================
// A. GLOBAL STATE & CONSTANTS
// =============================================================================

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
};

// --- DOM Element Constants ---
const DOMElements = {
  // Buttons
  startTrimBtn: $("#startTrimBtn"),
  pickBtn: $("#pickBtn"),
  outBtn: $("#outBtn"),
  showBtn: $("#showBtn"),
  playBtn: $("#playBtn"),
  inputDirBtn: $("#inputDirBtn"),
  outputDirBtn: $("#outputDirBtn"),
  addPresetBtn: $("#addPresetBtn"),
  viewPresetsBtn: $("#viewPresetsBtn"),
  resetParamsBtn: $("#resetParamsBtn"),
  paramInfoBtn: $("#paramInfoBtn"),
  applyNoiseBtn: $("#applyNoiseBtn"),
  // Inputs
  fileInput: $("#fileInput"),
  minDbRange: $("#minDb"),
  maxDbRange: $("#maxDb"),
  noiseDbSlider: $("#noiseDb"),
  // Displays & Info
  status: $("#status"),
  progress: $("#progress"),
  thumb: $("#thumb"),
  meta: $("#meta"),
  outMeta: $("#outMeta"),
  ioSummary: $("#ioSummary"),
  paramCard: $("#paramCard"),
  paramCardTitle: $("#paramCardTitle"),
  // Presets
  presetList: $("#presetList"),
  presetItemTemplate: $("#presetItemTemplate"),
  // Chart & Range
  histChartCanvas: $("#histChart"),
  rangeWrap: $(".range-wrap"),
  rangeFill: $("#rangeFill"),
};

// --- Parameter Mapping ---
const paramMap = {
  noise_db: { slider: "#noiseDb" },
  silence: { slider: "#silenceS" },
  pad: { slider: "#padS" },
  keep: { slider: "#keepS" },
};

// =============================================================================
// B. BACKEND COMMUNICATION & EVENT HANDLING
// =============================================================================

/**
 * Handles all events pushed from the Python backend.
 */
function initializeBackendEventHandler() {
  window.py.onEvent((msg) => {
    if (msg.event === "analysis_result" && msg.job_id === state.jobId) {
      handleAnalysisResult(msg);
    } else if (msg.event === "progress") {
      handleProgressUpdate(msg);
    } else if (msg.event === "job") {
      handleJobStatusUpdate(msg);
    }
  });
}

/**
 * Handles real-time progress updates from the backend.
 */
function handleProgressUpdate(msg) {
  if (!window.__prog) window.__prog = { raf: 0 };
  window.__prog.pending = { stage: msg.stage, value: msg.value };

  if (!window.__prog.raf) {
    window.__prog.raf = requestAnimationFrame(() => {
      const p = window.__prog.pending;
      if (!p) return;
      const value = Math.max(0, Math.min(1, Number(p.value) || 0));
      const stage = p.stage || "working";
      let label =
        stage === "analyze"
          ? "Analyzing…"
          : stage === "detect"
          ? "Detecting…"
          : stage === "render"
          ? "Rendering…"
          : "Working…";

      setProgress(value);
      setStatus(`${label} ${(value * 100) | 0}%`);
      window.__prog.raf = 0;
    });
  }
}

/**
 * Handles job lifecycle updates (started, finished, error, etc.).
 */
function handleJobStatusUpdate(msg) {
  if (state.jobId && msg.id !== state.jobId) return;

  switch (msg.status) {
    case "started":
      state.jobId = msg.id;
      setStartBtnActive();
      if (msg.kind === "trim") {
        resetPostRenderActions();
        setStatus("Detecting silences…");
      } else if (msg.kind === "analyze") {
        setStatus("Analyzing histogram…");
      }
      setProgress(0.01);
      break;

      case "finished":
        if (msg.kind === "trim" && msg.ok) {
          setStatus("Done.");
          showPostRenderActions(msg.output); // only enable after trim
        }
        state.jobId = null;
        state.cancelling = false;
        setStartBtnIdle();
        setProgress(0);
        if (window.__prog) window.__prog.pending = null;
        break;
        
    case "cancelled":
    case "error":
      setStatus(msg.status === "cancelled" ? "Cancelled." : `Error: ${msg.error || "Failed."}`);
      if (msg.status === "error") console.error(`${msg.kind || "Job"} error:`, msg.error);
      state.jobId = null;
      state.cancelling = false;
      setStartBtnIdle();
      setProgress(0);
      resetPostRenderActions();
      if (window.__prog) window.__prog.pending = null;
      break;
  }
}


/**
 * Starts the backend histogram analysis job.
 */
async function startAnalysisJob(path) {
  if (state.jobId) {
    setStatus("A job is already running.");
    return;
  }
  try {
    const payload = { path, min_db: -80, max_db: 0, bins: 0.1 };
    const res = await window.py.send("analyze", payload);
    if (!res?.ok || !res.job) {
      throw new Error(res?.error || "Failed to start analysis job.");
    }
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
    setStartBtnIdle();
    setProgress(0);
  }
}

// =============================================================================
// C. UI STATE & DOM UPDATES
// =============================================================================

function setStatus(text) {
  if (DOMElements.status) DOMElements.status.textContent = text;
}

function setProgress(value) {
  if (DOMElements.progress) DOMElements.progress.value = Math.max(0, Math.min(1, value));
}

function setStartBtnIdle() {
  const b = DOMElements.startTrimBtn;
  b.classList.remove("danger");
  b.textContent = "Start";
  b.disabled = false;
}

function setStartBtnActive() {
  const b = DOMElements.startTrimBtn;
  b.classList.add("danger");
  b.textContent = "Cancel";
  b.disabled = false;
}

function setStartBtnCancelling() {
  const b = DOMElements.startTrimBtn;
  b.classList.add("danger");
  b.textContent = "Cancelling…";
  b.disabled = true;
}

/**
 * Activates the 'Show' and 'Play' buttons after a successful render.
 */
function showPostRenderActions(path) {
  state.outputPath = path;
  const { showBtn, playBtn } = DOMElements;
  if (!showBtn || !playBtn) return;

  [showBtn, playBtn].forEach((btn) => {
    btn.disabled = false;
    btn.classList.add("active");
  });

  showBtn.onclick = async () => {
    const r = await window.sys.showInFolder(state.outputPath);
    if (!r?.ok) console.error("Show in folder failed:", r?.error);
  };
  playBtn.onclick = async () => {
    const r = await window.sys.openFile(state.outputPath);
    if (!r?.ok) console.error("Open file failed:", r?.error);
  };
}


/**
 * Resets and disables the 'Show' and 'Play' buttons.
 */
function resetPostRenderActions() {
  const { showBtn, playBtn } = DOMElements;
  if (!showBtn || !playBtn) return;

  [showBtn, playBtn].forEach((btn) => {
    btn.disabled = true;
    btn.classList.remove("active");
    btn.onclick = null;
  });
}

/**
 * Updates the summary text for default input/output directories.
 */
function updateIoSummary() {
  const inDir = state.defaultInputDir || "Default (Downloads)";
  const outDir = state.defaultOutputDir || "Default (Downloads)";
  if (DOMElements.ioSummary) {
    DOMElements.ioSummary.innerHTML = `<span class="io-label">Input:</span> ${inDir}  <span class="sep">|</span>  <span class="io-label">Output:</span> ${outDir}`;
  }
}

/**
 * Switches between parameter views (main, info, presets).
 */
function showParamView(viewName) {
  const card = DOMElements.paramCard;
  const title = DOMElements.paramCardTitle;
  card.classList.remove("show-info", "show-presets");

  if (viewName === "info") {
    card.classList.add("show-info");
    title.textContent = "Parameter Info";
  } else if (viewName === "presets") {
    card.classList.add("show-presets");
    title.textContent = "Presets";
  } else {
    title.textContent = "Trimming Parameters";
  }
}

// =============================================================================
// D. FILE HANDLING & PROCESSING
// =============================================================================

/**
 * Main function to handle a newly selected file.
 */
async function handleFileSelection(backendPath, fileName) {
  resetPostRenderActions();
  state.filePath = backendPath;
  state.outputPath = null;
  updateSuggestedName();

  const base = fileName.split(/[/\\]/).pop() || "video.mp4";
  let durText = "—:—";
  let sizeText = "— MB";

  try {
    const pr = await window.py.send("probe", { path: state.filePath });
    if (pr?.ok && Number.isFinite(pr.duration)) durText = formatDuration(pr.duration);
  } catch {}

  try {
    const st = await window.sys?.fsStat?.(state.filePath);
    if (st?.ok && typeof st.size === "number") sizeText = `${(st.size / 1024 / 1024).toFixed(1)} MB`;
  } catch {}

  if (DOMElements.meta) DOMElements.meta.textContent = `${base} • ${durText} • ${sizeText}`;

  // Enable actions for the INPUT file right away
  const { showBtn, playBtn } = DOMElements;
  if (showBtn && playBtn) {
    showBtn.disabled = false;
    playBtn.disabled = false;
    showBtn.classList.add('active');
    playBtn.classList.add('active');

    showBtn.onclick = async () => {
      const r = await window.sys.showInFolder(state.filePath);
      if (!r?.ok) console.error('showInFolder (input) failed:', r?.error);
    };
    playBtn.onclick = async () => {
      const r = await window.sys.openFile(state.filePath);
      if (!r?.ok) console.error('openFile (input) failed:', r?.error);
    };
  }


  try {
    const th = await window.py.send("thumb", { path: state.filePath });
    if (th?.ok && th.dataUrl) {
      const thumb = DOMElements.thumb;
      thumb.classList.remove("skeleton");
      thumb.style.setProperty("--thumb-url", `url(${th.dataUrl})`);

      const img = new Image();
      img.onload = () => {
        const isPortrait = img.naturalHeight > img.naturalWidth;
        thumb.style.setProperty("--thumb-fore-size", isPortrait ? "contain" : "cover");
      };
      img.src = th.dataUrl;
    }
  } catch {}

  startAnalysisJob(state.filePath);
}

function updateSliderFill(slider) {
  const percent = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty('--p', `${percent}%`);
}

/**
 * Generates and updates the suggested output filename based on current parameters.
 */
function updateSuggestedName() {
  if (!state.filePath) return;
  const fileName = state.filePath.split(/[/\\]/).pop();
  if (!fileName) return;

  const baseNameNoExt = fileName.replace(/\.[^\.]+$/, "");
  const vals = getCurrentSliderValues();
  const nVal = Math.abs(parseInt(vals.noise_db));
  const sVal = parseInt(vals.silence * 100);
  const pVal = parseInt(vals.pad * 100);
  const kVal = parseInt(vals.keep * 100);

  state.suggestedName = `${baseNameNoExt}-N${nVal}-S${sVal}-P${pVal}-C${kVal}.mp4`;
  if (DOMElements.outMeta) DOMElements.outMeta.textContent = `Output: ${state.suggestedName}`;
}

// =============================================================================
// E. SETTINGS & PRESET MANAGEMENT
// =============================================================================

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

async function savePresets() {
  await window.sys.setSettings({ presets: state.presets });
}

function renderPresets() {
  const list = DOMElements.presetList;
  const template = DOMElements.presetItemTemplate;
  if (!list || !template) return;

  list.innerHTML = state.presets.length > 0 ? "" : `<li class="preset-item-empty">No presets saved.</li>`;

  state.presets.forEach((preset) => {
    const item = template.content.cloneNode(true).querySelector(".preset-item");
    item.querySelector(".preset-title").textContent = preset.title;

    item.addEventListener("click", () => {
      applyPreset(preset.id);
      showParamView("front");
    });

    item.querySelector(".preset-edit").addEventListener("click", (e) => {
      e.stopPropagation();
      editPreset(preset.id);
    });

    item.querySelector(".preset-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deletePreset(preset.id);
    });

    list.appendChild(item);
  });
}

function applyPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;

  for (const key in paramMap) {
    if (preset.settings.hasOwnProperty(key)) {
      const slider = $(paramMap[key].slider);
      if (slider) {
        slider.value = preset.settings[key];
        slider.dispatchEvent(new Event("input"));
      }
    }
  }
}

function editPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;

  const newTitle = prompt("Enter a new name for the preset:", preset.title);
  if (newTitle && newTitle.trim()) {
    preset.title = newTitle.trim();
    savePresets();
    renderPresets();
  }
}

function deletePreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;

  if (confirm(`Are you sure you want to delete the preset "${preset.title}"?`)) {
    state.presets = state.presets.filter((p) => p.id !== id);
    savePresets();
    renderPresets();
  }
}

// =============================================================================
// F. CHART, HISTOGRAM & RANGE SLIDERS
// =============================================================================

function ensureChart() {
  if (state.chart) return state.chart;
  const ctx = DOMElements.histChartCanvas.getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          data: [],
          tension: 0.35,
          fill: true,
          borderWidth: 2,
          borderColor: "#1db954",
          backgroundColor: "rgba(29,185,84,.18)",
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "linear",
          ticks: { color: "#cfcfcf", count: 8, callback: (v) => Math.round(v).toString() },
          grid: { color: "rgba(255,255,255,.06)" },
        },
        y: {
          ticks: { color: "#cfcfcf", callback: (v) => v + "%" },
          grid: { color: "rgba(255,255,255,.06)" },
        },
      },
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
    },
  });
  return state.chart;
}

function renderHist(xs, ys, lo, hi) {
  if (!xs.length) return;
  const a = Math.min(lo, hi),
    b = Math.max(lo, hi);
  const sel = xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => p.x >= a && p.x <= b);
  if (!sel.length) return;
  const ch = ensureChart();
  ch.options.scales.x.min = a;
  ch.options.scales.x.max = b;
  ch.data.datasets[0].data = sel;
  ch.update();
}

/**
 * Handles the result from the analysis job and populates the histogram.
 */
function handleAnalysisResult(data) {
  if (!data.ok || !Array.isArray(data.x)) {
    setStatus("Error during analysis.");
    setStartBtnIdle();
    return;
  }
  const { x: xs, y: ys } = data;
  state.lastXs = xs;
  state.lastYs = ys;

  const nz = xs.filter((x, i) => isFinite(ys[i]) && ys[i] > 0);
  const min = nz.length ? Math.min(...nz) : Math.min(...xs);
  const max = nz.length ? Math.max(...nz) : Math.max(...xs);

  const pad = 1;
  const lo = Math.floor(min) - pad;
  const hi = Math.ceil(max) + pad;
  const { minDbRange, maxDbRange, noiseDbSlider } = DOMElements;

  [minDbRange, maxDbRange].forEach((range) => {
    range.step = "0.1";
    range.min = String(lo);
    range.max = String(hi);
  });
  noiseDbSlider.min = String(lo);
  noiseDbSlider.max = String(hi);

  noiseDbSlider.value = String(Math.round((lo + hi) / 2));
  noiseDbSlider.dispatchEvent(new Event("input"));

  minDbRange.value = String(Math.max(lo, Math.round(min)));
  maxDbRange.value = String(Math.min(hi, Math.round(max)));
  minDbRange.dispatchEvent(new Event("input"));

  setStatus("Histogram ready.");
  setProgress(0);
  state.jobId = null;
  setStartBtnIdle();
}

function updateRangeFill() {
  const { minDbRange, maxDbRange, rangeWrap, rangeFill } = DOMElements;
  const min = Number(minDbRange.value),
    max = Number(maxDbRange.value);

  if (min > max) {
    if (document.activeElement === minDbRange) maxDbRange.value = String(min);
    else minDbRange.value = String(max);
  }
  const track = rangeWrap.clientWidth;
  const toX = (inp) => ((Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min))) * track;
  const x1 = toX(minDbRange),
    x2 = toX(maxDbRange);
  const left = Math.min(x1, x2),
    right = Math.max(x1, x2);

  rangeFill.style.left = `${left}px`;
  rangeFill.style.width = `${Math.max(0, right - left)}px`;
}

// =============================================================================
// G. PARAMETERS & SLIDERS
// =============================================================================

function getCurrentSliderValues() {
  const values = {};
  for (const key in paramMap) {
    const slider = $(paramMap[key].slider);
    if (slider) {
      values[key] = parseFloat(slider.value);
    }
  }
  return values;
}

async function loadAndApplyParams() {
  try {
    const res = await window.py.send("get_params_config");
    if (!res || !res.ok) {
      console.error("Failed to fetch param config from backend:", res?.error);
      return;
    }
    const config = res.config;
    for (const key in config) {
      if (paramMap[key]) {
        const slider = $(paramMap[key].slider);
        if (slider) {
          slider.min = String(config[key].min);
          slider.max = String(config[key].max);
          slider.step = String(config[key].step);
          slider.value = String(config[key].default);
          slider.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
  } catch (e) {
    console.error("Error applying param config:", e);
  }
}

function bindVal(id, fmt) {
  const i = $(id),
    v = $(id + "Val");
  const up = () => {
    if (v) v.textContent = fmt(i.value);
  };
  i.addEventListener("input", up);
  up();
}

function makeSliderValueEditable(valueId, inputSelector, parse) {
  const valEl = $(valueId);
  const input = $(inputSelector);
  if (!valEl || !input) return;
  valEl.contentEditable = "true";
  valEl.setAttribute("role", "spinbutton");
  valEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      valEl.blur();
    }
  });
  valEl.addEventListener("blur", () => {
    const n = parse(valEl.textContent);
    if (Number.isFinite(n)) {
      input.value = String(n);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

// =============================================================================
// H. UTILITY FUNCTIONS
// =============================================================================

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * Fallback to generate a video thumbnail URL in the browser.
 */
function firstFrameURL(file, t = 0) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(file);

    const cleanup = () => URL.revokeObjectURL(v.src);
    let mediaDuration = 0;

    const draw = () => {
      if (!v.videoWidth || !v.videoHeight) return false;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      const frameUrl = c.toDataURL("image/jpeg", 0.9);
      cleanup();
      resolve({ frameUrl, duration: mediaDuration });
      return true;
    };

    v.addEventListener("loadedmetadata", () => {
      mediaDuration = Number.isFinite(v.duration) ? v.duration : 0;
      try {
        v.currentTime = Math.min(Math.max(t, 0), isFinite(v.duration) ? v.duration : 0);
      } catch {}
    }, { once: true });

    v.addEventListener("loadeddata", () => {
      if (draw()) return;
      try {
        v.currentTime = (v.currentTime || 0) + 0.000001;
      } catch {}
    }, { once: true });

    v.addEventListener("seeked", () => {
      if (draw()) return;
      requestAnimationFrame(() => {
        if (!draw()) reject(new Error("Could not decode first frame"));
      });
    }, { once: true });

    if ("requestVideoFrameCallback" in v) {
      v.requestVideoFrameCallback(() => {
        if (draw()) return;
      });
    }

    v.addEventListener("error", () => {
      cleanup();
      reject(v.error || new Error("video load error"));
    }, { once: true });
  });
}

// =============================================================================
// I. INITIALIZATION & EVENT LISTENERS
// =============================================================================

function wireEventListeners() {
  const { minDbRange, maxDbRange, rangeWrap } = DOMElements;
  // --- Main Actions ---
  DOMElements.startTrimBtn?.addEventListener("click", handleStartTrimClick);
  DOMElements.pickBtn?.addEventListener("click", handlePickFileClick);
  DOMElements.fileInput?.addEventListener("change", handleFileInputChange);
  DOMElements.outBtn?.addEventListener("click", handleOutFileClick);

  // --- Input/Output Directory Selection ---
  DOMElements.inputDirBtn?.addEventListener('click', async () => {
    try {
      const res = await window.sys?.chooseDir?.({ title: 'Select default input folder', defaultPath: state.defaultInputDir || '' });
      if (res?.ok && res.path) {
        state.defaultInputDir = res.path;
        await window.sys?.setSettings?.({ defaultInputDir: res.path });
        updateIoSummary();
      }
    } catch {}
  });

  DOMElements.outputDirBtn?.addEventListener('click', async () => {
    try {
      const res = await window.sys?.chooseDir?.({ title: 'Select default output folder', defaultPath: state.defaultOutputDir || '' });
      if (res?.ok && res.path) {
        state.defaultOutputDir = res.path;
        await window.sys?.setSettings?.({ defaultOutputDir: res.path });
        updateIoSummary();
      }
    } catch {}
  });

  document.querySelectorAll('.vslider').forEach(slider => {
    // Set the initial fill when the app loads
    updateSliderFill(slider);
    // Update the fill whenever the slider is moved
    slider.addEventListener('input', () => updateSliderFill(slider));
  });

  // --- Parameter & Preset UI ---
  DOMElements.paramInfoBtn?.addEventListener("click", () =>
    toggleParamView("info")
  );
  DOMElements.viewPresetsBtn?.addEventListener("click", () =>
    toggleParamView("presets")
  );
  DOMElements.addPresetBtn?.addEventListener("click", handleAddPreset);
  DOMElements.resetParamsBtn?.addEventListener("click", loadAndApplyParams);
  DOMElements.applyNoiseBtn?.addEventListener("click", () => {
    const lo = Math.min(Number(minDbRange.value), Number(maxDbRange.value));
    if (DOMElements.noiseDbSlider) {
      DOMElements.noiseDbSlider.value = String(lo);
      DOMElements.noiseDbSlider.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  // --- Sliders & Inputs ---
  Object.values(paramMap).forEach((m) => {
    $(m.slider)?.addEventListener("input", updateSuggestedName);
  });
  bindVal("#noiseDb", (v) => Number(v).toFixed(1));
  bindVal("#silenceS", (v) => Number(v).toFixed(2));
  bindVal("#padS", (v) => Number(v).toFixed(2));
  bindVal("#keepS", (v) => Number(v).toFixed(2));
  makeSliderValueEditable("#noiseDbVal", "#noiseDb", Number);
  makeSliderValueEditable("#silenceSVal", "#silenceS", Number);
  makeSliderValueEditable("#padSVal", "#padS", Number);
  makeSliderValueEditable("#keepSVal", "#keepS", Number);

  // --- dB Range Sliders ---
  [minDbRange, maxDbRange].forEach((inp) => {
    inp?.addEventListener("input", () => {
      updateRangeFill();
      renderHist(state.lastXs, state.lastYs, Number(minDbRange.value), Number(maxDbRange.value));
    });
  });
  wireRangeEditors();

  // --- Range Slider UX ---
  function bringNearestFront(clientX) {
    const rect = rangeWrap.getBoundingClientRect();
    const x = clientX - rect.left;
    const valueToX = (inp) =>
      ((Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min) || 1)) *
      rangeWrap.clientWidth;
    const xMin = valueToX(minDbRange);
    const xMax = valueToX(maxDbRange);
    const minIsNearest = Math.abs(x - xMin) <= Math.abs(x - xMax);
    minDbRange.classList.toggle("front", minIsNearest);
    maxDbRange.classList.toggle("front", !minIsNearest);
  }
  rangeWrap?.addEventListener("pointerdown", (e) => {
    if (Number.isFinite(e.clientX)) bringNearestFront(e.clientX);
  }, { capture: true });
  ["mousemove", "touchmove", "pointermove"].forEach((evt) => {
    rangeWrap?.addEventListener(evt, (e) => {
        const cx = evt === "touchmove" ? e.touches?.[0]?.clientX ?? NaN : e.clientX ?? NaN;
        if (Number.isFinite(cx)) bringNearestFront(cx);
      }, { passive: true });
  });
  [minDbRange, maxDbRange].forEach((inp) => {
    inp?.addEventListener("pointerdown", () => {
      minDbRange.classList.toggle("front", inp === minDbRange);
      maxDbRange.classList.toggle("front", inp === maxDbRange);
    });
  });

  // --- Chart Interaction ---
  wireChartContextMenu();
}

function wireRangeEditors() {
    const { minDbRange, maxDbRange } = DOMElements;
  const makeEditable = (id, onCommit) => {
    const span = $(`#${id}`);
    if (!span) return;
    span.contentEditable = "true";
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        span.blur();
      }
    });
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
  const canvas = DOMElements.histChartCanvas;
  if (!canvas) return;

  const setRangeFromClick = (val) => {
    const { minDbRange, maxDbRange } = DOMElements;
    const curMin = Number(minDbRange.value), curMax = Number(maxDbRange.value);
    const toMin = Math.abs(val - curMin), toMax = Math.abs(val - curMax);
    const targetRange = toMin <= toMax ? minDbRange : maxDbRange;
    targetRange.value = String(val);
    targetRange.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const getClickValue = (e) => {
    const { minDbRange, maxDbRange } = DOMElements;
    const ch = ensureChart();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const xScale = ch.scales?.x;
    const approxVal = xScale?.getValueForPixel(px) ?? 0;
    return Math.min(
        Number(maxDbRange.max),
        Math.max(Number(minDbRange.min), Math.round(Number.isFinite(approxVal) ? approxVal : 0))
    );
  };
  
  canvas.addEventListener("click", (e) => {
    try { setRangeFromClick(getClickValue(e)); } catch {}
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    try {
      const seed = getClickValue(e);
      const entered = window.prompt("Enter dB value (e.g., -47):", String(seed));
      if (entered == null) return;
      const num = Number(String(entered).replace(/[^-\d.]+/g, ""));
      if (!Number.isFinite(num)) return;
      
      const { minDbRange, maxDbRange } = DOMElements;
      const loLim = Number(minDbRange.min), hiLim = Number(maxDbRange.max);
      const val = Math.min(hiLim, Math.max(loLim, Math.round(num)));
      setRangeFromClick(val);
    } catch {}
  });
}

/**
 * Toggles the visibility of the preset or info panels.
 */
function toggleParamView(view) {
  const card = DOMElements.paramCard;
  const targetClass = `show-${view}`;
  if (card.classList.contains(targetClass)) {
    showParamView("front");
  } else {
    showParamView(view);
  }
}

/**
 * Handles the click event for the "Start Trim" button.
 */
async function handleStartTrimClick() {
  if (state.jobId && !state.cancelling) {
    state.cancelling = true;
    setStartBtnCancelling();
    try {
      await window.py.send("cancel", { job: state.jobId });
    } catch (e) {
      console.error(e);
      state.cancelling = false;
      setStartBtnActive();
    }
    return;
  }
  if (!state.filePath || state.jobId) {
    setStatus("Please select a file first.");
    return;
  }

  DOMElements.startTrimBtn.disabled = true;

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

    console.debug("Starting trim with payload:", payload);
    const res = await window.py.send("trim", payload);
    if (!res?.ok) throw new Error(res?.error || "Trim failed to start.");
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message || e}`);
    setProgress(0);
    setStartBtnIdle();
  }
}

/**
 * Opens a system dialog to choose an input file.
 */
async function handlePickFileClick() {
  if (state.jobId) return;
  resetPostRenderActions();
  try {
    const res = await window.sys.chooseOpen({});
    if (res?.ok && res.path) {
      handleFileSelection(res.path, res.path);
    }
  } catch (e) {
    console.error(e);
    DOMElements.fileInput.click();
  }
}

/**
 * Handles file selection from the hidden HTML file input (fallback).
 */
async function handleFileInputChange(e) {
  if (state.jobId) return;
  resetPostRenderActions();
  const file = e.target.files?.[0];
  if (!file) return;

  const { frameUrl } = await firstFrameURL(file);
  const thumb = DOMElements.thumb;
  thumb.classList.remove("skeleton");
  thumb.style.backgroundImage = `url(${frameUrl})`;
  thumb.style.backgroundSize = "cover";
  thumb.style.backgroundPosition = "center";

  let backendPath = file.path;
  if (!backendPath) {
    const ab = await file.arrayBuffer();
    const ext = file.name.split(".").pop() || "mp4";
    backendPath = await window.py.saveTemp(ab, ext);
  }
  handleFileSelection(backendPath, file.name);
}

/**
 * Opens a system dialog to choose a custom output path.
 */
async function handleOutFileClick() {
  try {
    const res = await window.sys.chooseSave({ suggestedName: state.suggestedName || "trimmed.mp4" });
    if (res?.ok && res.path) {
      state.outputPath = res.path;
      if (DOMElements.outMeta) DOMElements.outMeta.textContent = `Output: ${res.path}`;
    }
  } catch (e) {
    console.error("chooseSave failed", e);
  }
}

function handleAddPreset() {
  const title = prompt("Enter a name for this preset:");
  if (!title || !title.trim()) return;

  const newPreset = {
    id: Date.now(),
    title: title.trim(),
    settings: getCurrentSliderValues(),
  };
  state.presets.push(newPreset);
  savePresets();
  renderPresets();
  showParamView("presets");
}

/**
 * Sets up a placeholder chart on initial load.
 */
function initializePlaceholderChart() {
    try {
        const xs = [];
        for (let x = -55; x <= -10; x += 0.1) xs.push(Number(x.toFixed(1)));
        const ysRaw = xs.map((x) => {
          const a = Math.exp(-Math.pow((x + 28) / 2.3, 2));
          const b = 0.8 * Math.exp(-Math.pow((x + 21) / 3.2, 2));
          return (a + b) * 1000;
        });
        const total = ysRaw.reduce((s, v) => s + v, 0) || 1;
        const ys = ysRaw.map((v) => (v / total) * 100);
        state.lastXs = xs;
        state.lastYs = ys;
        renderHist(xs, ys, -50, -5);
      } catch {}
}


/**
 * Main app initialization function.
 */
async function initializeApp() {
  wireEventListeners();
  initializeBackendEventHandler();
  await loadSettings();
  await loadAndApplyParams();
  resetPostRenderActions();
  updateRangeFill();
  initializePlaceholderChart();
}

// --- Start the application once the DOM is ready ---
document.addEventListener("DOMContentLoaded", initializeApp);