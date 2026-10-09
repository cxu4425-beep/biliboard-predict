/* 術力口週榜預測（Biliboard 規則）— 前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { loaded: {}, issues: [], board: 1, curIssue: null, lib: { page: 1 } };

/* 靜態快照版會先載入 static.js，把 window.staticApi 換成讀本地 JSON；
   這樣整套前端不用改，線上版與快照版共用同一份程式。 */
const api = async (p, opt) => {
  if (window.staticApi) return window.staticApi(p, opt);
  const r = await fetch(p, opt);
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return r.json();
};
/* 綁事件但容忍元素不存在：靜態快照版會拿掉「立即更新」「重新產生 Excel」等
   只有線上版才有意義的控制項，少一個元素不該讓整支程式中斷。 */
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
const nf = n => (n === null || n === undefined || n === '') ? '—' : Math.round(Number(n)).toLocaleString('zh-Hant');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dt = (t, f) => {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return f === 'd' ? day : `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const bili = bv => 'https://www.bilibili.com/video/' + bv;
/* 封面圖來自 B 站（hdslb.com）。嵌在 Artifact 裡時外站圖片會被 CSP 擋掉，
   這時改畫一個中性色塊，版面不會因為破圖而跑掉。 */
// B 站 API 回來的封面網址是 http://，而公開版走 https —— 混合內容會被瀏覽器擋掉。
const coverOf = x => (x.cover || ('https://biliboard.uk/api/provider/biliimg/bvid/' + x.bvid))
  .replace(/^http:\/\//, 'https://');
const rk = n => `<span class="rk ${n <= 3 ? 'r' + n : ''}">${n ?? '—'}</span>`;
const tags = (arr, cls) => (arr || []).map(t => `<span class="tag ${cls}">${esc(t)}</span>`).join('');
const catTag = c => c ? `<span class="tag c-${c}">${esc(c)}</span>` : '';
const cover = x => window.NO_COVERS ? '<span class="cv ph"></span>'
  : `<img class="cv" loading="lazy" referrerpolicy="no-referrer" src="${esc(coverOf(x))}" alt="">`;

function titleCell(x) {
  const main = x.title_cn || x.title || x.video_title || x.bvid;
  const orig = x.title_cn && x.title && x.title !== x.title_cn ? x.title : '';
  const sub = [orig, x.owner_name ? 'UP：' + x.owner_name : '', x.pubtime ? dt(x.pubtime) : ''].filter(Boolean).map(esc).join('　·　');
  return `<a class="tt" href="${bili(x.bvid)}" target="_blank" rel="noopener">${esc(main)}<small>${sub}</small></a>`
    + `<button class="hb" data-song="${x.bvid}" title="在榜紀錄">📈</button>`;
}
/* ------------------------------------------------------------------ 圖表（inline SVG，無外部函式庫） */
const SVGNS = 'http://www.w3.org/2000/svg';
const compact = n => {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '億';
  if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '萬';
  return Math.round(n).toLocaleString('zh-Hant');
};
function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(+v.toFixed(10));
  return out;
}
let _vtip = null;
function showTip(ev, head, rows) {
  if (!_vtip) { _vtip = document.createElement('div'); _vtip.className = 'vtip'; document.body.appendChild(_vtip); }
  const t = _vtip;
  t.replaceChildren();
  const h = document.createElement('div'); h.className = 'vh'; h.textContent = head; t.appendChild(h);
  rows.forEach(([color, value, label]) => {
    const r = document.createElement('div'); r.className = 'vr';
    const k = document.createElement('i'); k.style.background = color; r.appendChild(k);
    const b = document.createElement('b'); b.textContent = value; r.appendChild(b);
    const s = document.createElement('span'); s.textContent = label; r.appendChild(s);
    t.appendChild(r);
  });
  t.hidden = false;
  const pad = 14, w = t.offsetWidth, hh = t.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
  if (y + hh > innerHeight - 8) y = ev.clientY - hh - pad;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
const hideTip = () => { if (_vtip) _vtip.hidden = true; };
const legendHtml = series => '<div class="vlg">' + series.map(se =>
  `<span><i style="background:var(${se.color})"></i>${esc(se.name)}</span>`).join('') + '</div>';

/* 折線圖：o.series=[{name,color:'--s1',points:[{x,y}]}]，y 為 null 時斷線；滑鼠十字線＋所有系列數值 */
function lineChart(el, o) {
  const W = Math.max(320, el.clientWidth || 640), H = o.height || 200;
  const m = { l: 56, r: 18, t: 14, b: 26 };
  const xs = [...new Set(o.series.flatMap(se => se.points.map(p => p.x)))].sort((a, b) => a - b);
  const ys = o.series.flatMap(se => se.points.map(p => p.y)).filter(v => v !== null && v !== undefined);
  if (!xs.length || !ys.length) { el.textContent = '沒有資料'; return; }
  let lo = o.yMin ?? Math.min(...ys), hi = o.yMax ?? Math.max(...ys);
  (o.refLines || []).forEach(r => { if (r.y > hi && r.y <= hi * (o.refReach || 1.2)) hi = r.y; });
  if (hi === lo) hi = lo + 1;
  const ticks = o.yTicks || niceTicks(lo, hi, 4);
  if (!o.yTicks) { lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]); }
  const x0 = xs[0], x1 = xs.length > 1 ? xs[xs.length - 1] : x0 + 1;
  const X = x => m.l + (W - m.l - m.r) * (x - x0) / (x1 - x0);
  const Y = y => o.yInvert ? m.t + (H - m.t - m.b) * (y - lo) / (hi - lo) : H - m.b - (H - m.t - m.b) * (y - lo) / (hi - lo);
  let s = `<svg class="vz" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(o.title || '')}">`;
  ticks.forEach(t => {
    s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/>` +
      `<text class="tk" x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end">${esc((o.yFmt || nf)(t))}</text>`;
  });
  const nx = Math.min(6, xs.length);
  [...new Set(Array.from({ length: nx }, (_, i) => Math.round(i * (xs.length - 1) / Math.max(1, nx - 1))))].forEach(i => {
    const anchor = xs.length === 1 ? 'start' : i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle';
    s += `<text class="tk" x="${X(xs[i])}" y="${H - 8}" text-anchor="${anchor}">${esc(o.xFmt(xs[i]))}</text>`;
  });
  s += `<line class="ax" x1="${m.l}" x2="${W - m.r}" y1="${o.yInvert ? m.t : H - m.b}" y2="${o.yInvert ? m.t : H - m.b}"/>`;
  (o.refLines || []).forEach(r => {
    if (r.y >= lo && r.y <= hi) s += `<line class="rl" x1="${m.l}" x2="${W - m.r}" y1="${Y(r.y)}" y2="${Y(r.y)}"/>` +
      `<text class="tk" x="${W - m.r - 4}" y="${Y(r.y) - 5}" text-anchor="end">${esc(r.label)}</text>`;
  });
  o.series.forEach(se => {
    const pts = se.points.slice().sort((a, b) => a.x - b.x), segs = [];
    let cur = [];
    pts.forEach(p => { if (p.y === null || p.y === undefined) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); });
    if (cur.length) segs.push(cur);
    segs.forEach(g => {
      if (o.area && !o.yInvert && g.length > 1)
        s += `<path class="ar" style="fill:var(${se.color})" d="M${X(g[0].x)},${H - m.b} ${g.map(p => `L${X(p.x)},${Y(p.y)}`).join(' ')} L${X(g[g.length - 1].x)},${H - m.b} Z"/>`;
      if (g.length > 1)
        s += `<path class="ln" style="stroke:var(${se.color})" d="${g.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ')}"/>`;
      if (g.length === 1 || o.dots) g.forEach(p => { s += `<circle class="dt" cx="${X(p.x)}" cy="${Y(p.y)}" r="4" style="fill:var(${se.color})"/>`; });
    });
    const last = pts.filter(p => p.y !== null && p.y !== undefined).pop();
    if (last && !o.dots) s += `<circle class="dt" cx="${X(last.x)}" cy="${Y(last.y)}" r="4" style="fill:var(${se.color})"/>`;
  });
  s += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/><g class="hd"></g>` +
    `<rect class="hit" x="${m.l - 10}" y="0" width="${W - m.l - m.r + 20}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = (o.series.length > 1 ? legendHtml(o.series) : '') + s;
  const svg = el.querySelector('svg'), xh = svg.querySelector('.xh'), hd = svg.querySelector('.hd'), hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    let best = xs[0];
    xs.forEach(x => { if (Math.abs(X(x) - px) < Math.abs(X(best) - px)) best = x; });
    xh.setAttribute('x1', X(best)); xh.setAttribute('x2', X(best)); xh.setAttribute('visibility', 'visible');
    hd.replaceChildren();
    const rows = o.series.map(se => {
      const p = se.points.find(q => q.x === best);
      if (!p || p.y === null || p.y === undefined) return [`var(${se.color})`, '—', se.name];
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('class', 'dt'); c.setAttribute('cx', X(best)); c.setAttribute('cy', Y(p.y)); c.setAttribute('r', 5);
      c.style.fill = `var(${se.color})`; hd.appendChild(c);
      return [`var(${se.color})`, (o.yFmtTip || o.yFmt || nf)(p.y), se.name];
    });
    showTip(ev, (o.xFmtTip || o.xFmt)(best), rows);
  });
  hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); hd.replaceChildren(); hideTip(); });
}

