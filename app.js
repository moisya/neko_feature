// --- State ---
let video = null;
let csvRows = [];
let timeArr = [];     // seconds
let numCols = [];     // [{key, values:[], isNumeric:true}]
let selectedKeys = [];
let dtMedian = 1/30;  // seconds
let plotReady = false;

// --- Helpers ---
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = (arr) => {
  const a = arr.slice().sort((x,y)=>x-y); const m = Math.floor(a.length/2);
  return a.length ? (a.length%2 ? a[m] : 0.5*(a[m-1]+a[m])) : 0;
};
const movingAverage = (y, win) => {
  if (win<=1) return y.slice();
  const out = new Array(y.length).fill(NaN);
  let q=[];
  for (let i=0;i<y.length;i++){
    const v = y[i];
    q.push(Number.isFinite(v)?v:NaN);
    if (q.length>win) q.shift();
    const valid = q.filter(Number.isFinite);
    out[i] = valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : NaN;
  }
  return out;
};
const computeDtMedian = (t) => {
  const diffs=[];
  for (let i=1;i<t.length;i++){ const d=t[i]-t[i-1]; if (isFinite(d)&&d>0) diffs.push(d); }
  return diffs.length? median(diffs) : 1/30;
};
const human = (s)=> `${s.toFixed(2)}s`;
function listNumericColumns(rows){
  const hdr = Object.keys(rows[0]||{});
  const numeric = [];
  for (const k of hdr){
    if (k==='time_sec'||k==='frame'||k==='source') continue;
    let cnt=0;
    for (let i=0;i<rows.length;i++){
      const v = Number(rows[i][k]);
      if (!Number.isNaN(v)) cnt++;
    }
    if (cnt>rows.length*0.5) numeric.push(k);
  }
  return numeric;
}
function normalize01(arr){
  const v = arr.filter(Number.isFinite);
  const min = Math.min(...v), max = Math.max(...v);
  const den = (max-min)||1;
  return arr.map(x => Number.isFinite(x) ? (x-min)/den : NaN);
}
function showStatus(msg, isErr=false){
  const meta = $('meta');
  meta.innerHTML = (isErr? '⚠️ ' : '') + msg;
  meta.style.color = isErr ? '#b91c1c' : '';
}

// --- Plot ---
function drawPlot(){
  if (!timeArr.length) return;
  const norm = $('normChk').checked;
  const smoothSec = Math.max(0, parseFloat($('smoothInput').value)||0);
  const win = Math.max(1, Math.round(smoothSec / dtMedian));
  const traces = [];

  const keys = selectedKeys.length ? selectedKeys : [numCols[0]?.key].filter(Boolean);
  for (const key of keys){
    const col = numCols.find(c=>c.key===key);
    if (!col) continue;
    let y = col.values.slice();
    if (norm) y = normalize01(y);
    if (win>1) y = movingAverage(y, win);

    traces.push({
      type:'scatter', mode:'lines', name:key,
      x: timeArr, y: y,
      hovertemplate: '%{x:.3f}s<br>'+key+': %{y:.4f}<extra></extra>',
    });
  }

  // カーソル線
  const t0 = getSyncTime();
  const layout = {
    margin:{l:40,r:10,t:10,b:30},
    xaxis:{title:'time (s)', rangemode:'tozero'},
    yaxis:{title: $('normChk').checked? 'value (normalized)': 'value'},
    shapes:[{
      type:'line', xref:'x', yref:'paper', x0:t0, x1:t0, y0:0, y1:1,
      line:{color:'#111', width:2, dash:'dot'}
    }],
    legend:{orientation:'h', y:-0.2},
  };
  const config = {responsive:true, displaylogo:false};
  Plotly.newPlot('plot', traces, layout, config).then(()=>{ plotReady=true; });
}
function updateCursor(t){
  if (!plotReady) return;
  Plotly.relayout('plot', {'shapes[0].x0':t, 'shapes[0].x1':t});
}
function fitView(){
  if (!plotReady) return;
  const tMin = timeArr[0] ?? 0;
  const tMax = timeArr[timeArr.length-1] ?? 1;
  Plotly.relayout('plot', {'xaxis.autorange':false, 'xaxis.range':[tMin, tMax]});
}
// クリックで動画ジャンプ
document.getElementById('plot').addEventListener('plotly_click', (ev)=>{
  if (!video) return;
  const x = ev.points?.[0]?.x;
  if (typeof x !== 'number') return;
  const offset = parseFloat($('offsetInput').value)||0;
  video.currentTime = clamp(x + offset, 0, video.duration||x+offset);
});

// --- Video / Slider sync ---
function getSyncTime(){
  const offset = parseFloat($('offsetInput').value)||0;
  const tVid = video ? video.currentTime : 0;
  return clamp(tVid - offset, 0, Number.MAX_SAFE_INTEGER);
}
function setFromSlider(){
  if (!video) return;
  const offset = parseFloat($('offsetInput').value)||0;
  const tCsv = parseFloat($('timeSlider').value)||0;
  video.currentTime = clamp(tCsv + offset, 0, video.duration||tCsv+offset);
}
function onVideoTimeUpdate(){
  const tCsv = getSyncTime();
  $('timeSlider').value = tCsv;
  $('timeLabel').textContent = human(tCsv);
  updateCursor(tCsv);
}

