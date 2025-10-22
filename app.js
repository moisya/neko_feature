// --- State ---
let video = null;
let csvRows = [];
let timeArr = [];     // seconds
let numCols = [];     // [{key, values:[]}]
let selectedKeys = [];
let dtMedian = 1/30;  // seconds
let plotReady = false;
let labelByKey = {};  // 日本語名
let groupByKey = {};  // グループ

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

// --- 日本語ラベル/グループ付け ---
const COLUMN_PATTERNS = [
  // 耳
  {re: /^efi_depth(?:$|_)/, group:'耳', label:'耳の前向き度（深度）'},
  {re: /^efi_fused(?:$|_)/, group:'耳', label:'耳の前向き度（融合）'},
  {re: /^efi(?:$|_)/,       group:'耳', label:'耳の前向き度（EFI）'},
  {re: /^esr_depth_corr/,   group:'耳', label:'耳の広がり（深度補正）'},
  {re: /^esr(?:$|_)/,       group:'耳', label:'耳の広がり（ESR）'},

  // しっぽ
  {re: /^tui_perp(?:$|_)/,      group:'しっぽ', label:'尻尾の上げ度（直交）'},
  {re: /^tui_curvature(?:$|_)/, group:'しっぽ', label:'尻尾の曲率'},
  {re: /^tui(?:$|_)/,           group:'しっぽ', label:'尻尾の上げ度（総合）'},
  {re: /^tfe_fused(?:$|_)/,     group:'しっぽ', label:'尻尾の振り（融合）'},
  {re: /^tfe_z_rate(?:$|_)/,    group:'しっぽ', label:'尻尾の振り頻度（深度/レート）'},
  {re: /^tfe_z(?:$|_)/,         group:'しっぽ', label:'尻尾の振り（前後/深度）'},
  {re: /^tfe_peak_rate(?:$|_)/, group:'しっぽ', label:'尻尾の振り頻度（2D）'},

  // 口
  {re: /^pfgi_continuous_max_sec/,  group:'口', label:'口の開き：連続超過最大秒数'},
  {re: /^pfgi_continuous_mean_sec/, group:'口', label:'口の開き：連続超過平均秒数'},
  {re: /^pfgi(?:$|_)/,              group:'口', label:'口の開き（PFGI）'},

  // 前脚
  {re: /^pai_extension(?:$|_)/, group:'前脚', label:'前脚の伸展度'},
  {re: /^pai_peak_rate(?:$|_)/, group:'前脚', label:'前脚アクション頻度'},

  // 全身
  {re: /^com_velocity(?:$|_)/,  group:'全身', label:'重心速度'},
  {re: /^burst_peak_rate(?:$|_)/, group:'全身', label:'バースト頻度'},
  {re: /^turn_sharpness(?:$|_)/, group:'全身', label:'方向転換の鋭さ'},
];

function classifyKey(key){
  for (const p of COLUMN_PATTERNS){
    if (p.re.test(key)) return {group:p.group, label:p.label};
  }
  return {group:'その他', label:key};
}

function buildCatalog(keys){
  labelByKey = {};
  groupByKey = {};
  const groups = {'耳':[], 'しっぽ':[], '口':[], '前脚':[], '全身':[], 'その他':[]};
  for (const k of keys){
    const {group,label} = classifyKey(k);
    labelByKey[k] = label;
    groupByKey[k] = group;
    groups[group].push({key:k, label});
  }
  // 並びを分かりやすく（ラベル名で）
  for (const g of Object.keys(groups)){
    groups[g].sort((a,b)=> a.label.localeCompare(b.label,'ja'));
  }
  return groups;
}

