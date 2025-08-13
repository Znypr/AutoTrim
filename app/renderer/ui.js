/* Minimal renderer logic: tabs, file pick, auto histogram with double-thumb range */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  filePath: null,
  chart: null,
  rmsMin: -60,
  rmsMax: -10,
  lastXs: [],
  lastYs: [],
};

function setStatus(t){ $('#status').textContent = t; }
function setProgress(v){ $('#progress').value = Math.max(0, Math.min(1, v)); }
function setImportFrac(f){ $('#importBar').style.width = `${Math.max(0,Math.min(1,f))*100}%`; }

/* Tabs */
$$('.tab-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    $$('.tab-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const id = b.dataset.tab;
    $$('.tab').forEach(t=>t.classList.remove('active'));
    $('#tab-'+id).classList.add('active');
  });
});

/* File pick (button under thumb) */
$('#pickBtn').addEventListener('click', ()=> $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if(!file) return;
  state.filePath = file.path || null;

  // Fake import progress (replace with real IPC stream if you want)
  setImportFrac(0); setStatus('Importing…');
  for(let i=1;i<=10;i++){ await new Promise(r=>setTimeout(r,40)); setImportFrac(i/10); }

  const url = URL.createObjectURL(file);
  const thumb = $('#thumb');
  thumb.classList.remove('skeleton');
  thumb.style.backgroundImage = `url(${url})`;
  $('#meta').textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB`;
  setStatus('Analyzing histogram…'); setProgress(0.15);

  // Fetch RMS dist (replace stub with IPC to real backend)
  const { xs, ys, min, max } = await fetchRmsHistogram(file.path);
  state.lastXs = xs; state.lastYs = ys; state.rmsMin = min; state.rmsMax = max;

  // Seed range to detected domain (snapped to ints)
  const minInp = $('#minDb'), maxInp = $('#maxDb');
  minInp.value = String(Math.round(min));
  maxInp.value = String(Math.round(max));
  updateRangeFill();

  renderHist(xs, ys, Number(minInp.value), Number(maxInp.value));
  setProgress(0); setStatus('Histogram ready.');
});

/* Double-thumb range handling */
const minRange = $('#minDb'), maxRange = $('#maxDb');
const rangeVals = $('#rangeVals');

function updateRangeFill(){
  const min = Number(minRange.value), max = Number(maxRange.value);
  if(min > max){ // keep coherent
    if(document.activeElement === minRange) maxRange.value = String(min);
    else minRange.value = String(max);
  }
  const wrap = $('.range-wrap');
  const trackWidth = wrap.clientWidth;
  const minX = ((Number(minRange.value) - Number(minRange.min)) / (Number(minRange.max)-Number(minRange.min))) * trackWidth;
  const maxX = ((Number(maxRange.value) - Number(maxRange.min)) / (Number(maxRange.max)-Number(maxRange.min))) * trackWidth;
  const left = Math.min(minX, maxX), right = Math.max(minX, maxX);
  const fill = $('#rangeFill');
  fill.style.left = `${left}px`;
  fill.style.width = `${Math.max(0,right-left)}px`;
  rangeVals.textContent = `${Math.min(min,max)} … ${Math.max(min,max)} dB`;
}

[minRange, maxRange].forEach(inp=>{
  inp.addEventListener('input', ()=>{
    updateRangeFill();
    // Live re-filter (no Analyze button)
    renderHist(state.lastXs, state.lastYs, Number(minRange.value), Number(maxRange.value));
  });
});

function ensureChart(){
  if(state.chart) return state.chart;
  const ctx = $('#histChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{
      data: [], tension: .35, fill: true, borderWidth: 2,
      borderColor: '#1db954', backgroundColor: 'rgba(29,185,84,.18)', pointRadius: 0
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks:{ color:'#cfcfcf' }, grid:{ color:'rgba(255,255,255,.06)' } },
        y: { ticks:{ color:'#cfcfcf', callback:v=>v+'%' }, grid:{ color:'rgba(255,255,255,.06)' } }
      },
      plugins: { legend:{ display:false }, tooltip:{ mode:'index', intersect:false } }
    }
  });
  return state.chart;
}

function renderHist(xs, ys, lo, hi){
  if(!xs?.length || !ys?.length) return;
  // Filter by visible range; re-normalize to percent for the slice
  const sel = xs.map((x,i)=>({x:x, y:ys[i]})).filter(p => p.x>=Math.min(lo,hi) && p.x<=Math.max(lo,hi));
  if(sel.length===0) return;
  const sum = sel.reduce((a,b)=>a+b.y,0) || 1;
  const pct = sel.map(p => (p.y / sum) * 100);
  const ch = ensureChart();
  ch.data.labels = sel.map(p => p.x.toFixed(1));
  ch.data.datasets[0].data = pct;
  ch.update();
}

/* Stub: generate a plausible distribution + detected min/max
   Replace with IPC to your Python/FFmpeg backend. */
async function fetchRmsHistogram(_filePath){
  // create domain −55 … −10 with two lobes
  const xs = [];
  for(let x=-55;x<=-10;x+=0.1) xs.push(Number(x.toFixed(1)));
  const ys = xs.map(x=>{
    const a = Math.exp(-Math.pow((x+28)/2.3,2));
    const b = .8*Math.exp(-Math.pow((x+21)/3.2,2));
    return (a+b)*1000;
  });
  const min = Math.min(...xs), max = Math.max(...xs);
  await new Promise(r=>setTimeout(r,200));
  return { xs, ys, min, max };
}

/* Trim sliders live labels */
function bindVal(id, fmt){ const i=$(id), v=$(id+'Val'); const up=()=> v.textContent=fmt(i.value); i.addEventListener('input',up); up(); }
bindVal('#noiseDb', v=>Number(v).toFixed(1));
bindVal('#silenceS', v=>Number(v).toFixed(2));
bindVal('#padS',     v=>Number(v).toFixed(2));
bindVal('#keepS',    v=>Number(v).toFixed(2));

/* Start trim (wire to backend later) */
$('#startTrimBtn').addEventListener('click', ()=>{
  if(!state.filePath){ setStatus('Pick a video first.'); return; }
  setStatus('Detecting silences…'); setProgress(.1);
  // TODO: send IPC to backend with noise/silence/pad/keep and track progress
});

const importBar = document.getElementById('importProgress');

function setImportProgress(v){ importBar.value = Math.max(0, Math.min(1, v)); }

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setImportProgress(0.15);
  // … your current thumbnail/meta code
  setImportProgress(0.0);   // reset when done (or keep if you add real copy/scan progress)
});
