// ui.js

const $  = s => document.querySelector(s);

const state = {
  filePath: null,
  chart: null,
  lastXs: [],
  lastYs: [],
  jobId: null,
  cancelling: false,
};


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

function setStatus(t){ $('#status').textContent = t; }
function setProgress(v){ $('#progress').value = Math.max(0, Math.min(1, v)); }
function setImportFrac(f){ $('#importFill').style.width = `${Math.max(0,Math.min(1,f))*100}%`; }

window.py.onEvent(msg => {
  // Smooth progress updates to one per animation frame to avoid jank
  if (!window.__prog) window.__prog = { pending: null, raf: 0 };

  const clamp = v => Math.max(0, Math.min(1, v));

  const pump = () => {
    window.__prog.raf = 0;
    const p = window.__prog.pending;
    if (!p) return;
    const { stage, value } = p;

    setProgress(clamp(value));
    const label =
      stage === 'analyze' ? 'Analyzing histogram…' :
      stage === 'detect'  ? 'Detecting silences…'  :
      stage === 'render'  ? 'Rendering…'           : 'Working…';
    setStatus(`${label} ${(value*100|0)}%`);

    window.__prog.pending = null;
  };

  if (msg.event === 'progress' && typeof msg.value === 'number') {
    window.__prog.pending = { stage: msg.stage || 'working', value: msg.value };
    if (!window.__prog.raf) window.__prog.raf = requestAnimationFrame(pump);
    return;
  }

  if (msg.event === 'job') {
    if (msg.status === 'started' && msg.kind === 'trim') {
      state.jobId = msg.id;
      setStartBtnActive();
      setStatus('Detecting silences…'); setProgress(0.01);
      return;
    }
    if (state.jobId && msg.id === state.jobId) {
      if (msg.status === 'finished' && msg.ok) {
        setStatus(`Done: ${msg.output}`); setProgress(0);
        state.jobId = null; state.cancelling = false; setStartBtnIdle();
      } else if (msg.status === 'cancelled') {
        setStatus('Cancelled.'); setProgress(0);
        state.jobId = null; state.cancelling = false; setStartBtnIdle();
      } else if (msg.status === 'error') {
        setStatus(`Error: ${msg.error || 'Failed.'}`); setProgress(0);
        state.jobId = null; state.cancelling = false; setStartBtnIdle();
      }
    }
  }
});