function renderColumnPanel(groups){
  const el = $('columnPanel');
  const groupOrder = ['耳','しっぽ','口','前脚','全身','その他'];
  let html = '';
  for (const g of groupOrder){
    const items = groups[g]||[];
    const count = items.length;
    html += `<div class="group" data-group="${g}">
      <h3>${g} <span class="tiny">(${count})</span>
        <button type="button" class="ghost tiny" data-act="gsel" data-group="${g}">全選択</button>
        <button type="button" class="ghost tiny" data-act="gclr" data-group="${g}">解除</button>
      </h3>
      <div class="items">`;
    for (const it of items){
      const id = `col__${it.key.replace(/[^a-zA-Z0-9_]/g,'_')}`;
      const checked = selectedKeys.includes(it.key) ? 'checked' : '';
      html += `<div class="item" data-key="${it.key}">
        <input type="checkbox" class="colchk" id="${id}" value="${it.key}" ${checked} />
        <label for="${id}">${it.label}</label>
        <span class="badge" title="元の列名">${it.key}</span>
      </div>`;
    }
    html += `</div></div>`;
  }
  el.innerHTML = html;
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

    // 日本語名＋元キーを凡例に
    const name = (labelByKey[key] || key) + ` (${key})`;
    traces.push({
      type:'scatter', mode:'lines', name,
      x: timeArr, y: y,
      hovertemplate: '%{x:.3f}s<br>'+name+': %{y:.4f}<extra></extra>',
    });
  }

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

      // 候補列（数値）
      const keys = listNumericColumns(csvRows);
      numCols = keys.map(k=>({key:k, values: csvRows.map(r => Number(r[k]))}));

      // 既定の選択（見やすい最小セット）
      selectedKeys = ['pfgi','tui','tfe_peak_rate','com_velocity'].filter(k => keys.includes(k));

      // 日本語ラベル＆グループ
      const groups = buildCatalog(keys);
      renderColumnPanel(groups);

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

// --- 列UIの操作（イベント委譲） ---
$('columnPanel').addEventListener('change', (e)=>{
  if (e.target.classList.contains('colchk')){
    const key = e.target.value;
    if (e.target.checked){
      if (!selectedKeys.includes(key)) selectedKeys.push(key);
    } else {
      selectedKeys = selectedKeys.filter(k=>k!==key);
    }
    drawPlot();
  }
});
// グループ全選択/解除
$('columnPanel').addEventListener('click', (e)=>{
  const act = e.target.dataset.act;
  if (!act) return;
  const g = e.target.dataset.group;
  const groupBox = Array.from($(`columnPanel`).querySelectorAll(`.group[data-group="${g}"] .colchk`));
  if (act==='gsel'){
    for (const cb of groupBox){ if (!cb.checked){ cb.checked = true; if (!selectedKeys.includes(cb.value)) selectedKeys.push(cb.value); } }
  } else if (act==='gclr'){
    for (const cb of groupBox){ if (cb.checked){ cb.checked = false; selectedKeys = selectedKeys.filter(k=>k!==cb.value); } }
  }
  drawPlot();
});

// 検索フィルタ
$('searchCols').addEventListener('input', (e)=>{
  const q = e.target.value.trim().toLowerCase();
  const items = Array.from(document.querySelectorAll('#columnPanel .item'));
  for (const it of items){
    const key = it.dataset.key.toLowerCase();
    const jp  = (labelByKey[it.dataset.key]||'').toLowerCase();
    const show = !q || key.includes(q) || jp.includes(q);
    it.style.display = show ? '' : 'none';
  }
});

// プリセット
function presetSelect(pred){
  const boxes = Array.from(document.querySelectorAll('#columnPanel .colchk'));
  selectedKeys = [];
  for (const cb of boxes){
    const key = cb.value;
    const ok = pred(key);
    cb.checked = ok;
    if (ok) selectedKeys.push(key);
  }
  drawPlot();
}
$('presetEars').addEventListener('click',  ()=>presetSelect(k=>groupByKey[k]==='耳'));
$('presetTail').addEventListener('click',  ()=>presetSelect(k=>groupByKey[k]==='しっぽ'));
$('presetMouth').addEventListener('click', ()=>presetSelect(k=>groupByKey[k]==='口'));
$('presetPaws').addEventListener('click',  ()=>presetSelect(k=>groupByKey[k]==='前脚'));
$('presetBody').addEventListener('click',  ()=>presetSelect(k=>groupByKey[k]==='全身'));
$('presetAll').addEventListener('click',   ()=>presetSelect(_=>true));
$('presetClear').addEventListener('click', ()=>presetSelect(_=>false));

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