/* 柱狀圖（單一系列）：柱寬 ≤ 24px、頂端 4px 圓角、柱間留空；每根柱的整個欄位都是滑鼠感應區 */
function columnChart(el, o) {
  const W = Math.max(320, el.clientWidth || 640), H = o.height || 180, m = { l: 56, r: 12, t: 14, b: 26 };
  const pts = o.points;
  if (!pts.length) { el.textContent = '沒有資料'; return; }
  const ticks = niceTicks(0, Math.max(...pts.map(p => p.y)), 4), hi = ticks[ticks.length - 1] || 1;
  const band = (W - m.l - m.r) / pts.length, bw = Math.min(24, Math.max(2, band - 2));
  const Y = y => H - m.b - (H - m.t - m.b) * y / hi;
  let s = `<svg class="vz" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(o.title || '')}">`;
  ticks.forEach(t => {
    s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/>` +
      `<text class="tk" x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end">${esc((o.yFmt || compact)(t))}</text>`;
  });
  pts.forEach((p, i) => {
    const x = m.l + band * i + (band - bw) / 2, y = Y(p.y), r = Math.max(0, Math.min(4, H - m.b - y, bw / 2));
    s += `<path class="br" data-i="${i}" style="fill:var(${o.color})" d="M${x},${H - m.b} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - m.b} Z"/>`;
  });
  const every = Math.ceil(pts.length / 8);
  pts.forEach((p, i) => {
    if (i % every === 0 || i === pts.length - 1) s += `<text class="tk" x="${m.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(p.x)}</text>`;
  });
  s += `<line class="ax" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  pts.forEach((p, i) => { s += `<rect class="hitb" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" fill="transparent"/>`; });
  el.innerHTML = s + '</svg>';
  const svg = el.querySelector('svg');
  svg.querySelectorAll('.hitb').forEach(rc => {
    const i = +rc.dataset.i, bar = svg.querySelector(`.br[data-i="${i}"]`);
    rc.addEventListener('pointermove', ev => { bar.classList.add('on'); showTip(ev, o.tipHead(pts[i]), [[`var(${o.color})`, (o.yFmtTip || nf)(pts[i].y), o.name]]); });
    rc.addEventListener('pointerleave', () => { bar.classList.remove('on'); hideTip(); });
  });
}

/* 名次走勢小圖：近 8 期主榜名次＋本期預測（粉紅點），橫線以上為前 20 名 */
function sparkRank(trend, cur, maxRank = 40) {
  const pts = [...(trend || []), cur ?? null], n = pts.length;
  if (!pts.some(v => v)) return '<span class="muted">—</span>';
  const W = 76, H = 24, X = i => 3 + (W - 6) * i / (n - 1), Y = r => 3 + (H - 6) * (Math.min(r, maxRank) - 1) / (maxRank - 1);
  const segs = []; let seg = [];
  pts.forEach((v, i) => { if (v) seg.push([X(i), Y(v)]); else { if (seg.length) segs.push(seg); seg = []; } });
  if (seg.length) segs.push(seg);
  const body = segs.map(g => g.length > 1
    ? `<path class="spl" d="${g.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>`
    : `<circle class="spd" cx="${g[0][0]}" cy="${g[0][1]}" r="1.8"/>`).join('');
  const label = pts.map((v, i) => (i === n - 1 ? '本期預測 ' : '') + (v ? '#' + v : '榜外')).join(' → ');
  return `<svg class="spk" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>` +
    `<line class="sp0" x1="3" x2="${W - 3}" y1="${Y(20.5)}" y2="${Y(20.5)}"/>${body}` +
    (cur ? `<circle class="spc" cx="${X(n - 1)}" cy="${Y(cur)}" r="3"/>` : '') + '</svg>';
}

/* 名次變化（官方標示方式）：正榜、副榜一律標「上期名次 ▲▼→」；NEW 只給第一次上榜的本時段新曲。
   官方只公布前 20 名，上期第 21 名起為本站重建的名次（虛線底線標示）。 */
function chg(c) {
  if (!c) return '—';
  const p = c.prev_est
    ? `<span class="est" title="上期第 ${c.prev} 名為本站重建的副榜名次（官方只公布前 20 名）">${c.prev}</span>` : c.prev;
  switch (c.kind) {
    case 'new': return '<span class="chg new" title="第一次上榜">NEW</span>';
    case 'up': return `<span class="chg up">${p} ▲${c.diff}</span>`;
    case 'down': return `<span class="chg dn">${p} ▼${-c.diff}</span>`;
    case 'same': return `<span class="chg muted">${p} →</span>`;
    case 're': return '<span class="chg up" title="曾上榜，上期在榜外（第 40 名之後），本期重新進榜">回榜</span>';
    case 'out': return `<span class="chg up" title="上期在榜外${c.prev_full ? '（本站推估第 ' + c.prev_full + ' 名）' : ''}，本期進榜">榜外 ▲</span>`;
    case 'sub': return '<span class="chg up" title="上期在副榜，本期進入主榜（官方未公布副榜名次）">副榜 ▲</span>';
  }
  return '—';
}
/* 官方歷史榜單的 rank_change 轉成同一格式 */
function offChg(e) {
  const k = (e.rank_change || {}).kind, prev = e.last_rank;
  if (prev) return { kind: prev === e.rank ? 'same' : (prev > e.rank ? 'up' : 'down'), prev, diff: prev - e.rank };
  if (k === 'new') return { kind: 'new' };
  return { kind: (e.weeks_on_board || 0) > 1 ? 're' : 'sub' };
}
/* rate：本期得分與上期得分相比的增減（同 Biliboard 影片的標示） */
function rateCell(r) {
  if (!r || r.value === null || r.value === undefined) return '<span class="muted" title="上期未上榜，沒有可比較的得分">--%</span>';
  const t = `上期得分 ${nf(r.prev_score)}${r.est ? '（本站重建，官方只公布前 20 名）' : '（官方公布）'}`;
  return `<span class="chg ${r.value >= 0 ? 'up' : 'dn'}${r.est ? ' est' : ''}" title="${t}">${esc(r.text)}</span>`;
}
/* 連續在榜段：正好連續三週後掉榜＝社群說的「三周效應」，也叫「棉花糖效應」（同一件事） */
function runTag(x) {
  const out = (x.effects || []).map(e =>
    `<span class="tag w3" title="${esc(e.note || '')}">${esc(e.name)}</span>`);
  if (x.run && x.run.watch && !out.length)
    out.push('<span class="tag m" title="本期上榜即為連續第 3 週；下期若掉榜就是三周效應（棉花糖效應）">第 3 週</span>');
  return out.join('');
}
const METH = {
  exact: '官方已公布', newsong: '新曲·精確', snapshot: '快照·精確', snapshot_part: '快照·部分時段',
  snapshot_pre: '快照·時段前錨點',
  'curve+carryover': '累計曲線＋上期', curve: '累計曲線',
  'rate+carryover': '增速＋上期', rate: '即時增速', carryover: '上期推估'
};
const methCls = m => ({
  exact: 'snapshot', newsong: 'newsong', snapshot: 'snapshot', snapshot_part: 'snapshot',
  snapshot_pre: 'snapshot',
  'curve+carryover': 'newsong', curve: 'newsong',
  'rate+carryover': 'baseline', rate: 'baseline', carryover: 'carryover'
}[m] || 'carryover');

/* ------------------------------------------------------------------ 狀態列 */
async function loadStatus() {
  try {
    const s = await api('/api/status');
    state.status = s;
    $('#dot').className = 'dot' + (s.running ? ' busy' : '');
    $('#statusText').innerHTML = s.running ? `執行中：${esc(s.running)}` : `即時資料 ${s.snapshots.t ? dt(s.snapshots.t) : '尚未抓取'}`;
    const w = s.window;
    $('#pillWindow').innerHTML = `預測 <b>週榜 ♪${w.issue}</b>　統計 ${dt(w.start)} → ${dt(w.end)}`;
    $('#btnRefresh').disabled = $('#btnExport').disabled = !!s.running;
    if (state.panel === 'data') renderData(s);
  } catch (e) { $('#statusText').textContent = '離線'; }
}