async function firstFrameURL(file, t = 0) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(file);

    const cleanup = () => URL.revokeObjectURL(v.src);

    // draw current frame to a JPEG data URL
    const draw = () => {
      if (!v.videoWidth || !v.videoHeight) return false;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      cleanup();
      resolve(c.toDataURL('image/jpeg', 0.9));
      return true;
    };

    // 1) When metadata is ready, try to seek to t (or 0)
    v.addEventListener('loadedmetadata', () => {
      try { v.currentTime = Math.min(Math.max(t, 0), (isFinite(v.duration) ? v.duration : 0)); }
      catch { /* ignore */ }
    }, { once: true });

    // 2) If we can play, draw immediately (no seek required)
    v.addEventListener('loadeddata', () => {
      if (draw()) return;
      // If we got data but no frame yet, nudge a tiny seek to force a decode
      try { v.currentTime = (v.currentTime || 0) + 0.000001; } catch {}
    }, { once: true });

    // 3) After the seek completes, draw
    v.addEventListener('seeked', () => {
      if (draw()) return;
      // Fallback: try after next RAF
      requestAnimationFrame(() => { if (!draw()) reject(new Error('Could not decode first frame')); });
    }, { once: true });

    // 4) Best-effort: if supported, wait for an actually decoded frame
    if ('requestVideoFrameCallback' in v) {
      // Use as primary path to ensure a decoded frame
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


/* File pick */
$('#pickBtn').addEventListener('click', ()=> $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;

  // Thumbnail from first frame (image)
  const frameUrl = await firstFrameURL(file);
  const thumb = $('#thumb');
  thumb.classList.remove('skeleton');
  thumb.style.backgroundImage = `url(${frameUrl})`;
  thumb.style.backgroundSize = 'cover';
  thumb.style.backgroundPosition = 'center';
  $('#meta').textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB`;

  // Absolute path for Python
  let backendPath = file.path;
  if (!backendPath) {
    const ab = await file.arrayBuffer();
    const ext = file.name.split('.').pop() || 'mp4';
    backendPath = await window.py.saveTemp(ab, ext);  // <- now works without Node in preload
  }
  state.filePath = backendPath;


  // Histogram
  setStatus('Analyzing histogram…');
  setProgress(0.01);

  const { xs, ys, min, max } = await fetchRmsHistogram(state.filePath);

  state.lastXs = xs;
  state.lastYs = ys;

  // Fit sliders to the video’s actual non-empty bins (with small padding)
  const pad = 1; // 1 dB of breathing room
  const lo = Math.floor(min) - pad;
  const hi = Math.ceil(max) + pad;

  // Ensure fine control
  minRange.step = "0.1";
  maxRange.step = "0.1";



  // Update attributes + values so the thumbs start at the video’s min/max
  minRange.min = String(lo);
  minRange.max = String(hi);
  maxRange.min = String(lo);
  maxRange.max = String(hi);

  // Also re-range the Noise slider to match the video's loudness range
  const noiseSlider = $('#noiseDb');
  noiseSlider.min = String(lo);
  noiseSlider.max = String(hi);

  // Optional: start at a sensible point — midpoint or peak bin
  const midpoint = (lo + hi) / 2;
  noiseSlider.value = String(Math.round(midpoint));

  // Update its readout text
  $('#noiseDbVal').textContent = Number(noiseSlider.value).toFixed(1);


  minRange.value = String(Math.max(lo, Math.round(min)));
  maxRange.value = String(Math.min(hi, Math.round(max)));

  $('#minDb').value = String(Math.round(min));
  $('#maxDb').value = String(Math.round(max));
  updateRangeFill();
  renderHist(xs, ys, Number(minRange.value), Number(maxRange.value));

  setStatus('Histogram ready.');
  setProgress(0);

});



/* Chart */
function ensureChart(){
  if(state.chart) return state.chart;
  const ctx = $('#histChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{
      data: [], tension: .35, fill:true, borderWidth:2,
      borderColor:'#1db954', backgroundColor:'rgba(29,185,84,.18)', pointRadius:0
    }]},
    options: {
      responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ ticks:{ color:'#cfcfcf' }, grid:{ color:'rgba(255,255,255,.06)'} },
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
  ch.data.labels = sel.map(p=>p.x.toFixed(1));
  ch.data.datasets[0].data = sel.map(p => p.y); // backend already returns %
  ch.update();
}


/* Double-thumb range */
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
  $('#rangeVals').textContent = `${Math.min(min,max)} … ${Math.max(min,max)} dB`;
}
[minRange, maxRange].forEach(inp=>{
  inp.addEventListener('input', ()=>{ updateRangeFill(); renderHist(state.lastXs, state.lastYs, Number(minRange.value), Number(maxRange.value)); });
});
updateRangeFill();

async function fetchRmsHistogram(filePath) {
  try {
    if (window.py?.send) {
      const res = await window.py.send("analyze", {
  path: filePath,
  min_db: -80, max_db: 0, bins: 0.1
});
      console.log('analyze result:', res);

      if (res?.ok && Array.isArray(res.x) && Array.isArray(res.y) &&
          res.x.length > 0 && res.y.length > 0) {
        const xs = res.x.map(Number);
        const ys = res.y.map(Number);
        const nz = xs.filter((x,i) => isFinite(ys[i]) && ys[i] > 0);
        const min = nz.length ? Math.min(...nz) : Math.min(...xs);
        const max = nz.length ? Math.max(...nz) : Math.max(...xs);
        return { xs, ys, min, max };
      }
      console.warn('Analyze returned no data; falling back.', res?.error || '');
    }
  } catch (e) {
    console.error('Analyze threw:', e);
  }

  // fallback preview
  const xs = [];
  for (let x = -55; x <= -10; x += 0.1) xs.push(Number(x.toFixed(1)));
  const ysRaw = xs.map(x => {
    const a = Math.exp(-Math.pow((x + 28) / 2.3, 2));
    const b = 0.8 * Math.exp(-Math.pow((x + 21) / 3.2, 2));
    return (a + b) * 1000;
  });
  const total = ysRaw.reduce((s,v)=>s+v,0) || 1;
  const ys = ysRaw.map(v => (v / total) * 100);
  return { xs, ys, min: -50, max: -5 };
}


// --- Fix overlapped thumbs stealing clicks ---
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

// Raise the intended thumb *before* pointer events hit inputs
wrap.addEventListener('pointerdown', (e) => {
  const cx = e.clientX;                  // ← PointerEvent: use clientX
  if (Number.isFinite(cx)) bringNearestFront(cx);
}, { capture: true });

['mousemove','touchmove','pointermove'].forEach(evt=>{  // ← added pointermove
  wrap.addEventListener(evt, (e)=>{
    const cx =
      evt === 'touchmove' ? (e.touches?.[0]?.clientX ?? NaN) :
      'clientX' in e ? e.clientX : NaN;
    if (Number.isFinite(cx)) bringNearestFront(cx);
  }, { passive: true });
});

// Keep active thumb on top during drag / keyboard use
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



/* Live value readouts for trim sliders */
function bindVal(id, fmt){ const i=$(id), v=$(id+'Val'); const up=()=> v.textContent=fmt(i.value); i.addEventListener('input',up); up(); }
bindVal('#noiseDb', v=>Number(v).toFixed(1));
bindVal('#silenceS', v=>Number(v).toFixed(2));
bindVal('#padS',     v=>Number(v).toFixed(2));
bindVal('#keepS',    v=>Number(v).toFixed(2));

/* Start trimming */
$('#startTrimBtn').addEventListener('click', async ()=>{
  // If a job is running and we aren’t already cancelling → send cancel
  if (state.jobId && !state.cancelling) {
    state.cancelling = true;
    setStartBtnCancelling();
    try {
      await window.py.send('cancel', { job: state.jobId });
      // We’ll get a job "done" or "error" event shortly, which resets the UI.
    } catch (e) {
      console.error(e);
      state.cancelling = false;
      setStartBtnActive(); // back to cancelable state
    }
    return;
  }

  // Otherwise, start a new trim
  if (!state.filePath){ setStatus('Pick a video first.'); return; }

  const btn = $('#startTrimBtn');
  btn.disabled = true;
  setProgress(0);
  setStatus('Detecting silences…');

  try {
    const res = await window.py.send('trim', {
      path: state.filePath,
      noise_db: Number($('#noiseDb').value),
      silence:  Number($('#silenceS').value),
      pad:      Number($('#padS').value),
      keep:     Number($('#keepS').value)
    });

    if (!res?.ok) throw new Error(res?.error || 'Trim failed to start.');
    // "job started" event will flip the button to Cancel and re-enable it.
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message || e}`);
    setProgress(0);
    btn.disabled = false;
  }
});