// --- File loaders ---
$('videoInput').addEventListener('change', (e)=>{
  const f = e.target.files?.[0];
  if (!f) return;
  if (!video) video = $('player');

  const mime = f.type || '(unknown)';
  const can = video.canPlayType(mime || 'video/mp4');
  const szMB = (f.size/1024/1024).toFixed(1);
  showStatus(`動画: ${f.name} (${szMB} MB, ${mime}) / canPlayType="${can||'no'}"`);

  if (video.src) URL.revokeObjectURL(video.src);

  video.onerror = ()=>{
    const err = video.error;
    const codeMap = {1:'MEDIA_ERR_ABORTED',2:'NETWORK',3:'DECODE',4:'SRC_NOT_SUPPORTED'};
    showStatus(`再生エラー: ${codeMap[err?.code]||'UNKNOWN'} (${err?.message||''})`, true);
  };
  video.onstalled = ()=> showStatus('読み込みが停滞（ローカルならファイル破損の可能性）', true);
  video.onloadedmetadata = ()=>{
    $('timeSlider').max = video.duration.toFixed(3);
    showStatus(`読み込みOK / duration=${video.duration.toFixed(3)}s / ${mime} / can="${can||'no'}"`);
  };
  video.oncanplay = ()=> showStatus('再生可能になりました');
  video.onplay = ()=> showStatus('再生中…');

  video.src = URL.createObjectURL(f);
  video.playbackRate = parseFloat($('rateSel').value)||1;
  video.ontimeupdate = onVideoTimeUpdate;
});
$('rateSel').addEventListener('change', ()=>{ if(video) video.playbackRate = parseFloat($('rateSel').value)||1; });

$('csvInput').addEventListener('change', (e)=>{
  const f = e.target.files?.[0];
  if (!f) return;
  Papa.parse(f, {
    header:true, dynamicTyping:true, skipEmptyLines:true,
    complete: (res)=>{
      csvRows = res.data;
      // time_sec or frame→time
      let t = csvRows.map(r => Number(r.time_sec));
      const hasTime = t.filter(Number.isFinite).length >= csvRows.length*0.6;
      if (!hasTime){
        const fps = parseFloat($('fpsInput').value)||30;
        t = csvRows.map(r => Number(r.frame)).map(v => Number.isFinite(v)? v/fps : NaN);
      }
      timeArr = t;

      // 列候補
      const keys = listNumericColumns(csvRows);
      numCols = keys.map(k=>({key:k, values: csvRows.map(r => Number(r[k]))}));
      selectedKeys = [];

      // UI反映
      const sel = $('colSel'); sel.innerHTML='';
      for(const k of keys){
        const opt = document.createElement('option');
        opt.value=k; opt.textContent=k;
        sel.appendChild(opt);
      }
      // デフォルト選択
      const defaults = ['pfgi','tui','tfe_peak_rate','com_velocity'];
      for (const k of defaults){
        const o = Array.from(sel.options).find(o=>o.value===k);
        if (o){ o.selected = true; selectedKeys.push(k); }
      }

      // 時間情報
      dtMedian = computeDtMedian(timeArr);
      $('timeSlider').min = Math.max(0, Math.min(...timeArr));
      const tMax = Math.max(...timeArr.filter(Number.isFinite));
      $('timeSlider').max = isFinite(tMax) ? tMax.toFixed(3) : $('timeSlider').max;

      showStatus(`CSV: 行<b>${csvRows.length}</b> / 数値列<b>${keys.length}</b> / dt≈<b>${dtMedian.toFixed(3)}s</b>`);

      drawPlot();
    }
  });
});

// 選択列変更
$('colSel').addEventListener('change', (e)=>{
  selectedKeys = Array.from(e.target.selectedOptions).map(o=>o.value);
  drawPlot();
});
$('smoothInput').addEventListener('change', drawPlot);
$('normChk').addEventListener('change', drawPlot);
$('fitBtn').addEventListener('click', fitView);
$('fpsInput').addEventListener('change', ()=>{
  if (!csvRows.length) return;
  const hasTime = csvRows.some(r => Number.isFinite(Number(r.time_sec)));
  if (!hasTime){
    const fps = parseFloat($('fpsInput').value)||30;
    timeArr = csvRows.map(r => Number(r.frame)).map(v => Number.isFinite(v)? v/fps : NaN);
    dtMedian = computeDtMedian(timeArr);
    drawPlot();
  }
});
// スライダ→動画
$('timeSlider').addEventListener('input', setFromSlider);
// 1フレームステップ
function stepFrame(dir){
  if (!video) return;
  const fps = parseFloat($('fpsInput').value)||30;
  video.currentTime = clamp(video.currentTime + (dir>0? 1/fps : -1/fps), 0, video.duration||1e9);
}
$('back1f').addEventListener('click', ()=>stepFrame(-1));
$('fwd1f').addEventListener('click',  ()=>stepFrame(+1));
// キー操作
window.addEventListener('keydown',(ev)=>{
  if (ev.target.tagName==='INPUT' || ev.target.tagName==='SELECT' || ev.target.isContentEditable) return;
  if (ev.key==='ArrowLeft') stepFrame(-1);
  if (ev.key==='ArrowRight') stepFrame(+1);
  if (ev.key===' ') { if(video){ video.paused ? video.play() : video.pause(); ev.preventDefault(); } }
});
// オフセット変更→カーソル更新
$('offsetInput').addEventListener('input', ()=>{
  const tCsv = getSyncTime();
  $('timeLabel').textContent = human(tCsv);
  updateCursor(tCsv);
});

// 互換性チェック
$('compatBtn').addEventListener('click', ()=>{
  const v = $('player');
  const mp4 = v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  const webm = v.canPlayType('video/webm; codecs="vp9, vorbis"');
  showStatus(`MP4(H.264/AAC)=${mp4||'no'} / WEBM(VP9)=${webm||'no'}`);
});