/* ------------------------------------------------------------------ 週榜 / 傳說曲週榜 */
/* 窄螢幕要藏哪些欄位，用 class 標在格子上：hm = 手機隱藏（≤720px），hs = 更窄才隱藏（≤480px）。
   以前是在 style.css 用 nth-child 列索引，表格一加欄位索引就錯位 ——
   實際發生過：藏掉了最重要的「預測得分」，卻留著「時間修正」「估計法」。 */
const WEEK_HEAD = `<thead><tr>
  <th class="mid c-rk" style="width:54px">名次</th><th class="c-cv" style="width:92px">封面</th><th>曲名</th>
  <th class="hm" style="width:170px">歌姬 / 作曲家</th><th class="mid hm" style="width:62px">類別</th>
  <th class="mid hm" style="width:88px">上期</th>
  <th class="num hm" style="width:54px" title="主榜在榜次數（含本期，若本期進主榜）">在榜</th>
  <th class="num hm" style="width:54px" title="主榜最高排名（含本期）">最高</th>
  <th class="mid hs" style="width:86px" title="近 8 期主榜名次與本期預測名次（粉紅點）；橫線以上為前 20 名">走勢</th>
  <th class="num" style="width:104px">預測得分</th>
  <th class="num hm" style="width:78px" title="rate：預測得分 ÷ 上期得分 − 1，與 Biliboard 影片中的 rate 同一算法">rate</th>
  <th class="num hm" style="width:96px" title="bilibili 目前的累計播放數（即時）">目前累計播放</th>
  <th class="num hm" style="width:96px" title="本統計時段（上週二→本週二）預測的新增播放">本週新增播放</th>
  <th class="num hm" style="width:78px">新增收藏</th><th class="num hm" style="width:78px">新增硬幣</th>
  <th class="num hm" style="width:78px">新增點讚</th>
  <th class="num hm" style="width:64px">時間修正</th><th class="mid hm" style="width:96px">估計法</th></tr></thead>`;

function weekRow(x, maxPt) {
  return `<tr title="${esc(x.detail || '')}">
    <td class="mid">${rk(x.rank)}</td><td>${cover(x)}</td>
    <td>${titleCell(x)}${x.in_official === 0 ? `<span class="tag m" title="本時段新曲，官方下週二同步收錄池時才會確定是否收錄；估計收錄可能性 ${Math.round((x.inclusion || 0) * 100)}%">候補 · 尚未進官方池</span>` : ''}${runTag(x)}
      <div class="bar" style="width:${Math.max(3, 100 * x.score / maxPt)}%"></div></td>
    <td class="hm">${tags(x.vocalists, 's')}${tags(x.producers, 'p')}</td>
    <td class="mid hm">${catTag(x.category)}</td>
    <td class="mid hm">${chg(x.chart)}</td>
    <td class="num hm">${x.chart && x.chart.weeks ? x.chart.weeks : '—'}</td>
    <td class="num hm">${x.chart && x.chart.peak ? (x.chart.main && x.chart.peak === x.rank && x.chart.peak !== x.chart.peak_before ? '<b class="pk">' + x.chart.peak + '</b>' : x.chart.peak) : '—'}</td>
    <td class="mid hs">${sparkRank(x.chart && x.chart.trend, x.rank)}</td>
    <td class="num"><b>${nf(x.score)}</b></td>
    <td class="num hm">${rateCell(x.rate)}</td>
    <td class="num muted hm">${nf(x.live_views)}</td>
    <td class="num hm">${nf(x.pred.views)}</td><td class="num hm">${nf(x.pred.favorites)}</td>
    <td class="num hm">${nf(x.pred.coins)}</td><td class="num hm">${nf(x.pred.likes)}</td>
    <td class="num hm">${x.time_correction > 1.0001 ? '<b>' + x.time_correction.toFixed(2) + '</b>' : '1'}</td>
    <td class="mid hm"><span class="meth ${methCls(x.method)}">${METH[x.method] || x.method}</span></td></tr>`;
}
function renderBoard(tbl, list) {
  const maxPt = Math.max(1, ...list.map(x => x.score));
  $(tbl).innerHTML = WEEK_HEAD + '<tbody>' + (list.length ? list.map(x => weekRow(x, maxPt)).join('')
    : '<tr><td class="loading" colspan="18">尚無資料（收錄池快照完成後即會出現）</td></tr>') + '</tbody>';
}
function elapsedHint(w, q) {
  const now = Date.now() / 1000;
  const pct = Math.min(100, Math.max(0, 100 * (now - w.start) / (w.end - w.start)));
  return `統計時段 ${dt(w.start)} → ${dt(w.end)}，已經過 <b>${pct.toFixed(1)}%</b>。
    前 ${q.top_n} 名中 <b>${q.exact}</b> 首使用精確資料（官方已公布／新曲／快照）${q.observed_share ? `，其增量平均已實際觀測 <b>${(q.observed_share * 100).toFixed(0)}%</b>` : ''}。`;
}

async function loadWeekly() {
  const d = await api('/api/predict/weekly');
  renderBoard('#tblWeekly', d.list);
  $('#weeklyTitle').innerHTML = `週榜 ♪${d.issue} 預測　第 1–${d.list.length} 名 <small>官方只公布前 20 名，第 21–40 名為本站延伸</small>`;
  $('#weeklyStats').innerHTML = [
    ['預測期數', '週榜 ♪' + d.issue, ''],
    ['符合收錄範圍', nf(d.pool_eligible), '首（官方收錄池內）'],
    ['實際計分', nf(d.scored), '首'],
    ['衰減模型 β', d.model.beta, '樣本 ' + nf(d.model.n)],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}<small>${s}</small></div></div>`).join('');
  $('#weeklyHint').innerHTML = elapsedHint(d.window, d.quality) +
    ` 得分 = 新增播放×時間修正 ＋ 新增收藏×15 ＋ 新增硬幣×30 ＋ 新增點讚×3（Biliboard 官方公式）。`;
  const ef = d.effects || [];
  $('#cardEffect').style.display = ef.length ? '' : 'none';
  if (ef.length) {
    $('#effectCount').textContent = `${ef.length} 首本期可能出現效應`;
    $('#tblEffect').innerHTML = `<thead><tr><th class="c-cv" style="width:92px">封面</th><th>曲名</th>
      <th class="hm" style="width:150px">歌姬 / 作曲家</th><th class="mid" style="width:100px">效應</th>
      <th class="mid hs" style="width:96px">本期預測</th><th class="num hm" style="width:100px">預測得分</th>
      <th class="hm">說明</th></tr></thead><tbody>` +
      ef.map(x => `<tr><td>${cover(x)}</td><td>${titleCell(x)}</td>
        <td class="hm">${tags(x.vocalists, 's')}${tags(x.producers, 'p')}</td>
        <td class="mid">${x.effect === false ? `<span class="muted">${esc(x.watch)}</span>`
          : `<span class="tag w3">${esc(x.watch)}</span>`}</td>
        <td class="mid hs">${x.rank <= 20 ? '#' + x.rank : '<span class="chg dn">' + x.rank + ' 名（榜外）</span>'}</td>
        <td class="num hm">${nf(x.score)}</td>
        <td class="muted hm">${esc(x.note || '')}${x.effect === false ? '　→ 預測續榜，不成立' : ''}</td></tr>`).join('') +
      '</tbody>';
  }
  if (d.excluded && d.excluded.length) {
    $('#cardExc').style.display = '';
    $('#excCount').textContent = `官方收錄池內共 ${d.excluded_count} 首近期曲目因不符本站收錄範圍被剔除（僅列前 ${d.excluded.length}）`;
    $('#tblExc').innerHTML = `<thead><tr><th class="c-cv" style="width:92px">封面</th><th>曲名</th><th class="hm" style="width:160px">歌姬 / 作曲家</th>
      <th class="num hm" style="width:100px">累計播放</th><th style="width:300px">剔除理由</th></tr></thead><tbody>` +
      d.excluded.map(x => `<tr><td>${cover(x)}</td><td>${titleCell(x)}</td><td class="hm">${tags(x.vocalists, 's')}${tags(x.producers, 'p')}</td>
        <td class="num hm">${nf(x.views)}</td><td>${(x.exclude_reasons || []).map(r => `<span class="tag">${esc(r)}</span>`).join('')}</td></tr>`).join('') + '</tbody>';
  } else $('#cardExc').style.display = 'none';
}

async function loadLegend() {
  const d = await api('/api/predict/legend');
  renderBoard('#tblLegend', d.list);
  $('#legendTitle').innerHTML = `傳說曲週榜 ♪${d.issue} 預測　第 1–${d.list.length} 名 <small>傳說曲池 ${nf(d.legend_pool)} 首</small>`;
  $('#legendHint').innerHTML = elapsedHint(d.window, d.quality) +
    ` 收錄對象為已達成傳說曲（播放 ≥ 100 萬）的曲目，計分方式與週榜相同。${esc(d.publish_note || '')}`;
}

/* ------------------------------------------------------------------ 半年 / 年榜 */
const PER_HEAD = `<thead><tr><th class="mid c-rk" style="width:54px">名次</th><th class="c-cv" style="width:92px">封面</th><th>曲名</th>
  <th class="hm" style="width:170px">歌姬 / 作曲家</th><th class="mid hm" style="width:62px">類別</th>
  <th class="num" style="width:120px">預測總得分</th><th class="num hm" style="width:110px">官方已公布</th>
  <th class="num hm" style="width:96px">缺漏週估算</th><th class="num hm" style="width:96px">本週預測</th>
  <th class="num hm" style="width:70px">上榜週數</th><th class="num hs" style="width:70px">最佳名次</th></tr></thead>`;
async function loadPeriod(kind) {
  const d = await api('/api/predict/period?kind=' + kind);
  const tbl = kind === 'half' ? '#tblHalf' : '#tblAnnual';
  $(kind === 'half' ? '#halfTitle' : '#annualTitle').innerHTML =
    `${esc(d.label)} 預測 TOP20 <small>${dt(d.period_start, 'd')} 起，累計至週榜 ♪${d.through_issue}（${dt(d.through, 'd')}）</small>`;
  $(kind === 'half' ? '#halfHint' : '#annualHint').innerHTML =
    `官方${kind === 'half' ? '半年榜' : '年榜'}以統計期間的總增量套用同一加權（不含時間修正）。本站以歷期週榜／傳說曲週榜公布的每週增量加總，
     未上榜週依前後週插值估算（上限為當週第 20 名得分），最後一週使用本站預測。` +
    (kind === 'annual' ? ' 上半年部分直接採用官方 2026 上半年榜數據。' : '');
  $(tbl).innerHTML = PER_HEAD + '<tbody>' + d.list.map(x => `<tr>
    <td class="mid">${rk(x.rank)}</td><td>${cover(x)}</td><td>${titleCell(x)}</td>
    <td class="hm">${tags(x.vocalists, 's')}${tags(x.producers, 'p')}</td><td class="mid hm">${catTag(x.category)}</td>
    <td class="num"><b>${nf(x.total)}</b></td><td class="num hm">${nf(x.known)}</td>
    <td class="num hm">${nf(x.imputed)}</td><td class="num hm">${nf(x.predicted)}</td>
    <td class="num hm">${x.weeks}</td><td class="num hs">${x.best_rank ?? '—'}</td></tr>`).join('') + '</tbody>';
}

/* ------------------------------------------------------------------ 歷史 */
const BOARD_NAME = { 1: '週榜', 2: '傳說曲週榜', 3: '半年榜／年榜' };
async function loadIssues() {
  state.issues = await api('/api/issues?board=' + state.board);
  renderIssueList('');
  if (state.issues.length) openIssue(state.issues[0].issue_id);
}
function renderIssueList(kw) {
  const list = state.issues.filter(i => !kw || String(i.issue_id).includes(kw) || (i.champion || '').includes(kw));
  $('#issueList').innerHTML = list.map(i => `<div class="it${i.issue_id === state.curIssue ? ' on' : ''}" data-n="${i.issue_id}">
      ♪${i.issue_id}　<span class="muted">${dt(i.end_date, 'd')} 截止</span><small>${esc(i.champion || '')}</small></div>`).join('')
    || '<div class="it muted">查無符合的期數</div>';
}
async function openIssue(n) {
  state.curIssue = n;
  renderIssueList($('#issueSearch').value.trim());
  const d = await api(`/api/issue/${state.board}/${n}`);
  const m = d.meta;
  $('#issueTitle').innerHTML = `${BOARD_NAME[state.board]} ♪${n}
    <small>統計 ${dt(m.start_date, 'd')} → ${dt(m.end_date, 'd')}　·　${m.video_count} 首
    ${m.video_bvid ? `　·　<a href="${bili(m.video_bvid)}" target="_blank" rel="noopener">官方影片</a>` : ''}</small>`;
  $('#tblIssue').innerHTML = `<thead><tr><th class="mid c-rk" style="width:54px">名次</th><th class="c-cv" style="width:92px">封面</th><th>曲名</th>
    <th class="hm" style="width:170px">歌姬 / 作曲家</th><th class="mid hm" style="width:88px">上期</th><th class="num" style="width:110px">官方得分</th>
    <th class="num hm" style="width:74px" title="rate：官方公布的得分與上期相比的增減">rate</th>
    <th class="num hm" style="width:96px">新增播放</th><th class="num hm" style="width:80px">收藏</th><th class="num hm" style="width:80px">硬幣</th>
    <th class="num hm" style="width:80px">點讚</th><th class="num hm" style="width:62px">在榜</th><th class="num hm" style="width:62px">最高</th>
    <th class="hm" style="width:110px" title="連續在榜第幾週；正好連續三週後掉榜即「三周效應」（又稱棉花糖效應）">連續</th>
    <th class="hs" style="width:150px">效應</th></tr></thead><tbody>` +
    d.entries.map(e => `<tr><td class="mid">${rk(e.rank)}</td><td>${cover(e)}</td><td>${titleCell(e)}</td>
      <td class="hm">${tags(e.vocalists, 's')}${tags(e.producers, 'p')}</td><td class="mid hm">${state.board === 3 ? '—' : chg(offChg(e))}</td>
      <td class="num"><b>${nf(e.score)}</b></td><td class="num hm">${offRate(e.score_ratio)}</td>
      <td class="num hm">${nf(e.views)}</td><td class="num hm">${nf(e.favorites)}</td>
      <td class="num hm">${nf(e.coins)}</td><td class="num hm">${nf(e.likes)}</td><td class="num hm">${e.weeks_on_board ?? '—'}</td><td class="num hm">${e.peak_rank ?? '—'}</td>
      <td class="hm">${e.run ? (e.run.effect ? `<span class="tag w3">${esc(e.run.effect)}</span>`
        : `<span class="muted">第 ${e.run.week} / ${e.run.weeks} 週</span>`) : '—'}</td>
      <td class="hs">${(e.effects || []).map(x => `<span class="tag w3">${esc(x)}</span>`).join('')
        || (e.special_status ? `<span class="tag">${esc(e.special_status)}</span>` : '')}</td></tr>`).join('')
    + subRows(d.sub) + '</tbody>';
}
/* 官方副榜（第 21–40 名）：官方影片與網站只給前 20 名，21 名以後出自該期專欄文末的
   「部分数据」表格圖片，本站轉錄後存起來。 */
function subRows(sub) {
  if (!sub || !sub.length) return '';
  return `<tr class="subhead"><td colspan="15">官方副榜　第 ${sub[0].rank}–${sub[sub.length - 1].rank} 名
    <span class="muted">（出自該期 B 站專欄的「部分数据」表，官方影片未公布）</span></td></tr>`
    + sub.map(e => `<tr class="subrow"><td class="mid">${rk(e.rank)}</td><td>${cover(e)}</td><td>${titleCell(e)}</td>
      <td class="hm">${esc(e.vocalists || '')}${e.producer ? `<span class="muted"> / ${esc(e.producer)}</span>` : ''}</td>
      <td class="mid hm">${!e.prev_known ? '<span class="muted" title="本站沒有上一期的副榜資料，無法判斷">—</span>'
        : chg(e.prev_rank
          ? { kind: e.prev_rank === e.rank ? 'same' : (e.prev_rank > e.rank ? 'up' : 'down'),
              prev: e.prev_rank, diff: e.prev_rank - e.rank }
          : { kind: (e.weeks_on_board || 0) > 1 ? 're' : 'new' })}</td>
      <td class="num"><b>${nf(e.score)}</b></td><td class="num hm">${offRate(e.score_ratio)}</td>
      <td class="num hm">${nf(e.views)}</td><td class="num hm">${nf(e.favorites)}</td>
      <td class="num hm">${nf(e.coins)}</td><td class="num hm">${nf(e.likes)}</td>
      <td class="num hm">${e.weeks_on_board ?? '—'}</td><td class="num hm">${e.peak_rank ?? '—'}</td><td class="hm">—</td>
      <td class="hs">${(e.effects || []).map(x => `<span class="tag w3">${esc(x)}</span>`).join('')}</td></tr>`).join('');
}

/* ------------------------------------------------------------------ 收錄曲庫 */
async function loadFacets() {
  const f = await api('/api/facets');
  $('#fVocalist').innerHTML = '<option value="">全部</option>' + f.vocalists.map(([k, v]) => `<option value="${esc(k)}">${esc(k)}（${v}）</option>`).join('');
  $('#producerList').innerHTML = f.producers.map(([k, v]) => `<option value="${esc(k)}">${v} 首</option>`).join('');
  $('#fLanguage').innerHTML = '<option value="">全部</option>' + f.languages.filter(x => x.k).map(x => `<option>${esc(x.k)}</option>`).join('');
}
function libParams(page) {
  return new URLSearchParams({
    q: $('#fq').value.trim(), vocalist: $('#fVocalist').value, producer: $('#fProducer').value.trim(),
    category: $('#fCategory').value, language: $('#fLanguage').value, date_from: $('#fFrom').value,
    date_to: $('#fTo').value, scope: $('#fScope').value, sort: $('#fSort').value, page, size: $('#fSize').value
  }).toString();
}
async function loadLib(page) {
  state.lib.page = page || 1;
  $('#tblLib').innerHTML = '<tbody><tr><td class="loading"><span class="spin"></span>載入中…</td></tr></tbody>';
  const d = await api('/api/songs?' + libParams(state.lib.page));
  $('#libCount').textContent = `共 ${nf(d.total)} 首　第 ${d.page} / ${d.pages || 1} 頁`;
  $('#tblLib').innerHTML = `<thead><tr><th style="width:92px">封面</th><th>曲名</th><th style="width:170px">歌姬 / 作曲家</th>
    <th class="mid" style="width:62px">類別</th><th style="width:80px">語種</th><th style="width:104px">發布日期</th>
    <th class="num" style="width:100px">累計播放</th><th class="num" style="width:80px">收藏</th>
    <th class="num" style="width:64px">最佳</th><th class="num" style="width:64px">在榜</th><th style="width:170px">狀態</th></tr></thead><tbody>` +
    (d.list.length ? d.list.map(x => `<tr><td>${cover(x)}</td><td>${titleCell(x)}</td>
      <td>${tags(x.vocalists, 's')}${tags(x.producers, 'p')}</td><td class="mid">${catTag(x.category)}</td>
      <td>${esc(x.language || '—')}</td><td>${dt(x.pubtime, 'd')}</td><td class="num">${nf(x.views)}</td>
      <td class="num">${nf(x.favorites)}</td><td class="num">${x.best_rank ?? '—'}</td><td class="num">${x.weeks_on || 0}</td>
      <td>${x.eligible ? (x.is_legend ? '<span class="tag m">傳說曲</span>' : '<span class="tag e">收錄中</span>')
        : (x.exclude_reasons || []).map(r => `<span class="tag">${esc(r)}</span>`).join('')}</td></tr>`).join('')
      : '<tr><td class="loading">查無符合條件的曲目</td></tr>') + '</tbody>';
  const pg = [];
  if (d.page > 1) pg.push(`<button data-pg="${d.page - 1}">← 上一頁</button>`);
  pg.push(`<span>第 ${d.page} / ${d.pages || 1} 頁</span>`);
  if (d.page < d.pages) pg.push(`<button data-pg="${d.page + 1}">下一頁 →</button>`);
  $('#libPager').innerHTML = pg.join('');
}

/* ------------------------------------------------------------------ 資料頁 */
function renderData(s) {
  const b = Object.fromEntries((s.boards || []).map(x => [x.board_id, x]));
  const p = s.pool || {};
  $('#dataStats').innerHTML = [
    ['週榜', `♪${b[1]?.lo}–♪${b[1]?.hi}`, `${b[1]?.n || 0} 期`],
    ['傳說曲週榜', `♪${b[2]?.lo}–♪${b[2]?.hi}`, `${b[2]?.n || 0} 期`],
    ['半年榜／年榜', `${b[3]?.n || 0} 期`, ''],
    ['榜單紀錄', nf(s.entries), '筆'],
    ['官方收錄池', nf(p.n), `符合本站範圍 ${nf(p.eligible)}`],
    ['即時快照', nf(s.snapshots.n), s.snapshots.t ? dt(s.snapshots.t) : '尚未抓取'],
  ].map(([k, v, x]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}<small>${x}</small></div></div>`).join('');
  $('#fileList').innerHTML = s.exports.length ? s.exports.map(f => `<a class="file" href="/download/${encodeURIComponent(f.name)}">
      <div class="ico">📊</div><div><div class="n">${esc(f.name)}</div><div class="m">${(f.size / 1024).toFixed(0)} KB　·　${dt(f.mtime)}</div></div></a>`).join('')
    : '<div class="muted">尚未產生，點右上角「重新產生 Excel」。</div>';
  $('#ruleBox').innerHTML = `
    <p><b>得分</b>（Biliboard 官方公式）</p>
    <pre class="log">得分     = 播放基數 + 新增收藏 × 15 + 新增硬幣 × 30 + 新增點讚 × 3
播放基數 = 新增播放 × 時間修正
時間修正 = 1                                   （Δt &lt; 0）
         = log10( e^(Δt/86400) / 14 + 1 ) + 1  （Δt ≥ 0）
Δt       = 投稿時間 − 前一期統計截止時間（秒）
統計週期 = 上週二 00:00 至本週二 00:00（UTC+8）</pre>
    <p class="muted">以官方歷史資料重算驗證：權重自 ♪54 起 848/849 筆舊曲完全一致；時間修正自 ♪100 起新曲 91/107 筆完全一致（其餘為官方換 BV 造成的投稿時間異常）。</p>
    <p><b>收錄範圍</b>：① 必須在 Biliboard 官方收錄公示池內（已提名的 BV）；② 只收原創（含搬運）與二創；
       ③ 必須由虛擬歌姬（音聲合成引擎）演唱，真人翻唱、純伴奏／演奏一律剔除；④ 稿件失效者剔除。
       依官方規則，舊曲在統計期間內才被提名者，下週起才參與排名。</p>
    <p><b>傳說曲週榜</b>：已達成傳說曲（播放 ≥ 100 萬）的曲目，計分同週榜。<b>半年榜／年榜</b>：統計期間總增量，同一加權、不含時間修正。</p>`;
}
async function loadMethod() {
  $('#methodBox').innerHTML = '<span class="spin"></span> 回測中…';
  let bt = null; try { bt = await api('/api/backtest'); } catch (e) { }
  const m = (state.status && state.status.decay_model) || {};
  $('#methodBox').innerHTML = `
    <p>每首曲依可取得的資料擇優估計本時段增量：<span class="meth snapshot">官方已公布</span> 已截止時段直接用官方數據、
      <span class="meth newsong">新曲·精確</span> 本時段投稿（累計數即增量）、<span class="meth snapshot">快照·精確</span> 本站在時段起點留有快照、
      <span class="meth baseline">即時增速</span> 本站兩次快照的增速換算整週、<span class="meth carryover">上期推估</span> 上一期官方增量 × 衰減模型。</p>
    <p>成長衰減模型：瞬時增速 ∝ (曲齡 + 0.5 天)<sup>−β</sup>，由官方連續兩週在榜曲目的實際增量比擬合，β = <b>${m.beta ?? '—'}</b>（樣本 ${nf(m.n)}，對數殘差 ${m.rmse ?? '—'}）。</p>
    ${bt ? `<p><b>回測（最近 ${bt.issues} 期，只用最保守的上期推估）</b>：名次平均誤差 <b>${bt.rank_mae}</b>、前 10 名命中率 <b>${(bt.top10_hit_rate * 100).toFixed(0)}%</b>、
      覆蓋率 ${(bt.coverage * 100).toFixed(0)}%（每期平均 ${(bt.new_share * 100).toFixed(0)}% 的上榜曲是上期不在榜的曲目，此方法看不到）。</p>
      <p class="muted">${esc(bt.note)}</p>` : ''}`;
}
async function loadLog() {
  try { const d = await api('/api/log'); $('#logBox').textContent = (d.log || []).join('\n') || '—'; } catch (e) { }
}

/* ------------------------------------------------------------------ 分頁 */
const LOADERS = {
  weekly: loadWeekly, legend: loadLegend, half: () => loadPeriod('half'), annual: () => loadPeriod('annual'),
  milestones: loadMilestones, accuracy: loadAccuracy,
  history: loadIssues, library: async () => { await loadFacets(); await loadLib(1); },
  data: async () => { renderData(state.status || await api('/api/status')); await loadMethod(); await loadLog(); },
};
async function show(p, force) {
  state.panel = p;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  $$('.panel').forEach(s => s.classList.toggle('on', s.id === 'p-' + p));
  if (!state.loaded[p] || force) {
    try { await LOADERS[p](); state.loaded[p] = true; }
    catch (e) { $('#p-' + p).insertAdjacentHTML('afterbegin', `<div class="hint err">載入失敗：${esc(e.message)}</div>`); }
  }
}
async function pollRunning() {
  await loadStatus(); await loadLog();
  if (state.status && state.status.running) return setTimeout(pollRunning, 3000);
  state.loaded = {}; show(state.panel, true);
}

on('#nav', 'click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.p); });
on('#tblAcc', 'click', e => { const b = e.target.closest('[data-acc]'); if (b) accDetail(+b.dataset.acc); });
on('#msHorizon', 'change', () => loadMilestones());
on('#histBoard', 'change', e => { state.board = +e.target.value; state.curIssue = null; loadIssues(); });
on('#issueList', 'click', e => { const d = e.target.closest('.it'); if (d && d.dataset.n) openIssue(+d.dataset.n); });
on('#issueSearch', 'input', e => renderIssueList(e.target.value.trim()));
on('#btnSearch', 'click', () => loadLib(1));
['#fq', '#fProducer'].forEach(s => on(s, 'keydown', e => { if (e.key === 'Enter') loadLib(1); }));
$$('#fVocalist,#fCategory,#fLanguage,#fScope,#fSort,#fSize').forEach(el => el.addEventListener('change', () => loadLib(1)));
on('#btnReset', 'click', () => {
  ['fq', 'fProducer', 'fFrom', 'fTo', 'fVocalist', 'fCategory', 'fLanguage'].forEach(i => {
    const el = $('#' + i); if (el) el.value = '';
  });
  $('#fScope').value = 'eligible'; $('#fSort').value = 'views'; loadLib(1);
});
on('#libPager', 'click', e => { const b = e.target.closest('button'); if (b) loadLib(+b.dataset.pg); });
on('#btnExc', 'click', () => { const w = $('#excWrap'); w.style.display = w.style.display === 'none' ? '' : 'none'; });
on('#btnRefresh', 'click', async () => { $('#btnRefresh').disabled = true; await api('/api/refresh', { method: 'POST' }); pollRunning(); });
on('#btnExport', 'click', async () => { $('#btnExport').disabled = true; await api('/api/export', { method: 'POST' }); pollRunning(); });

/* ------------------------------------------------------------------ 預測準確度 */
async function loadAccuracy() {
  const [d, bt] = await Promise.all([api('/api/accuracy'), api('/api/backtest').catch(() => null)]);
  const ev = d.evaluated || [], pend = d.pending || [], s1 = (d.summary || {})['1'];
  const tile = (k, v, x) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}<small>${x || ''}</small></div></div>`;
  $('#accStats').innerHTML = [
    tile('已驗證期數', ev.length, '期'),
    tile('週榜前 20 名命中', s1 ? s1.hits.toFixed(1) : '—', s1 ? '/ 20（平均）' : '尚無實測'),
    tile('週榜名次平均誤差', s1 && s1.rank_mae !== null ? s1.rank_mae.toFixed(2) : '—', s1 ? '名' : ''),
    tile('冠軍命中率', s1 ? Math.round(s1.champion_rate * 100) + '%' : '—', s1 ? s1.issues + ' 期' : ''),
  ].join('');
  $('#accHint').innerHTML = [
    ...pend.map(p => `<b>${BOARD_NAME[p.board_id]} ♪${p.issue_id}</b>：已記錄截止前預測（最後更新 ${dt(p.generated_at)}，${dt(p.window_end)} 截止），官方發布後自動驗證。`),
    '本站在每期統計時段截止前持續覆寫預測紀錄，截止後就不再更動，所以驗證的是「截止前最後一次預測」；官方公布後自動與前 20 名比對。',
  ].join('<br>');
  const wk = ev.filter(e => e.board_id === 1).slice().sort((a, b) => a.issue_id - b.issue_id);
  $('#accChartCard').hidden = wk.length < 2;
  if (wk.length >= 2) lineChart($('#accChart'), {
    series: [{ name: '前 20 名命中數', color: '--s1', points: wk.map(e => ({ x: e.issue_id, y: e.hits })) }],
    yMin: 0, yMax: 20, yTicks: [0, 5, 10, 15, 20], dots: true, height: 180,
    xFmt: x => '♪' + x, xFmtTip: x => '週榜 ♪' + x, yFmt: v => String(v), title: '週榜前 20 名命中數' });
  $('#tblAcc').innerHTML = `<thead><tr><th style="width:110px">榜別</th><th class="mid" style="width:64px">期數</th>
    <th class="hm" style="width:140px">截止前預測時間</th><th class="num" style="width:96px">前 20 名命中</th><th class="num hm" style="width:96px">前 10 名命中</th>
    <th class="num hm" style="width:100px">名次完全正確</th><th class="num hm" style="width:100px">名次平均誤差</th>
    <th class="num hm" style="width:120px" title="|預測得分 ÷ 官方得分 − 1| 的中位數">得分誤差中位數</th>
    <th class="num hm" style="width:110px" title="拿官方副榜（第 21–40 名）一起比對；只有已轉錄副榜的期數才有">前 40 名命中</th>
    <th class="mid hs" style="width:80px">冠軍</th><th style="width:70px"></th></tr></thead><tbody>` +
    (ev.length ? ev.map((e, i) => `<tr><td>${BOARD_NAME[e.board_id]}</td><td class="mid">♪${e.issue_id}</td><td class="muted hm">${dt(e.generated_at)}</td>
      <td class="num"><b>${e.hits}</b> / ${e.published}</td><td class="num hm">${e.hits10} / 10</td><td class="num hm">${e.exact}</td>
      <td class="num hm">${e.rank_mae ?? '—'}</td><td class="num hm">${e.score_err_median !== null ? (e.score_err_median * 100).toFixed(1) + '%' : '—'}</td>
      <td class="num hm">${e.wide ? `${e.wide.hits} / ${e.wide.published}<small class="muted"> 誤差 ${e.wide.rank_mae}</small>` : '<span class="muted">—</span>'}</td>
      <td class="mid hs">${e.champion ? '<span class="chg up">命中</span>' : '<span class="chg dn">未中</span>'}</td>
      <td><button data-acc="${i}">明細</button></td></tr>`).join('')
      : `<tr><td class="loading" colspan="11">尚無可驗證的期數${pend.length ? `（♪${pend[0].issue_id} 發布後出現第一筆）` : ''}</td></tr>`) + '</tbody>';
  state.acc = ev;
  if (ev.length) accDetail(0);
  else { $('#accDetailTitle').textContent = '明細'; $('#tblAccDetail').innerHTML = ''; }
  const cal = Object.entries(d.calibration || {});
  $('#tblCal').innerHTML = `<thead><tr><th style="width:160px">估計法</th><th class="num" style="width:90px">樣本</th>
    <th class="num hm" style="width:150px">官方 ÷ 預測（原始）</th><th class="num" style="width:110px">套用倍率</th><th class="hm">狀態</th></tr></thead><tbody>` +
    (cal.length ? cal.map(([m, c]) => `<tr><td><span class="meth ${methCls(m)}">${METH[m] || esc(m)}</span></td><td class="num">${c.n}</td>
      <td class="num hm">×${c.raw}</td><td class="num"><b>×${c.factor}</b></td>
      <td class="hm">${c.active ? '<span class="tag e">校正中</span>' : `<span class="muted">樣本不足（需 ${d.cal_min_n} 筆）</span>`}</td></tr>`).join('')
      : `<tr><td class="loading" colspan="5">目前模型版本（${esc(d.model_ver || '')}）還沒有實測樣本，暫不校正。
          校正係數只採用同一版模型的誤差 —— 模型修掉某個偏差之後，再套用舊版擬出來的係數會反向過度修正。
          每個估計法累積 ${d.cal_min_n} 筆後開始校正。${(d.evaluated_vers || []).length ?
          `（已驗證的期數屬於 ${d.evaluated_vers.map(esc).join('、')}）` : ''}</td></tr>`) + '</tbody>';
  $('#accBaseline').innerHTML = bt ? `只用「上期官方增量 × 衰減模型」推估（不含即時快照與新曲資料）回測最近 ${bt.issues} 期：
    名次平均誤差 <b>${bt.rank_mae}</b>、前 10 名命中率 <b>${(bt.top10_hit_rate * 100).toFixed(0)}%</b>。
    這是最保守方法的表現，本站實際預測的準確度以上方實測為準。` : '回測資料載入失敗。';
}
function accDetail(i) {
  const e = (state.acc || [])[i];
  if (!e) return;
  $('#accDetailTitle').innerHTML = `${BOARD_NAME[e.board_id]} ♪${e.issue_id} 明細 <small>預測時間 ${dt(e.generated_at)}　·　官方前 ${e.published} 名 vs 本站預測</small>`;
  const meth = m => m ? `<span class="meth ${methCls(m)}">${METH[m] || esc(m)}</span>` : '—';
  $('#tblAccDetail').innerHTML = `<thead><tr><th class="mid" style="width:70px">官方名次</th><th>曲名</th>
    <th class="mid" style="width:84px">本站預測</th><th class="mid hs" style="width:90px">名次差</th>
    <th class="num hm" style="width:110px">官方得分</th><th class="num hm" style="width:110px">預測得分</th>
    <th class="num hm" style="width:96px" title="預測 ÷ 官方 − 1；正值為高估">得分誤差</th><th class="mid hm" style="width:120px">估計法</th></tr></thead><tbody>` +
    e.detail.map(x => {
      const dd = x.pred_rank ? x.pred_rank - x.official_rank : null;
      return `<tr><td class="mid">${rk(x.official_rank)}</td><td>${titleCell(x)}</td>
        <td class="mid">${x.pred_rank ? '#' + x.pred_rank : '<span class="chg dn">40 名外</span>'}</td>
        <td class="mid hs">${dd === null ? '—' : dd === 0 ? '<span class="chg up">完全正確</span>' : (dd > 0 ? '+' : '') + dd}</td>
        <td class="num hm"><b>${nf(x.official_score)}</b></td><td class="num hm">${nf(x.pred_score)}</td>
        <td class="num hm">${x.score_err === undefined ? '—' : (x.score_err >= 0 ? '+' : '') + (x.score_err * 100).toFixed(1) + '%'}</td>
        <td class="mid hm">${meth(x.method)}</td></tr>`;
    }).join('') +
    (e.false_positives.length ? `<tr><td colspan="8" class="muted" style="padding-top:14px">預測進前 ${e.published} 名、但官方未上榜：</td></tr>` +
      e.false_positives.map(f => `<tr><td class="mid muted">${f.sub_rank ? '副 ' + f.sub_rank : '—'}</td><td>${titleCell(f)}</td>
        <td class="mid">#${f.pred_rank}</td><td class="mid hs">${f.sub_rank ? (f.pred_rank - f.sub_rank > 0 ? '+' : '') + (f.pred_rank - f.sub_rank) : '—'}</td>
        <td class="num hm${f.sub_score ? '' : ' muted'}" title="${f.sub_score ? '官方副榜公布的得分' : '官方未公布，只知道低於第 ' + e.published + ' 名'}">${f.sub_score ? nf(f.sub_score) : '&lt; ' + nf(f.official_below)}</td>
        <td class="num hm">${nf(f.pred_score)}</td>
        <td class="num hm">${f.sub_score ? ((f.pred_score / f.sub_score - 1) * 100).toFixed(1) + '%' : '—'}</td>
        <td class="mid hm">${meth(f.method)}</td></tr>`).join('') : '') +
    '</tbody>';
}

/* ------------------------------------------------------------------ 達成預測 */
function msText(x) {
  if (x.achieved_at) return `已於 ${dt(x.achieved_at)} 達成${x.label}`;
  return `預計 ${dt(x.eta, 'd')} 達成${x.label}（還差 ${nf(x.remain)}）`;
}
function msRow(x, done) {
  const pct = Math.min(100, x.progress * 100), days = x.eta ? (x.eta - Date.now() / 1000) / 86400 : null;
  return `<tr><td>${cover(x)}</td><td>${titleCell(x)}</td><td class="hm">${tags(x.vocalists, 's')}${tags(x.producers, 'p')}</td>
    <td class="hs"><div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div><small class="muted">${nf(x.views)} / ${compact(x.threshold)}　${pct.toFixed(1)}%</small></td>
    <td class="num hm">${done ? '—' : nf(x.remain)}</td><td class="num hm">${x.rate_day ? '+' + nf(x.rate_day) : '—'}</td>
    <td>${done ? `<span class="tag e">已達成</span> <span class="muted">${dt(x.achieved_at)}</span>`
      : `<b>${dt(x.eta, 'd')}</b> <span class="muted">${days < 1 ? '1 天內' : '約 ' + Math.round(days) + ' 天'}</span>${x.in_window ? ' <span class="tag m">本期內</span>' : ''}`}</td>
    <td class="mid muted hm">${esc(x.method || '—')}</td></tr>`;
}
async function loadMilestones() {
  const d = await api('/api/milestones?horizon=' + ($('#msHorizon').value || 60));
  $('#msHint').innerHTML = `依本站快照測得的日增（取相隔整數天的兩筆快照，抵銷日夜流量差），套用與週榜預測相同的成長衰減模型，
    推算累計播放抵達門檻的日期；只列 ${d.horizon_days} 天內預計達成者，每個門檻最多顯示 50 首。
    標 <span class="tag m">本期內</span> 表示預計在本期統計時段（${dt(d.window.end)} 截止）前達成。`;
  $('#msBody').innerHTML = d.boards.map(b => `<div class="card"><h2>${esc(b.label)} <small>累計播放 ${compact(b.threshold)}　·　${d.horizon_days} 天內預計 ${b.upcoming.length} 首達成${b.achieved.length ? `、近期已達成 ${b.achieved.length} 首` : ''}</small></h2>
    <div class="tw"><table><thead><tr><th class="c-cv" style="width:92px">封面</th><th>曲名</th><th class="hm" style="width:170px">歌姬 / 作曲家</th>
      <th class="hs" style="width:210px">進度</th><th class="num hm" style="width:100px">還差</th><th class="num hm" style="width:96px">目前日增</th>
      <th style="width:170px">預計達成</th><th class="mid hm" style="width:100px">估計法</th></tr></thead><tbody>` +
    (b.achieved.map(x => msRow(x, true)).join('') + b.upcoming.slice(0, 50).map(x => msRow(x)).join('')
      || `<tr><td class="loading" colspan="8">${d.horizon_days} 天內沒有預計達成的曲目</td></tr>`) + '</tbody></table></div></div>').join('');
}

/* ------------------------------------------------------------------ 單曲走勢圖 */
function mountSongCharts(s) {
  const h = s.history || [];
  const elR = $('#chRank');
  if (elR) {
    const lab = {};
    h.forEach(x => { lab[x.end_date] = `♪${x.issue_id}　${dt(x.end_date, 'd')}`; });
    const ends = [...new Set(h.filter(x => x.board_id !== 3).map(x => x.end_date))].sort((a, b) => a - b);
    const full = [];
    if (ends.length) for (let t = ends[0]; t <= ends[ends.length - 1]; t += 7 * 86400) full.push(t);
    const series = [[1, '週榜', '--s1'], [2, '傳說曲週榜', '--s2']].map(([b, name, color]) => {
      const mp = new Map(h.filter(x => x.board_id === b).map(x => [x.end_date, x.rank]));
      return { name, color, points: full.map(t => ({ x: t, y: mp.has(t) ? mp.get(t) : null })) };
    }).filter(se => se.points.some(p => p.y));
    lineChart(elR, { series, yInvert: true, yMin: 1, yMax: 20, yTicks: [1, 5, 10, 15, 20], height: 200, dots: full.length <= 40,
      xFmt: t => dt(t, 'd').slice(5), xFmtTip: t => lab[t] || dt(t, 'd') + '（未上榜）', yFmt: v => '#' + v, title: '名次走勢' });
  }
  const elS = $('#chScore');
  if (elS) {
    const wk = h.filter(x => x.board_id === 1), src = wk.length ? wk : h.filter(x => x.board_id === 2);
    columnChart(elS, { points: src.map(x => ({ x: '♪' + x.issue_id, y: x.score || 0, d: x })), color: '--s1',
      name: (wk.length ? '週榜' : '傳說曲週榜') + '官方得分', yFmt: compact,
      tipHead: p => `${p.x}　${dt(p.d.end_date, 'd')}　第 ${p.d.rank} 名`, title: '每期官方得分' });
  }
  const elV = $('#chViews');
  if (elV) {
    const ms = s.milestone, refs = ms && !ms.achieved_at ? [{ y: ms.threshold, label: ms.label + ' ' + compact(ms.threshold) }] : [];
    lineChart(elV, { series: [{ name: '累計播放', color: '--s1', points: s.series.map(p => ({ x: p.ts, y: p.views })) }],
      area: true, height: 190, xFmt: t => dt(t).slice(5), xFmtTip: t => dt(t), yFmt: compact, yFmtTip: nf,
      refLines: refs, refReach: 1.15, title: '累計播放走勢' });
  }
}

/* ------------------------------------------------------------------ 單曲在榜紀錄（官方歷史紀錄） */
/* 官方歷史紀錄裡的 rate 字串（"+216.6%" / "-53.9%" / "--%" / "-"） */
function offRate(t) {
  if (!t || t === '-' || t === '--%') return `<span class="muted">${esc(t || '—')}</span>`;
  return `<span class="chg ${t.startsWith('-') ? 'dn' : 'up'}">${esc(t)}</span>`;
}
function songHtml(s) {
  const main = s.title_cn || s.title || s.video_title || s.bvid;
  const sub = [s.title && s.title !== main ? s.title : '', s.owner_name ? 'UP：' + s.owner_name : '',
    s.pubtime ? dt(s.pubtime) : ''].filter(Boolean).map(esc).join('　·　');
  const st = (k, v, x) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}<small>${x || ''}</small></div></div>`;
  const h = s.history || [];
  const histRows = h.map(x => `<tr>
    <td>${BOARD_NAME[x.board_id] || x.board_id}</td><td class="mid">♪${x.issue_id}</td>
    <td class="muted hm">${dt(x.end_date, 'd')}</td><td class="mid">${rk(x.rank)}</td>
    <td class="mid hs">${chg(offChg(x))}</td><td class="num"><b>${nf(x.score)}</b></td>
    <td class="num hm">${offRate(x.score_ratio)}</td><td class="num hm">${nf(x.views)}</td>
    <td class="num hm">${nf(x.favorites)}</td><td class="num hm">${nf(x.coins)}</td><td class="num hm">${nf(x.likes)}</td>
    <td class="num hm">${x.time_correction && x.board_id !== 3 ? x.time_correction.toFixed(2) : '—'}</td>
    <td class="hm">${x.special_status ? `<span class="tag" title="官方特殊狀態">${esc(x.special_status)}</span>` : ''}${
      x.bvid !== s.bvid ? `<span class="tag" title="該期以此 BV 計分">${esc(x.bvid)}</span>` : ''}</td></tr>`).join('');
  const vs = (s.versions || []).slice().sort((a, b) => (b.views || 0) - (a.views || 0));
  const vers = vs.length > 1 ? `<div class="card"><h2>同一首歌的版本
      <small>Biliboard 每首歌只用一個 BV 計分：本家優先，否則播放最高</small></h2>
    <div class="tw"><table><thead><tr><th class="hm" style="width:120px">BV號</th><th>影片標題</th><th class="hs" style="width:130px">UP主</th>
      <th class="num" style="width:100px">累計播放</th><th class="mid" style="width:90px">計分採用</th></tr></thead><tbody>` +
    vs.map(v => `<tr><td class="hm"><a href="${bili(v.bvid)}" target="_blank" rel="noopener">${esc(v.bvid)}</a></td>
      <td>${esc(v.video_title || '—')}</td><td class="hs">${esc(v.owner_name || '—')}</td><td class="num">${nf(v.views)}</td>
      <td class="mid">${v.canonical ? '<span class="tag e">計分中</span>' : '<span class="muted">—</span>'}</td></tr>`).join('') +
    '</tbody></table></div></div>' : '';
  const sn = (s.snapshots || []).slice(0, 9);
  const snapRows = sn.map((x, i) => {
    const p = sn[i + 1];
    return `<tr><td>${dt(x.ts)}</td><td class="num">${nf(x.views)}</td>
      <td class="num muted">${p ? '+' + nf(x.views - p.views) : '—'}</td>
      <td class="num hm">${nf(x.favorites)}</td><td class="num hm">${nf(x.coins)}</td><td class="num hm">${nf(x.likes)}</td></tr>`;
  }).join('');
  return `<div class="shead">${cover(s)}
      <div><h2 style="margin:0">${esc(main)}</h2><div class="muted">${sub}</div>
        <div style="margin-top:6px">${tags(s.vocalists, 's')}${tags(s.producers, 'p')}${catTag(s.category)}${
          s.language ? `<span class="tag">${esc(s.language)}</span>` : ''}${
          s.is_legend ? '<span class="tag m">傳說曲</span>' : ''}${
          s.eligible ? '<span class="tag e">符合收錄範圍</span>'
            : (s.exclude_reasons || []).map(r => `<span class="tag">${esc(r)}</span>`).join('')}</div>
        <div style="margin-top:6px"><a href="${bili(s.bvid)}" target="_blank" rel="noopener">在 bilibili 開啟 ${esc(s.bvid)}</a></div>
      </div></div>
    <div class="grid g4" style="margin:14px 0">
      ${st('累計播放', nf(s.views), s.stat_ts ? dt(s.stat_ts) : '')}
      ${st('週榜在榜', s.weeks_on || 0, '次　最高 ' + (s.best_rank ?? '—'))}
      ${st('傳說曲週榜', s.legend_weeks || 0, '次　最高 ' + (s.legend_best ?? '—'))}
      ${st('收藏 / 硬幣 / 點讚', nf(s.favorites) + ' / ' + nf(s.coins) + ' / ' + nf(s.likes), '')}
    </div>
    ${h.some(x => x.board_id !== 3) ? `<div class="card"><h2>名次走勢 <small>官方週榜與傳說曲週榜名次，上方為第 1 名；中斷處為當期未上榜</small></h2>
      <div class="body"><div class="vbox" id="chRank"></div></div></div>
    <div class="card"><h2>每期官方得分 <small>滑鼠移到柱上看數值</small></h2><div class="body"><div class="vbox" id="chScore"></div></div></div>` : ''}
    ${(s.series || []).length > 1 ? `<div class="card"><h2>累計播放走勢 <small>本站即時快照${s.milestone ? '　·　' + esc(msText(s.milestone)) : ''}</small></h2>
      <div class="body"><div class="vbox" id="chViews"></div></div></div>` : ''}
    ${(s.runs || []).length ? `<div class="card"><h2>連續在榜段 <small>正好連續三週後掉榜＝三周效應（又稱棉花糖效應）</small></h2>
      <div class="body">${s.runs.map(r => `<span class="runseg${r.effect ? ' w3' : ''}">${BOARD_NAME[r.board_id]}　♪${r.from}${r.weeks > 1 ? '–♪' + r.to : ''}　${r.weeks} 週${r.effect ? '　' + esc(r.effect) : (r.completed ? '' : '　進行中')}</span>`).join('')}</div></div>` : ''}
    <div class="card"><h2>在榜紀錄 <small>Biliboard 官方公布值，共 ${h.length} 筆</small></h2>
      <div class="tw"><table><thead><tr><th style="width:100px">榜別</th><th class="mid" style="width:60px">期數</th>
        <th class="hm" style="width:96px">截止日</th><th class="mid" style="width:54px">名次</th>
        <th class="mid hs" style="width:82px">名次變化</th><th class="num" style="width:110px">官方得分</th>
        <th class="num hm" style="width:74px">比上期</th><th class="num hm" style="width:96px">新增播放</th>
        <th class="num hm" style="width:80px">收藏</th><th class="num hm" style="width:80px">硬幣</th>
        <th class="num hm" style="width:80px">點讚</th><th class="num hm" style="width:64px">時間修正</th>
        <th class="hm" style="width:150px">備註</th></tr></thead>
        <tbody>${histRows || '<tr><td class="loading" colspan="13">尚未上過榜</td></tr>'}</tbody></table></div></div>
    ${vers}
    ${sn.length ? `<div class="card"><h2>本站即時快照 <small>最近 ${sn.length} 筆</small></h2>
      <div class="tw"><table><thead><tr><th style="width:130px">時間</th><th class="num" style="width:110px">累計播放</th>
        <th class="num" style="width:96px">較前次</th><th class="num hm" style="width:90px">收藏</th>
        <th class="num hm" style="width:90px">硬幣</th><th class="num hm" style="width:90px">點讚</th></tr></thead>
        <tbody>${snapRows}</tbody></table></div></div>` : ''}`;
}
async function openSong(bv) {
  $('#songModal').hidden = false;
  $('#songBody').innerHTML = '<div class="loading"><span class="spin"></span> 載入中…</div>';
  try { const s = await api('/api/song/' + bv); $('#songBody').innerHTML = songHtml(s); mountSongCharts(s); }
  catch (e) { $('#songBody').innerHTML = `<div class="hint err">載入失敗：${esc(e.message)}</div>`; }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-song]');
  if (b) { e.preventDefault(); return openSong(b.dataset.song); }
  if (e.target.closest('[data-close]')) $('#songModal').hidden = true;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#songModal').hidden = true; });

loadStatus();
show('weekly');
setInterval(loadStatus, 30000);
setInterval(() => { if (state.panel === 'data') loadLog(); }, 10000);
