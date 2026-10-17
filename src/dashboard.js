/**
 * 共读看板 · 自包含 HTML 生成器
 *
 * 与原版 weread_dashboard.py 的产物（demo-dashboard.html）**结构 1:1 对齐**：
 *   顶栏 → 双 Tab（📖 共读 / 📚 书架与笔记）
 *   - 共读页：按章折叠/跳转，点任意段落 → 写 🟡你的 / 🔵AI的批注，可下载 JSON
 *   - 书架页：汇总行 + 搜索 + 书脊色条书卡（🟡 划线 / 💭 想法 / 🔵 AI批注区）
 *
 * 纯函数，不依赖任何平台 API —— Cloudflare Workers 版与 Node 版共用同一份。
 * 书架数据全部来自微信读书官方网关（经注入的 gw 适配器）；
 * 共读数据（EPUB 段落 + 批注）由调用方以 { meta, segments } 注入，本模块不落盘。
 *
 *   gw: (apiName, params) => Promise<json>   // 由各形态自己注入（Worker 带 env；Node 从环境变量取 key）
 *
 * 子请求预算：Cloudflare 免费版单请求上限 50 个子请求。
 * 基础 3 个（书架/统计/笔记本）+ 每本书 2 个（划线 + 想法），故默认 maxBooks=12（约 27 个）。
 */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtTime = (s) => {
  if (s == null) return "—";
  const h = Math.floor(s / 3600),
    m = Math.round((s % 3600) / 60);
  return h ? `${h}小时${m}分` : `${m}分钟`;
};

const fmtDate = (ts) =>
  ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "";

const stripTags = (s) => String(s ?? "").replace(/<[^>]+>/g, "").trim();

// 展示用书名：去掉 .epub 与 (作者) / （丛书） 之类站点后缀
const cleanBookName = (s) =>
  String(s ?? "")
    .replace(/\.epub$/i, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[_·\s]+$/, "")
    .trim() || String(s ?? "");

// ---------------------------------------------------------------------------
// 章节识别（保存共读数据时兜底重排）
//   背景：不少 EPUB 把整本正文塞进一个 xhtml，`<title>` 还写着「未知」，
//   于是按文件切章会得到「一章到底」，看板上全部段落都挂在「未知」下面。
//   这里按正文里的章节标记（第X部/章、序章、尾声、Chapter N …）重新切章；
//   目录页那种「连续 ≥3 个像标题的短段」会被识别出来整段跳过。
//   segments 会被就地补上 ch / chTitle（段号不变，已有批注不受影响）。
// ---------------------------------------------------------------------------
const CHAPTER_PAT = new RegExp(
  "^(?:" +
    "第\\s{0,2}[〇零一二三四五六七八九十百千两0-9]{1,4}\\s{0,2}[部章节卷篇回集折幕](?:[\\s:：、·\\-]{0,2}\\S{1,20})?" +
    "|(?:序章|序言|序|引子|楔子|题记|前言|自序|代序|尾声|终章|结局|后记|译后记|附记|附录|跋|目录|正文)" +
    "|(?:chapter|part|prologue|epilogue|introduction|appendix|contents)\\s*[\\dIVXLCivxlc]*" +
    ")$",
  "i"
);
// 「没信息量」的章节名（文件自带 title 常是这些）
const JUNK_TITLE = /^(?:未知|无题|undefined|null|untitled|unknown|cover|title|no\s*title|sect\d*|part\d*)?$/i;

export function isChapterTitle(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 24) return false;
  if (/[。！？；，]/.test(t)) return false; // 带句读的肯定不是章标题
  if (/^[“"『「]/.test(t)) return false; // 对白
  return CHAPTER_PAT.test(t);
}

/** 现有 chapters 是否等于「没切出结构」：真章节 < 2 个，或某一章占满 ≥90% 正文 */
export function chaptersLookDegenerate(meta, segments) {
  const chs = meta?.chapters;
  const total = Array.isArray(segments) ? segments.length : 0;
  if (!Array.isArray(chs) || chs.length < 2 || !total) return true;
  const real = chs.filter((c) => c && String(c.title || "").trim() && !JUNK_TITLE.test(String(c.title).trim()));
  if (real.length < 2) return true;
  return chs.some((c) => (Number(c.segEnd) - Number(c.segStart) + 1) / total >= 0.9);
}

/**
 * 按正文里的章节标记重切章节，就地写回每个 segment 的 ch / chTitle，返回 chapters。
 * fallbackTitle 只在「一个标记都没找到」时用作唯一那一章的标题。
 */
export function deriveChapters(segments, fallbackTitle) {
  const list = Array.isArray(segments) ? segments : [];
  const flags = list.map((s) => isChapterTitle(s?.text));
  for (let i = 0; i < flags.length; ) {
    if (!flags[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < flags.length && flags[j]) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) flags[k] = false; // 目录页，整段跳过
    i = j;
  }
  const found = flags.some(Boolean);
  const lead = found ? "开篇" : fallbackTitle || "全文";
  const chapters = [];
  let cur = null;
  list.forEach((s, idx) => {
    if (flags[idx]) {
      cur = { idx: chapters.length, title: String(s.text).trim(), segStart: s.id, segEnd: s.id };
      chapters.push(cur);
    }
    if (!cur) {
      cur = { idx: 0, title: lead, segStart: s.id, segEnd: s.id };
      chapters.push(cur);
    }
    cur.segEnd = s.id;
    s.ch = cur.idx;
    s.chTitle = cur.title;
  });
  return chapters;
}

// ---------------------------------------------------------------------------
// 采集：并发拉基础数据，再按批拉每本书的划线 + 想法
// ---------------------------------------------------------------------------
export async function collect(gw, { maxBooks = 12 } = {}) {
  // 三个基础请求全部降级：网关鉴权失败 / 限流时，书架页空着没关系，
  // 共读批注必须还能打开 —— 否则 key 一过期，自己写的笔记也跟着看不见了。
  const [shelf, stats, notebooks] = await Promise.all([
    gw("/shelf/sync", {}).catch(() => null),
    gw("/readdata/detail", { mode: "overall" }).catch(() => null),
    gw("/user/notebooks", { count: 50 }).catch(() => null),
  ]);

  const allNb = notebooks?.books || notebooks?.notebooks || [];
  const nbBooks = allNb.slice(0, maxBooks);

  const details = {};
  const BATCH = 6; // 控制瞬时并发，避免触发网关限流
  for (let i = 0; i < nbBooks.length; i += BATCH) {
    await Promise.all(
      nbBooks.slice(i, i + BATCH).map(async (nb) => {
        const bookId = nb.bookId;
        const [bookmark, review] = await Promise.all([
          gw("/book/bookmarklist", { bookId }).catch(() => null),
          gw("/review/list/mine", { bookid: bookId, count: 100 }).catch(() => null),
        ]);
        details[bookId] = { bookmark, review };
      })
    );
  }

  return { shelf, stats, nbBooks, nbTotal: allNb.length, details };
}

// 书脊配色：与原版一致（按书名码点和取模）
const SPINE_COLORS = ["#5b8fd9", "#e0a63f", "#9b6bd3", "#5fae72", "#d97b8f", "#6bb8c9", "#c9825a", "#8a9a6b"];
function spineColor(title) {
  let s = 0;
  for (const c of String(title || "?")) s += c.codePointAt(0);
  return SPINE_COLORS[s % SPINE_COLORS.length];
}

// ---------------------------------------------------------------------------
// 共读页（对齐原版 coread_html）
// ---------------------------------------------------------------------------
/**
 * 共读页：**只渲染被划线/批注过的段落**（不再铺开整本原文）。
 * 理由：原文只作为 AI 的阅读素材存在服务器（KV），人类看板聚焦「划线 + 双方思考」。
 * 想给还没批注的段落写批注 → 用页内搜索定位。
 *
 *   coread = { meta:{book,totalSegments}, segments:[{id,ch,chTitle,text,user?,ai?}] }
 *   notes  = { "<id>": {user, ai, ts} }   // KV 的 coread-notes，优先于段内自带的 user/ai
 */
function coreadHtml(coread, notes) {
  if (!coread || !Array.isArray(coread.segments) || !coread.segments.length) return "";
  const byId = new Map(coread.segments.map((s) => [String(s.id), s]));

  // 批注合并：段落自带的 user/ai（兼容旧导出格式）打底，KV notes 覆盖
  // 条目形如 { user, ai, mark }：user=你的思考，ai=助手思考，mark=你划过线（只标记，不算评论）
  const ann = {};
  for (const s of coread.segments) {
    if (s.user || s.ai || s.mark) ann[String(s.id)] = { user: s.user || "", ai: s.ai || "", mark: !!s.mark };
  }
  for (const [k, n] of Object.entries(notes || {})) {
    if (!n || (!n.user && !n.ai && !n.mark)) delete ann[k];
    else
      ann[k] = {
        user: n.user || "",
        ai: n.ai || "",
        mark: !!n.mark,
        ts: Number(n.ts) || 0,
        batch: n.batch || "",
      };
  }

  const ids = Object.keys(ann)
    .filter((k) => byId.has(k))
    .map(Number)
    .sort((a, b) => a - b);
  const idSet = new Set(ids);

  // 概览三个数：你写的 / AI批的 / 两边都有（最后一个才是共读真正生效的地方）
  let nYou = 0,
    nAi = 0,
    nBoth = 0;
  for (const id of ids) {
    const n = ann[String(id)];
    if (n.user) nYou++;
    if (n.ai) nAi++;
    if (n.user && n.ai) nBoth++;
  }

  // 批注里的「见第 812 段」→ 可点的段内锚点。
  // 先 esc 再替换：匹配的只是「第 812 段」这种纯文本，不会把标签喂进 HTML。
  const aihtml = (s) =>
    esc(s).replace(/第\s{0,2}(\d{1,5})\s{0,2}段/g, (m, d) =>
      idSet.has(Number(d))
        ? `<a class="seg-ref" data-seg="${Number(d)}" onclick="jumpSeg(${Number(d)},event);return false">${m}</a>`
        : m
    );

  const day = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return "";
    const d = new Date(n);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // 按章分组（只对有批注/划线的段落分组；无章信息的老数据归到同一组）
  const groups = [];
  for (const id of ids) {
    const t = String(byId.get(String(id)).chTitle || "").trim();
    const last = groups[groups.length - 1];
    if (!last || last.title !== t) groups.push({ title: t, ids: [id] });
    else last.ids.push(id);
  }

  const parts = [
    '<div class="panel" id="coread">',
    '<h3 class="cr-head">' +
      '<span class="cr-title">📖 共读批注</span>' +
      `<span class="cr-sub">只显示<strong>被划线 / 被批注</strong>的 ${ids.length} 段 · 原文在服务器上，供AI读</span>` +
      '</h3>',
    // 自动匹配不上时，在这里列候选书单，点一本即绑定（记住，下次直接用）
    '<div class="cr-cands" id="cr-cands" hidden></div>',
  ];
  // 四档筛选：「两边都有」是共读真正生效的地方 —— 以前埋在长列表里，没有任何出口。
  // 零批注时不渲染（一排 0 没有信息量，只会挤占空状态的位置）。
  if (ids.length) {
    parts.splice(
      1,
      0,
      '<div class="cr-filters" id="cr-filters">' +
        `<button data-f="all" class="on" onclick="crFilter('all',this)">全部<i>${ids.length}</i></button>` +
        `<button data-f="mine" onclick="crFilter('mine',this)"><span class="dot d-you"></span>我写的<i>${nYou}</i></button>` +
        `<button data-f="ai" onclick="crFilter('ai',this)"><span class="dot d-ai"></span>AI批的<i>${nAi}</i></button>` +
        `<button data-f="both" onclick="crFilter('both',this)"><span class="dot d-both"></span>两边都有<i>${nBoth}</i></button>` +
        '</div>'
    );
  }

  // 章节目录条：点一章即跳到那章（顺带展开），再点章标题可就地折叠
  if (groups.length > 1) {
    parts.push(
      '<div class="cr-toc" id="cr-toc"><span class="toc-l">章节</span>' +
        groups
          .map(
            (g, i) =>
              `<button class="toc-i" data-ch="${i}" onclick="jumpCh(${i})">` +
              `${esc(g.title || "（未分章）")}<i>${g.ids.length}</i></button>`
          )
          .join("") +
        '<button class="toc-a" id="toc-all" onclick="foldAll(this)">全部收起</button></div>'
    );
  }

  parts.push('<div id="cr-list">');

  if (!ids.length) {
    parts.push(
      '<div class="empty" id="cr-empty">这本书还没有任何划线或批注。<br>' +
        '让AI通过 MCP 读原文后写下批注，或点上面的「🔄 同步微信读书划线」把你的划线拉进来。</div>'
    );
  }

  groups.forEach((g, gi) => {
    parts.push(`<section class="cr-ch" id="crch-${gi}">`);
    parts.push(
      '<h4 class="cth" onclick="tgCh(this)">' +
        `<span class="cth-t">${esc(g.title || "（未分章）")}</span>` +
        `<span class="cth-n">${g.ids.length} 条</span><span class="cth-a">▾</span></h4>`
    );
    parts.push('<div class="ch-body">');
    for (const id of g.ids) {
      const s = byId.get(String(id));
      const n = ann[String(id)];
      // 划线只做标记（黄底 + 小标签），**只有想法才**渲染成「🟡 你：」——划线 ≠ 评论
      const mk = n.mark && !n.user ? '<div class="u-mark">🟡 你划过线</div>' : "";
      const u = n.user ? `<div class="u-note">🟡 你：${esc(n.user)}</div>` : "";
      // aihtml：批注里的「见第 812 段」渲染成可点锚点（AI 读过整本的证据）
      const a = n.ai ? `<div class="a-note">🔵 AI：${aihtml(n.ai)}</div>` : "";
      const t = day(n.ts);
      parts.push(
        `<div class="seg${n.mark ? " hl" : ""}" id="seg-${id}"` +
          ` data-u="${n.user ? 1 : 0}" data-a="${n.ai ? 1 : 0}" onclick="pick(${id})">` +
          `<div class="seg-mm"><span>第 ${id} 段</span>${t ? `<span>${t}</span>` : ""}</div>` +
          `<div class="seg-text">${esc(s.text)}</div>${mk}${u}${a}</div>`
      );
    }
    parts.push("</div></section>");
  });
  parts.push('<div class="empty" id="cr-empty-filter" hidden>这个筛选下还没有内容 —— 切回「全部」看看</div>');
  parts.push("</div>");
  // 浮动提示：编辑器收起后「已写入服务器」也要看得见
  parts.push('<div id="cr-toast" class="toast"></div>');

  parts.push(`<div id="editor" hidden>
      <div id="edit-which" class="mm"></div>
      <textarea id="edit-user" placeholder="🟡 你的想法…这栏只有你能写" oninput="autoSave()"></textarea>
      <div class="ed-ro">
        <span class="ed-ro-t">🔵 AI的批注 · 只读</span>
        <textarea id="edit-ai" readonly placeholder="（这段AI还没批）"></textarea>
      </div>
      <div class="ed-row">
        <button class="sv" onclick="saveNow()" id="btn-save">💾 保存</button>
        <button class="cx" onclick="closeEditor()" title="不保存内容也可收起">收起</button>
        <span class="hint" id="save-hint">点「保存」写入服务器，换设备同样可见</span>
      </div>
    </div>`);
  // 页尾：导出 / 撤销 / 同步。
  // 这三个都是低频动作，从顶部降权到这里 —— 顶部的位置让给概览和筛选。
  parts.push(`<div class="cr-foot">
      <button class="dl" onclick="downloadMarkdown()">⬇ 导出 Markdown</button>
      <button class="undo-btn" id="btn-undo" onclick="undoBatch()" hidden>↩ 撤销AI上一批</button>
      <button class="sy ghost" id="btn-sync" onclick="crSync(this)">🔄 同步微信读书</button>
      <span class="hint" id="foot-hint"></span>
    </div>`);
  // 本机草稿未同步的提示条：放在整页最末尾（编辑与保存都在页面下方，提示跟着动作走）
  parts.push(
    '<div class="sync-bar" id="sync-bar" hidden>⚠️ 本机有 <b id="sync-n">0</b> 条批注还没同步到服务器' +
      '<button onclick="syncNow()">立即同步</button></div>'
  );
  parts.push("</div>");
  return parts.join("");
}

// 共读交互 JS
// 保存语义：批注以**服务器**为准（写 KV）。本机 localStorage 只做网络失败时的草稿兜底。
const COREAD_JS = `
var CR_TOKEN=(function(){try{return new URLSearchParams(location.search).get('token')||''}catch(e){return ''}})();
var cur=null,_dirty=false,_t=null;

function renderNotes(el, n){
  var um=el.querySelector('.u-mark'); if(um)um.remove();
  var un=el.querySelector('.u-note'); if(un)un.remove();
  var an=el.querySelector('.a-note'); if(an)an.remove();
  // 划线只标「你划过线」；只有想法才显示成「🟡 你：」
  if(n.mark&&!n.user){var m=document.createElement('div');m.className='u-mark';m.textContent='🟡 你划过线';el.appendChild(m)}
  if(n.user){var u=document.createElement('div');u.className='u-note';u.textContent='🟡 你：'+n.user;el.appendChild(u)}
  // AI 那侧走 innerHTML，好让「见第 812 段」保持可点（escHtml 已转义，安全）
  if(n.ai){var a=document.createElement('div');a.className='a-note';a.innerHTML='🔵 AI：'+segRefHtml(n.ai);el.appendChild(a)}
  if(el.classList) el.classList.toggle('hl', !!n.mark);
  // 筛选依赖这两个属性，编辑后必须同步，否则筛选结果会过期
  el.setAttribute('data-u', n.user?1:0);
  el.setAttribute('data-a', n.ai?1:0);
  if(CR_FILTER && CR_FILTER!=='all' && !segMatch(el)) el.hidden=true;
}
// 批注文本 → 安全 HTML，「第 N 段」只在目标段确实存在时变成链接
function segRefHtml(s){
  return escHtml(s).replace(/第\s{0,2}(\d{1,5})\s{0,2}段/g, function(m,d){
    return document.getElementById('seg-'+d)
      ? '<a class="seg-ref" data-seg="'+d+'" onclick="jumpSeg('+d+',event);return false">'+m+'</a>'
      : m;
  });
}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function toast(msg){
  var t=document.getElementById('cr-toast'); if(!t) return;
  t.textContent=msg; t.classList.add('on');
  clearTimeout(t._tt); t._tt=setTimeout(function(){ t.classList.remove('on') },1800);
}
// ---- 筛选：全部 / 我写的 / AI批的 / 两边都有 ----
var CR_FILTER='all';
function segMatch(el){
  var u=el.getAttribute('data-u')==='1', a=el.getAttribute('data-a')==='1';
  if(CR_FILTER==='mine') return u;
  if(CR_FILTER==='ai')   return a;
  if(CR_FILTER==='both') return u&&a;
  return true;
}
function crFilter(f){
  CR_FILTER=f||'all';
  var bar=document.getElementById('cr-filters');
  if(bar) bar.querySelectorAll('button').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-f')===CR_FILTER);
  });
  applyFilter();
  // 正在编辑的段落被这一档筛掉了 → 顺手收起，否则输入框跟着段落一起消失、内容悬空
  if(cur!=null){
    var el=document.getElementById('seg-'+cur);
    if(el && el.hidden) closeEditor();
  }
}
// 筛选后：空章节整章收起、目录条计数跟着变 —— 否则会出现「点进去什么都没有」
function applyFilter(){
  var shown=0, secs=document.querySelectorAll('#coread .cr-ch'), perSec=[];
  secs.forEach(function(sec){
    var body=sec.querySelector('.ch-body'); if(!body){perSec.push(0);return}
    var n=0;
    body.querySelectorAll('.seg').forEach(function(s){ var ok=segMatch(s); s.hidden=!ok; if(ok)n++ });
    sec.hidden = (n===0);
    perSec.push(n); shown+=n;
    var c=sec.querySelector('.cth-n'); if(c) c.textContent=n+' 条';
  });
  document.querySelectorAll('#coread .cr-toc .toc-i').forEach(function(b,i){
    var n=perSec[i]||0;
    var it=b.querySelector('i'); if(it) it.textContent=n;
    b.style.opacity = n ? '' : '.4';
  });
  var empty=document.getElementById('cr-empty-filter');
  if(empty) empty.hidden = shown>0;
}
// ---- 跨段跳转：AI 批注里写「见第 812 段」，点一下真的跳过去 ----
function jumpSeg(id, ev){
  if(ev){ ev.preventDefault(); ev.stopPropagation() }
  var el=document.getElementById('seg-'+id);
  if(!el){ toast('第 '+id+' 段还没批注 —— 去微信读书里看原文'); return }
  if(el.hidden) crFilter('all');            // 被当前筛选藏住了就先放开
  // 目标在折叠的章节里 → 先展开，否则滚过去是一片空白
  var sec = el.closest ? el.closest('.cr-ch') : null;
  if(sec){
    var body = sec.querySelector('.ch-body');
    if(body && body.hidden){ body.hidden=false; if(sec.classList) sec.classList.remove('fold') }
  }
  try{ el.scrollIntoView({behavior:'smooth',block:'center'}) }catch(e){}
  if(el.classList){ el.classList.add('hit'); setTimeout(function(){ el.classList.remove('hit') },1100) }
}
// ---- 撤销最近一批 AI 批注（只清 ai，user / mark 原样留着）----
function batchList(){
  var m={};
  for(var k in COREAD_NOTES){
    var v=COREAD_NOTES[k]||{}; if(!v.ai) continue;
    var b=v.batch||''; if(!b) continue;      // 老数据没有批次号，不参与撤销
    var o=m[b]||(m[b]={id:b,ts:0,ids:[]});
    o.ids.push(k);
    if((v.ts||0)>o.ts) o.ts=v.ts||0;
  }
  var out=[]; for(var x in m) out.push(m[x]);
  out.sort(function(a,b){ return b.ts-a.ts });
  return out;
}
function undoBatch(){
  var bs=batchList(); if(!bs.length) return;
  var b=bs[0];
  if(!confirm('撤销AI最近这批批注？共 '+b.ids.length+' 条。\\n你自己的划线和你写的想法都会保留。')) return;
  var btn=document.getElementById('btn-undo');
  if(btn){ btn.disabled=true; btn.textContent='撤销中…' }
  fetch('coread/undo',{method:'POST',headers:{'Authorization':'Bearer '+CR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({batch:b.id})})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j} }) })
    .then(function(x){
      if(!x.ok) throw new Error(x.j.error||('HTTP '+x.ok));
      toast('已撤销 '+((x.j&&x.j.cleared)||0)+' 条AI批注，刷新中…');
      setTimeout(function(){ location.reload() },700);
    })
    .catch(function(e){ toast('撤销失败：'+((e&&e.message)||e)); if(btn) btn.disabled=false; refreshFoot(); });
}
// ---- 章节：折叠 / 跳转 ----
function closeEditor(){
  var ed=document.getElementById('editor'); if(ed) ed.hidden=true;
  document.querySelectorAll('.seg.on').forEach(function(x){x.classList.remove('on')});
  _dirty=false;
}
function tgCh(h){
  if(!h) return;
  var sec=h.parentNode; if(!sec) return;
  var body=sec.querySelector('.ch-body'); if(!body) return;
  var ed=document.getElementById('editor');
  if(!body.hidden && ed && !ed.hidden && sec.contains(ed)) closeEditor();  // 收起章节时顺手收起编辑器
  body.hidden=!body.hidden;
  if(sec.classList) sec.classList.toggle('fold', body.hidden);
}
function jumpCh(i){
  var sec=document.getElementById('crch-'+i); if(!sec) return;
  // 这一章被当前筛选整章藏起来了 → 先放开筛选，否则「跳过去什么都没有」
  if(sec.hidden) crFilter('all');
  var body=sec.querySelector('.ch-body');
  if(body&&body.hidden){ body.hidden=false; if(sec.classList)sec.classList.remove('fold') }
  var bar=document.getElementById('cr-toc');
  if(bar) bar.querySelectorAll('.toc-i').forEach(function(b,k){ b.classList.toggle('on', k===i) });
  try{ if(sec.scrollIntoView) sec.scrollIntoView({behavior:'smooth',block:'start'}) }catch(e){}
  var t=sec.querySelector('.cth');
  if(t){ t.classList.add('flash'); setTimeout(function(){ t.classList.remove('flash') },900) }
}
function foldAll(btn){
  var secs=document.querySelectorAll('.cr-ch'); if(!secs.length) return;
  var anyOpen=false;
  secs.forEach(function(s){ var b=s.querySelector('.ch-body'); if(b&&!b.hidden) anyOpen=true });
  if(anyOpen){ var ed=document.getElementById('editor'); if(ed&&!ed.hidden) closeEditor() }
  secs.forEach(function(s){
    var b=s.querySelector('.ch-body'); if(!b) return;
    b.hidden=anyOpen;
    if(s.classList) s.classList.toggle('fold', anyOpen);
  });
  if(btn) btn.textContent=anyOpen?'全部展开':'全部收起';
}
function persist(){
  try{ localStorage.setItem('coread-notes', JSON.stringify(COREAD_NOTES)); }catch(e){}
}
// 本机草稿中比服务器新的条目
function pendingLocal(){
  var out={};
  try{
    var s=localStorage.getItem('coread-notes'); if(!s) return out;
    var saved=JSON.parse(s);
    for(var k in saved){
      var v=saved[k]; if(!v||(!v.user&&!v.ai)) continue;
      var c=COREAD_NOTES[k];
      if(!c || (v.ts||0) > (c.ts||0)) out[k]=v;
    }
  }catch(e){}
  return out;
}
function showSyncBar(){
  var bar=document.getElementById('sync-bar'); if(!bar) return;
  var n=Object.keys(pendingLocal()).length;
  bar.hidden = !n;
  var el=document.getElementById('sync-n'); if(el) el.textContent=n;
}
function syncNow(){
  var p=pendingLocal(); if(!Object.keys(p).length) return;
  fetch('coread/notes',{method:'POST',headers:{'Authorization':'Bearer '+CR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(p)})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j} }) })
    .then(function(x){
      if(!x.ok) throw new Error(x.j.error||('HTTP '+x.ok));
      try{ localStorage.removeItem('coread-notes') }catch(e){}
      location.reload();
    })
    .catch(function(e){ alert('同步失败：'+((e&&e.message)||e)) });
}
// ---- 从微信读书拉「我的划线 + 想法」（服务端直接拉，写 🟡 栏）----
// 返回里带 candidates = 没自动匹配上时给的候选书单（书名+作者+相似度），点一本即绑定。
function crCandsShow(j){
  var box=document.getElementById('cr-cands'); if(!box) return;
  var list=(j&&j.candidates)||[];
  if(!list.length){ box.hidden=true; box.innerHTML=''; return }
  var html='<div class="cand-h">没自动认出「'+escHtml(j.want||'')+'」对应的微信读书笔记本，点一本绑上（会记住）：</div>';
  for(var i=0;i<list.length;i++){
    var c=list[i]||{};
    html+='<button class="cand" data-id="'+escHtml(c.bookId||'')+'" onclick="crBind(this)">'+
      '<b>'+escHtml(c.title||'（无书名）')+'</b>'+
      (c.author?'<span class="ca">'+escHtml(c.author)+'</span>':'')+
      (c.score?'<span class="cs">'+(c.score*1).toFixed(2)+'</span>':'')+
      '</button>';
  }
  box.innerHTML=html; box.hidden=false;
}
function crBind(el){
  var id=el&&el.getAttribute('data-id'); if(!id) return;
  toast('已选《'+(el.querySelector('b')?el.querySelector('b').textContent:'')+'》，正在同步…');
  fetch('coread/sync?token='+encodeURIComponent(CR_TOKEN),{method:'POST',headers:{'Authorization':'Bearer '+CR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({bookId:id})})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j} }) })
    .then(function(x){
      var j=x.j||{};
      if(!x.ok || j.error) throw new Error(j.error||('HTTP '+x.ok));
      crCandsShow(null);
      toast('✓ 已绑定并同步：写入 '+(j.written||0)+' 段，刷新中…');
      setTimeout(function(){ location.reload() },900);
    })
    .catch(function(e){ toast('同步失败：'+((e&&e.message)||e)) });
}
function crSync(btn){
  if(btn){ btn.disabled=true; btn.textContent='⏳ 同步中…' }
  fetch('coread/sync?token='+encodeURIComponent(CR_TOKEN),{method:'POST',headers:{'Authorization':'Bearer '+CR_TOKEN,'Content-Type':'application/json'},body:'{}'})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j} }) })
    .then(function(x){
      var j=x.j||{};
      // 没匹配上：列出候选让用户点选绑定，不算失败
      if(j.candidates&&j.candidates.length){
        crCandsShow(j);
        if(btn){ btn.disabled=false; btn.textContent='🔄 同步微信读书' }
        toast('没自动认出对应笔记本，请在下面点选一本');
        return;
      }
      if(!x.ok || j.error) throw new Error(j.error||('HTTP '+x.ok));
      crCandsShow(null);
      if(btn){ btn.textContent='✓ 已同步' }
      var msg='✓ 已同步：划线 '+(j.highlights||0)+' 条 · 想法 '+(j.thoughts||0)+' 条 → 写入 '+(j.written||0)+' 段';
      // 你在看板上手写的想法不会被同步覆盖，这里如实告诉你保留了几条
      if(j.kept) msg+=' · 保留你写的 '+j.kept+' 段';
      toast(msg);
      setSaveHint(j.kept? ('已同步 '+j.written+' 段，你手写的 '+j.kept+' 段原样保留') : ('已从微信读书同步 '+j.written+' 段'));
      setTimeout(function(){ location.reload() },900);
    })
    .catch(function(e){
      toast('同步失败：'+((e&&e.message)||e));
      if(btn){ btn.disabled=false; btn.textContent='🔄 同步微信读书' }
    });
}
function pick(id){
  var el=document.getElementById('seg-'+id); if(!el) return;
  var ed=document.getElementById('editor');
  // 再点一次同一段 = 收起编辑器（保存完也会自动收）
  if(cur===id && ed && !ed.hidden){ closeEditor(); return }
  document.querySelectorAll('.seg.on').forEach(function(x){x.classList.remove('on')});
  el.classList.add('on');cur=id;
  el.after(ed); ed.hidden=false;            // 编辑器跟随点选段落
  var st=el.querySelector('.seg-text');
  document.getElementById('edit-which').textContent='第 '+id+' 段 · '+((st?st.textContent:'').slice(0,40))+'…';
  var n=COREAD_NOTES[String(id)]||{};
  document.getElementById('edit-user').value=n.user||'';
  document.getElementById('edit-ai').value=n.ai||'';
  _dirty=false;
  setSaveHint('改完点「保存」写入服务器');
}
// 写进内存 + localStorage（只动 🟡 那一栏；🔵 归AI，前端连提交都不提交）
function commitNote(){
  if(cur==null) return;
  var u=document.getElementById('edit-user').value;
  var k=String(cur), el=document.getElementById('seg-'+cur);
  var prev=COREAD_NOTES[k]||{};
  var a=prev.ai||'';                          // 🔵 是机器写的，人这边不碰
  var mark=!!prev.mark;                        // 划线状态来自同步，编辑不清掉
  if(u.trim()||a.trim()||mark){
    COREAD_NOTES[k]={user:u,ai:a,ts:Date.now()};
    if(mark)COREAD_NOTES[k].mark=true;
    if(prev.batch)COREAD_NOTES[k].batch=prev.batch;
    if(el)renderNotes(el,COREAD_NOTES[k]);
  }else{
    delete COREAD_NOTES[k];
    if(el)renderNotes(el,{});
  }
  persist(); refreshFoot();
  // 编辑可能改变了这一段的归属（比如把 AI 那段清空了）→ 当前筛选下要重算可见性
  if(CR_FILTER && CR_FILTER!=='all'){
    applyFilter();
    var self=document.getElementById('seg-'+cur);
    if(self && self.hidden) closeEditor();   // 这一笔已经不属于当前档位了，跟着收起
  }
}
function noteCount(){
  var n=0; for(var k in COREAD_NOTES){var v=COREAD_NOTES[k]; if(v&&(v.user||v.ai||v.mark))n++} return n;
}
function refreshFoot(){
  var el=document.getElementById('foot-hint');
  if(el) el.textContent='已批注 '+noteCount()+' 段 · 保存后写入服务器，换设备同样可见';
  // 有批次号才给撤销入口；老数据（没有 batch）不显示，避免一刀切清掉历史批注
  var b=document.getElementById('btn-undo');
  if(b){
    var bs=batchList();
    if(bs.length){ b.hidden=false; b.textContent='↩ 撤销AI上一批（'+bs[0].ids.length+' 条）' }
    else b.hidden=true;
  }
}
function setSaveHint(msg,ok){
  var h=document.getElementById('save-hint'); if(!h) return;
  h.textContent=msg; h.className='hint'+(ok?' ok':'');
}
function postNotes(body,okMsg){
  return fetch('coread/notes',{method:'POST',headers:{'Authorization':'Bearer '+CR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j} }) })
    .then(function(x){
      if(!x.ok) throw new Error(x.j.error||('HTTP '+x.ok));
      try{ localStorage.removeItem('coread-notes') }catch(e){}
      _dirty=false;
      setSaveHint(okMsg+' · '+new Date().toLocaleTimeString(),true);
      refreshFoot(); showSyncBar();
    });
}
function saveNow(){
  commitNote();
  var k=String(cur), n=COREAD_NOTES[k], body={};
  // 只提交 🟡 和划线；🔵 不在这个通道里写 —— 服务端也会把 ai 丢掉，双保险
  body[k]= n ? {user:n.user||'',mark:!!n.mark} : {user:'',mark:false};
  var b=document.getElementById('btn-save');
  postNotes(body,'✓ 已写入服务器').then(function(){
    if(b){var old='💾 保存';b.textContent='✓ 已保存';b.classList.add('done');setTimeout(function(){b.textContent=old;b.classList.remove('done')},1200)}
    toast('✓ 已写入服务器');
    // 存完自动收起编辑器；若这期间又改了字（_dirty）或换了段，就不收
    setTimeout(function(){ if(!_dirty && String(cur)===k) closeEditor() },700);
  }).catch(function(e){
    setSaveHint('⚠ 服务器保存失败，已暂存本机：'+((e&&e.message)||e));
    showSyncBar();
  });
}
// 导出 Markdown：按章分节、双色对照，能直接贴 Notion / Obsidian / flomo。
// 以前给的是 coread-notes.json —— 普通人拿到打不开，等于没导出。
function downloadMarkdown(){
  commitNote();
  var bookEl=document.querySelector('.cr-book b');
  var book=bookEl?bookEl.textContent.trim():'共读';
  var you=0,aiN=0;
  for(var k in COREAD_NOTES){var v=COREAD_NOTES[k];if(!v)continue;if(v.user)you++;if(v.ai)aiN++}
  var L=['# 《'+book+'》共读笔记','',
    '> '+noteCount()+' 段 · 🟡 你写的 '+you+' · 🔵 AI批的 '+aiN+' · 导出于 '+new Date().toLocaleDateString(),''];
  document.querySelectorAll('#coread .cr-ch').forEach(function(sec){
    var tt=sec.querySelector('.cth-t');
    L.push('## '+(tt?tt.textContent.trim():'（未分章）'),'');
    sec.querySelectorAll('.seg').forEach(function(el){
      var id=(el.id||'').replace('seg-','');
      var tx=el.querySelector('.seg-text');
      var un=el.querySelector('.u-note');
      var an=el.querySelector('.a-note');
      L.push('### 第 '+id+' 段','');
      if(tx) L.push('> '+tx.textContent.trim().replace(/\\n+/g,'\\n> '),'');
      if(un) L.push('**🟡 你**：'+un.textContent.replace(/^🟡\s*你：/,''),'');
      if(an) L.push('','**🔵 AI**：'+an.textContent.replace(/^🔵\s*AI：/,''),'');
      if(!un&&!an) L.push('_（只划过线）_','');
      L.push('');
    });
  });
  var blob=new Blob([L.join('\\n')],{type:'text/markdown;charset=utf-8'});
  var aEl=document.createElement('a');
  aEl.href=URL.createObjectURL(blob);
  aEl.download='共读笔记-'+book+'.md';
  aEl.click();
  URL.revokeObjectURL(aEl.href);
  toast('已导出 Markdown');
}
// 输入即自动暂存到本机（不写服务器，避免频繁 KV 写）
function autoSave(){
  if(cur==null)return;
  _dirty=true;
  clearTimeout(_t);
  _t=setTimeout(function(){commitNote();setSaveHint('已暂存本机 · 记得点「保存」写入服务器')},600);
}
refreshFoot();
showSyncBar();
applyFilter();
`;

// ---------------------------------------------------------------------------
// 浏览器内 EPUB 解析（纯函数，无 DOM 依赖 —— 可在 Node 里直接跑测试）
// 与 tools/epub-split.py 同口径：找 .opf → 按 spine 顺序 → 抽段落。
// 数据在用户设备本地拆，只把 {meta, segments} 上传，EPUB 原件不出本机。
// ---------------------------------------------------------------------------
export const EPUB_PARSE_JS = String.raw`
function normPath(p){
  var parts=String(p).split('/'),out=[];
  for(var i=0;i<parts.length;i++){var x=parts[i];if(!x||x==='.')continue;if(x==='..'){out.pop();continue}out.push(x)}
  return out.join('/');
}
var ENT={'amp':'&','lt':'<','gt':'>','quot':'"','apos':"'",'nbsp':' ','mdash':'\u2014','ndash':'\u2013','hellip':'\u2026','ldquo':'\u201c','rdquo':'\u201d','lsquo':'\u2018','rsquo':'\u2019','middot':'\u00b7','times':'\u00d7','copy':'\u00a9'};
function entOf(l){ return Object.prototype.hasOwnProperty.call(ENT,l)?ENT[l]:'' }
function decodeEnt(s){
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi,function(_,m){
    var l=m.toLowerCase();
    if(l.charAt(0)==='#'){
      var n=l.charAt(1)==='x'?parseInt(l.slice(2),16):parseInt(l.slice(1),10);
      return (isNaN(n)||n<0||n>0x10ffff)?'':String.fromCodePoint(n);
    }
    return entOf(l);
  });
}
function stripHtml(raw){
  raw=String(raw).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi,'');
  var out=[],re=/<(p|h[1-6]|li|blockquote|div)[^>]*>([\s\S]*?)<\/\1>/gi,m;
  while((m=re.exec(raw))){
    var t=decodeEnt(m[2].replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();
    if(t.length>=2) out.push(t);
  }
  if(!out.length){
    var all=decodeEnt(raw.replace(/<[^>]+>/g,' ')).replace(/[ \t\u00a0]+/g,' ').trim();
    if(all) out=all.split(/\n+/).map(function(x){return x.trim()}).filter(function(x){return x.length>=2});
  }
  return out;
}
async function unzip(buf){
  var u8=buf instanceof Uint8Array?buf:new Uint8Array(buf);
  var dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  var eocd=-1,i,lo=Math.max(0,u8.length-22-65535);
  for(i=u8.length-22;i>=lo;i--){ if(dv.getUint32(i,true)===0x06054b50){eocd=i;break} }
  if(eocd<0) throw new Error('不是有效的 EPUB（找不到 zip 结尾记录）');
  var count=dv.getUint16(eocd+10,true),cdOff=dv.getUint32(eocd+16,true);
  var files={},p=cdOff;
  for(var k=0;k<count;k++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    var method=dv.getUint16(p+10,true),csize=dv.getUint32(p+20,true);
    var nlen=dv.getUint16(p+28,true),elen=dv.getUint16(p+30,true),clen=dv.getUint16(p+32,true);
    var lho=dv.getUint32(p+42,true);
    var name=new TextDecoder('utf-8').decode(u8.subarray(p+46,p+46+nlen));
    var lnlen=dv.getUint16(lho+26,true),lelen=dv.getUint16(lho+28,true);
    var start=lho+30+lnlen+lelen;
    files[normPath(name)]={method:method,data:u8.subarray(start,start+csize)};
    p+=46+nlen+elen+clen;
  }
  return files;
}
async function entryText(e){
  if(e.method===0) return new TextDecoder('utf-8').decode(e.data);
  if(e.method===8){
    var s=new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(s).text();
  }
  throw new Error('EPUB 内有未支持的压缩方式（method='+e.method+'）');
}
async function parseEpub(buf,fileName,onStatus){
  onStatus=onStatus||function(){};
  onStatus('正在解析 EPUB 结构…');
  var files=await unzip(buf),names=Object.keys(files),i;
  var opfName=null;
  for(i=0;i<names.length;i++){ if(/\.opf$/i.test(names[i])){opfName=names[i];break} }
  var spine=[],metaTitle='',metaAuthor='';
  if(opfName){
    var opf=await entryText(files[opfName]);
    var base=opfName.replace(/[^\/]*$/,'');
    // 取 EPUB 自己的书名/作者（dc:title / dc:creator）——
    // 文件名常被站点改得面目全非，书内元数据才是能跟微信读书对上的名字
    var tm0=opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)||opf.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if(tm0) metaTitle=decodeEnt(tm0[1].replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();
    var tc0=opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    if(tc0) metaAuthor=decodeEnt(tc0[1].replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();
    var man={},m,reItem=/<item\b[^>]*>/gi;
    while((m=reItem.exec(opf))){
      var im=m[0].match(/\bid\s*=\s*"([^"]+)"/i),hm=m[0].match(/\bhref\s*=\s*"([^"]+)"/i);
      if(im&&hm){
        var href=hm[1];
        try{ href=decodeURIComponent(href) }catch(e){}
        man[im[1]]=normPath(base+href);
      }
    }
    var reRef=/<itemref\b[^>]*\bidref\s*=\s*"([^"]+)"/gi;
    while((m=reRef.exec(opf))){ var f=man[m[1]]; if(f&&files[f]) spine.push(f); }
  }
  if(!spine.length){
    spine=names.filter(function(n){return /\.(xhtml|html|htm)$/i.test(n)}).sort();
  }
  var segments=[],chapters=[],id=0,ci;
  for(ci=0;ci<spine.length;ci++){
    var raw;
    try{ raw=await entryText(files[spine[ci]]) }catch(e){ continue }
    var tm=raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    var title=tm?decodeEnt(tm[1]).replace(/\s+/g,' ').trim():spine[ci].split('/').pop();
    var blocks=stripHtml(raw);
    if(!blocks.length) continue;
    var start=id;
    for(var pi=0;pi<blocks.length;pi++){ id++; segments.push({id:id,ch:ci,chTitle:title,text:blocks[pi],user:'',ai:''}) }
    chapters.push({idx:ci,title:title,segStart:start+1,segEnd:id});
    if(ci%5===0) onStatus('已拆 '+ci+' 章 · '+id+' 段…');
  }
  return {meta:{book:metaTitle||fileName||'',title:metaTitle||'',author:metaAuthor||'',file:fileName||'',chapters:chapters,totalSegments:segments.length},segments:segments};
}
`;

// 导入交互（拖拽 / 选择文件 → 本地拆段 → POST /coread）
export const IMPORT_JS = String.raw`
function coreadToken(){
  try{ return new URLSearchParams(location.search).get('token')||'' }catch(e){ return '' }
}
function setStatus(msg,cls){
  var s=document.getElementById('up-status');
  if(s){ s.textContent=msg; s.className='drop-s'+(cls?' '+cls:''); }
}
async function uploadCoread(payload){
  setStatus('正在保存到服务器…');
  var r=await fetch('coread',{method:'POST',headers:{'Authorization':'Bearer '+coreadToken(),'Content-Type':'application/json'},body:JSON.stringify(payload)});
  var j={}; try{ j=await r.json() }catch(e){}
  if(r.status===401) throw new Error('口令不对：请用 /dashboard?token=<口令> 打开本页再上传');
  if(!r.ok) throw new Error(j.error?j.error+(j.hint?('：'+j.hint):''):('服务器返回 '+r.status));
  setStatus('✓ 已保存 '+j.segments+' 段，正在刷新…','ok');
  setTimeout(function(){ location.reload() },900);
}
(function(){
  var d=document.getElementById('drop'); if(!d) return;
  function over(e){ e.preventDefault(); e.stopPropagation(); d.classList.add('over') }
  function out(e){ e.preventDefault(); d.classList.remove('over') }
  ['dragenter','dragover'].forEach(function(ev){ d.addEventListener(ev,over) });
  ['dragleave','dragend','drop'].forEach(function(ev){ d.addEventListener(ev,out) });
  async function handle(f){
    if(!f) return;
    if(!/\.epub$/i.test(f.name)){ setStatus('请选 .epub 文件（当前：'+f.name+'）','err'); return }
    try{
      setStatus('正在读取 '+f.name+' …');
      var data=await parseEpub(await f.arrayBuffer(),f.name,setStatus);
      if(!data.segments.length){ setStatus('这个 EPUB 没解析出段落，可能不是标准 EPUB','err'); return }
      setStatus('拆出 '+data.segments.length+' 段，正在上传…');
      await uploadCoread(data);
    }catch(err){ setStatus('失败：'+((err&&err.message)||err),'err') }
  }
  d.addEventListener('drop',function(e){ handle(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) });
  var inp=document.getElementById('epub-file');
  if(inp) inp.addEventListener('change',function(){ handle(inp.files&&inp.files[0]) });
  var pick=document.getElementById('epub-pick');
  if(pick) pick.addEventListener('click',function(e){ e.preventDefault(); if(inp) inp.click() });
})();
`;

// CSS（原版 weread_dashboard.py 的样式，逐条对齐）
const CSS = `
:root{--bg:#faf7f2;--card:#fff;--ink:#2c2a26;--sub:#8a8578;--yellow:#f5c518;--blue:#4a90d9;--purple:#9b6bd3;--line:#e8e2d6}
*{box-sizing:border-box;margin:0}
/* hidden 属性必须压得住下面 .sync-bar 之类的 display:flex，否则「本机有 0 条」也会一直显示 */
[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink);font:15px/1.7 "PingFang SC","Microsoft YaHei",sans-serif;padding:28px 14px 80px}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:22px}.sub{color:var(--sub);font-size:13px;margin:4px 0 14px}
.tabs{display:flex;gap:4px;margin-bottom:14px;padding:4px;background:var(--card);border:1px solid var(--line);border-radius:13px}
.tab{flex:1;font:inherit;font-size:13.5px;font-weight:700;padding:9px 0;border:0;border-radius:10px;background:var(--ink);color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(44,42,38,.14);transition:background .15s,color .15s}
.tab.off{background:transparent;color:var(--sub);font-weight:500;box-shadow:none}
.tab.off:hover{background:#f7f3ea}
.sum-line{color:var(--sub);font-size:13px;margin-bottom:12px}
.sum-line b{color:var(--ink)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:18px}
.panel h3{font-size:14px;color:var(--sub);margin-bottom:10px}.hint{font-weight:400;font-size:11px;margin-left:8px}
.cr-book{background:#f4f8fd;border:1px solid #d8e5f4;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:14px}
.cr-book-sub{display:block;color:var(--sub);font-size:11px;margin-top:2px}
.cr-head{display:block}
.cr-sub{display:block;font-weight:400;font-size:12px;color:var(--sub);margin-top:3px}
.cr-tools{display:flex;align-items:center;gap:8px;margin:0 0 10px;flex-wrap:wrap}
.cr-cands{background:#fffdf6;border:1px solid #eee3c8;border-radius:10px;padding:10px 12px;margin-bottom:10px}
.cand-h{font-size:12px;color:#8a6d1f;margin-bottom:8px}
button.cand{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--line);border-radius:8px;padding:7px 10px;margin:0 0 6px;font:inherit;font-size:13px;cursor:pointer}
button.cand:hover{border-color:var(--yellow);background:#fffbe8}
button.cand b{font-weight:600}
button.cand .ca{color:var(--sub);font-size:12px;margin-left:8px}
button.cand .cs{float:right;color:#b08968;font-size:11px}
.search{width:100%;padding:9px 14px;border:1px solid var(--line);border-radius:10px;font:inherit;margin-bottom:12px;background:#fff}
.book-card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden;display:flex}
.bc-spine{width:6px;flex:0 0 6px}
.bc-body{flex:1;min-width:0}
.bh{padding:13px 16px 13px 12px;cursor:pointer;display:block}
.bh:hover{background:#fdfbf7}
.bt{font-weight:600;font-size:15px;line-height:1.45;word-break:break-word}
.ba{color:var(--sub);font-weight:400;font-size:13px;margin-left:8px;white-space:normal}
.bs{color:var(--sub);font-size:12px;display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap}
.prog{display:inline-flex;align-items:center;width:78px;height:5px;background:#efece5;border-radius:3px;flex:0 0 auto;overflow:hidden}
.pb{height:100%;background:var(--blue);border-radius:3px}
/* 进度百分比必须留在卡片里：以前用 position:absolute 又没给 .prog 定位，数字会掉到卡片外 */
.pv{font-size:11px;color:var(--sub);font-weight:400;white-space:nowrap}
.rd{color:#8a9a6b;font-size:11px}
.open{color:var(--blue);font-size:12px;text-decoration:none;margin-left:auto}
.bb{border-top:1px dashed var(--line);padding:4px 16px 12px}
.mark{padding:11px 0;border-bottom:1px dashed var(--line)}.mark:last-child{border:0}
.mm{color:var(--sub);font-size:12px;margin-bottom:3px}.mt{font-size:14px}
.highlight .mt{border-left:3px solid var(--yellow);padding-left:10px}
.thought .mt{border-left:3px solid var(--purple);padding-left:10px}
.ai{margin-top:7px;padding:7px 11px;background:#f4f8fd;border-left:3px solid var(--blue);border-radius:0 6px 6px 0;font-size:13px;color:#5b7fa6}
.empty{color:var(--sub);text-align:center;padding:16px}
/* ---- 章节：目录条 + 可折叠章节 ---- */
.cr-toc{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 12px;padding:8px 10px;background:#fbf8f2;border:1px solid var(--line);border-radius:10px}
.cr-toc .toc-l{font-size:11px;color:var(--sub)}
button.toc-i{background:#fff;border:1px solid var(--line);color:var(--ink);font-size:12px;font-weight:400;padding:4px 10px;border-radius:14px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.toc-i:hover{border-color:var(--yellow);background:#fffbe8}
button.toc-i.on{background:#fff3c4;border-color:var(--yellow);font-weight:600}
button.toc-i i{font-style:normal;color:var(--sub);font-size:10px;margin-left:5px}
button.toc-a{background:transparent;border:1px dashed var(--line);color:var(--sub);font-size:12px;padding:4px 10px;border-radius:14px;margin-left:auto}
.cr-ch{margin:0 0 2px}
.cth{margin:14px 0 6px;color:#6b6250;font-size:15px;cursor:pointer;display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px}
.cth:hover{background:#f7f2e6}
.cth .cth-n{font-size:11px;color:var(--sub);font-weight:400}
.cth .cth-a{margin-left:8px;color:#a09680;font-size:11px;line-height:1;transition:transform .15s}
.cr-ch.fold .cth-a{transform:rotate(-90deg)}
.cth.flash{background:#fff3c4}
.seg{padding:8px 10px;border-radius:8px;cursor:pointer;margin:2px 0}
.seg:hover{background:#fdf8ea}
.seg.hl{background:#fffbe8;border-left:3px solid var(--yellow)}
.seg.on{background:#fdf3d1;outline:1px solid var(--yellow)}
.seg-text{font-size:14px}
.seg-mm{font-size:11px;color:var(--sub);margin-bottom:2px}
.u-mark{margin-top:5px;font-size:12px;color:#9b8340}
.sync-bar{background:#fff6e0;border:1px solid #f0dfae;border-radius:8px;padding:8px 12px;font-size:12px;margin:12px 0 0;color:#8a6d1f;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sync-bar button{padding:4px 10px;font-size:12px}
.u-note{margin-top:5px;font-size:13px;background:#fdf6d8;border-left:3px solid var(--yellow);padding:5px 9px;border-radius:0 6px 6px 0}
.a-note{margin-top:5px;font-size:13px;background:#f4f8fd;border-left:3px solid var(--blue);padding:5px 9px;border-radius:0 6px 6px 0}
#editor{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
textarea{width:100%;min-height:56px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;margin:4px 0}
button{font:inherit;padding:7px 16px;border:0;border-radius:8px;background:var(--blue);color:#fff;cursor:pointer}
button.dl{background:#6ba26b}
button.sv{background:var(--blue)}
button.sv.done{background:#4a9d6a}
button.cx{background:#efece5;color:#6b6250}
button.sy{background:#c9825a}
.ed-row{display:flex;align-items:center;gap:8px;margin-top:2px}
.ed-row .hint{flex:1;font-size:11px}
/* 浮动提示：编辑器收起之后，「已写入服务器」也能看见 */
#cr-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:80%;background:rgba(44,42,38,.92);color:#fff;font-size:12px;padding:8px 16px;border-radius:20px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:20}
#cr-toast.on{opacity:1}
.hint.ok{color:#4a9d6a}
.hint.err{color:#c05050}
.cr-foot{display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:12px;border-top:1px dashed var(--line);flex-wrap:wrap}
.cr-foot .hint{flex:1;font-size:11px;min-width:160px}
details.imp{margin:10px 0 12px;border:1px solid var(--line);border-radius:10px;background:#fcfaf6;padding:8px 12px}
details.imp>summary{cursor:pointer;font-size:13px;color:var(--sub);list-style:none}
details.imp>summary::-webkit-details-marker{display:none}
details.imp>summary::before{content:'▸ ';color:var(--sub)}
details.imp[open]>summary::before{content:'▾ '}
.drop{margin-top:10px;border:2px dashed #d9d1c1;border-radius:10px;background:#fff;padding:20px 14px;text-align:center;color:var(--sub);font-size:13px}
.drop.over{border-color:var(--blue);background:#f2f7fd}
.drop-i{font-size:26px;margin-bottom:4px}
.drop .pick{color:var(--blue);text-decoration:underline;cursor:pointer}
.drop-s{font-size:11px;margin-top:6px;line-height:1.6}
.drop-s.err{color:#c05050}
.drop-s.ok{color:#4a9d6a}
.imp-note{font-size:11px;color:var(--sub);margin-top:8px;line-height:1.7}
.imp-note code{background:#f2efe8;padding:1px 5px;border-radius:4px}
#coread-json{margin-top:8px;padding:8px;background:#f6f4ee;border-radius:8px;font:11px/1.5 monospace;word-break:break-all;max-height:140px;overflow:auto;color:#7a7466}
footer{margin-top:26px;text-align:center;color:var(--sub);font-size:12px}

/* =========================================================================
   v2 · 共读看板重设计
   原则：暖纸底 + 双色语义（🟡 你 / 🔵 AI），层级靠留白和字重，不靠边框堆叠。
   全部规则挂在 #coread 作用域内，绝不外溢到书架页。
   ========================================================================= */
:root{
  --you:#CF9A15; --you-deep:#8A6410; --you-soft:#FDF7E6; --you-brd:#E8D6A2;
  --ai:#3F76B0;  --ai-deep:#2C5A8C;  --ai-soft:#F2F7FC;  --ai-brd:#CFE0EF;
  --both:#6B4A8F; --both-soft:#F8F3FC; --both-brd:#DCCBE8;
}
#coread.panel{background:transparent;border:0;padding:0;margin:0}

/* ---- 头部：书名 + 一句说明 ---- */
#coread .cr-head{display:block;padding:0}
#coread .cr-title{display:flex;align-items:center;gap:8px;font-size:19px;font-weight:800;letter-spacing:-.01em;color:var(--ink)}
#coread .cr-sub{display:block;font-weight:400;font-size:12px;color:var(--sub);margin-top:6px;line-height:1.7}

/* ---- 四档筛选：全部 / 我写的 / AI批的 / 两边都有 ---- */
#coread .cr-filters{display:flex;gap:4px;margin:12px 0 14px;padding:4px;
  background:var(--card);border:1px solid var(--line);border-radius:13px}
#coread .cr-filters button{flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;
  background:transparent;color:var(--sub);border:0;border-radius:10px;padding:8px 4px;
  font-size:12.5px;font-weight:600;white-space:nowrap;transition:background .15s,color .15s}
#coread .cr-filters button:hover{background:#f7f3ea}
#coread .cr-filters button i{font-style:normal;font-size:11px;font-weight:800;color:#57503f;
  background:#e7e0cf;border-radius:999px;padding:1px 6px;min-width:18px;text-align:center;line-height:1.5}
#coread .cr-filters button.on{background:var(--ink);color:#fff;box-shadow:0 2px 8px rgba(44,42,38,.16)}
#coread .cr-filters button.on i{background:rgba(255,255,255,.2);color:#fff}
#coread .cr-filters button.on[data-f="mine"]{background:var(--you);color:#3B2A00;box-shadow:0 2px 8px rgba(207,154,21,.28)}
#coread .cr-filters button.on[data-f="mine"] i{background:rgba(59,42,0,.14);color:#3B2A00}
#coread .cr-filters button.on[data-f="ai"]{background:var(--ai);box-shadow:0 2px 8px rgba(63,118,176,.26)}
#coread .cr-filters button.on[data-f="both"]{background:var(--both);box-shadow:0 2px 8px rgba(107,74,143,.24)}
/* 小圆点：类名刻意避开 .you / .ai / .both —— 全局还有一条老 .ai 规则会套到圆点上，
   把 7px 的点撑成 29×21 的蓝椭圆（踩过）。选择器也收进 .cr-filters 里，双重保险。 */
#coread .cr-filters .dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;display:inline-block;
  padding:0;margin:0;box-sizing:border-box;border:0}
#coread .cr-filters .dot.d-you{background:var(--you)}
#coread .cr-filters .dot.d-ai{background:var(--ai)}
#coread .cr-filters .dot.d-both{background:linear-gradient(135deg,var(--you) 0 50%,var(--ai) 50% 100%)}
#coread .cr-filters button.on .dot.d-you{background:#3B2A00}
#coread .cr-filters button.on .dot.d-ai,#coread .cr-filters button.on .dot.d-both{background:#fff}

/* ---- 章节：左侧短竖条 + 更轻的标题 ---- */
#coread .cr-ch{margin:0 0 2px}
#coread .cth{margin:20px 0 6px;padding:7px 10px;font-size:14px;font-weight:700;color:#6b6250;border-radius:9px;gap:8px}
#coread .cth::before{content:"";width:3px;height:13px;border-radius:2px;background:var(--you);flex:0 0 3px}
#coread .cth:hover{background:#f6f1e6}
#coread .cth .cth-n{font-size:11px;color:#a89f8d;font-weight:500}
#coread .cth.flash{background:#FFF3C9}

/* ---- 段落卡：白底轻浮起，划线那几张染成暖黄 ---- */
#coread .seg{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:13px 16px;margin:10px 0;cursor:pointer;
  box-shadow:0 1px 2px rgba(44,42,38,.03);
  transition:border-color .15s,box-shadow .18s,transform .18s}
#coread .seg:hover{border-color:#dcd5c6;box-shadow:0 4px 16px rgba(44,42,38,.07);transform:translateY(-1px)}
#coread .seg.hl{background:linear-gradient(180deg,#FFFEF9 0%,#FFF9E6 100%);border-color:var(--you-brd)}
#coread .seg.on{border-color:var(--you);box-shadow:0 0 0 3px rgba(207,154,21,.15),0 6px 20px rgba(44,42,38,.08);transform:none}
#coread .seg.hit{animation:crHit 1.1s ease-out}
@keyframes crHit{0%{box-shadow:0 0 0 0 rgba(63,118,176,.55)}100%{box-shadow:0 0 0 14px rgba(63,118,176,0)}}
#coread .seg-mm{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:10.5px;color:#a89f8d;margin-bottom:7px;letter-spacing:.03em}
#coread .seg-text{font-size:15.5px;line-height:1.85;color:#3a3630;letter-spacing:.004em}

/* ---- 两侧笔迹：形状相同、颜色不同，一眼分得开 ---- */
#coread .u-note,#coread .a-note{position:relative;margin-top:8px;padding:9px 12px;
  font-size:13.5px;line-height:1.78;border-radius:0 10px 10px 0;white-space:pre-wrap;word-break:break-word}
#coread .u-note{background:var(--you-soft);border-left:3px solid var(--you);color:#4A3A12}
#coread .a-note{background:var(--ai-soft);border-left:3px solid var(--ai);color:#24455F}
#coread .u-mark{margin-top:7px;font-size:11.5px;color:var(--you-deep);font-weight:600;letter-spacing:.02em}
/* 批注里的「见第 812 段」—— AI 读过整本的证据，点一下就跳过去 */
#coread .seg-ref{color:var(--ai-deep);font-weight:700;text-decoration:none;
  border-bottom:1px dashed var(--ai-brd);cursor:pointer;padding:0 1px}
#coread .seg-ref:hover{background:var(--ai-soft);border-bottom-style:solid}

/* ---- 编辑器：像一张纸，不像一个表单 ---- */
#editor{margin:8px 0 4px;border:1px solid var(--you-brd);border-radius:14px;
  background:#FFFDF7;padding:14px 15px;box-shadow:0 6px 22px rgba(44,42,38,.07)}
#editor .mm{font-size:11px;color:#a89f8d;margin-bottom:2px}
#editor textarea{border:1px solid #e7dfd0;background:#fff;border-radius:10px;
  padding:10px 12px;font-size:14px;line-height:1.75;margin:6px 0;resize:vertical}
#editor textarea:focus{outline:0;border-color:var(--you);box-shadow:0 0 0 3px rgba(207,154,21,.16)}
/* 🔵 只读区：一眼看出「这段不是你写的」，别让人以为能改 */
#editor .ed-ro{margin-top:10px}
#editor .ed-ro-t{display:block;font-size:11px;font-weight:700;color:var(--ai-deep);letter-spacing:.02em;margin-bottom:2px}
#editor textarea[readonly]{background:var(--ai-soft);border-color:var(--ai-brd);color:#24455F;
  resize:none;cursor:default}
#editor textarea[readonly]:focus{border-color:var(--ai-brd);box-shadow:none}

/* ---- 页尾：撤销 / 导出 ---- */
#coread .cr-foot{gap:10px;margin-top:20px;padding-top:14px}
#coread .undo-btn{background:#fff;color:var(--both);border:1px solid var(--both-brd);font-weight:600;font-size:12.5px;padding:7px 14px}
#coread .undo-btn:hover{background:var(--both-soft)}
#coread .undo-btn:disabled{opacity:.5;cursor:default}
#coread .dl{background:var(--ink);color:#fff;font-size:12.5px;padding:7px 14px}
#coread .sy.ghost{background:var(--card);color:var(--sub);border:1px solid var(--line);font-size:12.5px;padding:7px 14px}
#coread .sy.ghost:hover{border-color:#d6cdba;color:var(--ink)}
#coread .cr-filters button, #coread .cth, #coread .seg{ -webkit-tap-highlight-color:transparent }

/* ---- 手机：这才是主场景 ---- */
@media (max-width:680px){
  body{padding:16px 10px 92px}
  #coread .cr-title{font-size:17px}
  #coread .cr-filters button{padding:7px 2px;font-size:11.5px;gap:3px}
  #coread .cr-filters button i{font-size:10.5px;padding:1px 5px;min-width:17px}
  #coread .seg{padding:12px 13px;border-radius:13px}
  #coread .seg-text{font-size:15px;line-height:1.8}
  #coread .u-note,#coread .a-note{font-size:13px;padding:8px 10px}
  #editor{padding:12px}
}
`;

// ---------------------------------------------------------------------------
// 渲染：把采集结果 + 可选共读数据拼成自包含 HTML（结构对齐原版）
// ---------------------------------------------------------------------------
export function render({ shelf, nbBooks, nbTotal, details }, { generatedAt, coread = null, notes = null } = {}) {
  // ---- 聚合每本书（原版口径：只保留有划线/想法的书，按最近笔记时间倒序）----
  const perBook = (nbBooks || [])
    .map((nb) => {
      const meta = nb.book || {};
      const d = details?.[nb.bookId] || {};
      const bm = d.bookmark || {};
      const hl = Array.isArray(bm.updated) ? bm.updated : [];
      const chMeta = Array.isArray(bm.chapters) ? bm.chapters : [];
      const chMap = Object.fromEntries(chMeta.map((c) => [c.chapterUid, c.title]));
      const rv = d.review || {};
      const th = Array.isArray(rv.reviews) ? rv.reviews : [];

      const items = [];
      for (const h of hl)
        items.push({ t: "hl", ch: chMap[h.chapterUid] || "", text: h.markText || "", date: fmtDate(h.createTime) });
      for (const t of th) {
        const r = t.review || {};
        const body = r.abstract || stripTags(r.htmlContent);
        items.push({ t: "th", ch: chMap[r.chapterUid] || "", text: body, date: fmtDate(r.createTime) });
      }

      const lastTs = nb.sort || 0;
      const rp = nb.readingProgress;
      const progress = rp && typeof rp === "object" && rp.percent != null ? rp.percent : typeof rp === "number" ? rp : null;

      return {
        title: meta.title || "?",
        author: meta.author || "",
        deepLink: meta.deepLink || "",
        hl: hl.length,
        th: th.length,
        progress,
        lastTs,
        lastDate: lastTs ? fmtDate(lastTs) : "",
        items,
      };
    })
    .filter((b) => b.hl + b.th > 0)
    .sort((a, b) => b.lastTs - a.lastTs);

  const totalHl = perBook.reduce((s, b) => s + b.hl, 0);
  const totalTh = perBook.reduce((s, b) => s + b.th, 0);
  const summary = `共 <b>${perBook.length}</b> 本有笔记 · <b>${totalHl}</b> 条划线 · <b>${totalTh}</b> 条想法`;

  // ---- 书卡 ----
  const cards = perBook
    .map((b) => {
      const itemsHtml =
        b.items
          .map(
            (it) =>
              `<div class="mark ${it.t === "hl" ? "highlight" : "thought"}">` +
              `<div class="mm">${it.t === "hl" ? "🟡 划线" : "💭 想法"} · ${esc(it.ch)}${it.date ? " · " + it.date : ""}</div>` +
              `<div class="mt">${esc(it.text)}</div>` +
              `<div class="ai">🔵 <i>AI批注区</i></div></div>`
          )
          .join("") || '<div class="empty">无笔记</div>';
      const prog =
        b.progress != null
          ? `<span class="prog"><span class="pb" style="width:${Math.min(100, b.progress)}%"></span></span><b class="pv">${b.progress}%</b>`
          : "";
      const recent = b.lastDate ? `<span class="rd">🕒 ${b.lastDate}</span>` : "";
      const link = b.deepLink ? `<a class="open" href="${esc(b.deepLink)}" target="_blank" rel="noopener">阅读 ↗</a>` : "";
      const color = spineColor(b.title);
      return (
        `<div class="book-card"><div class="bc-spine" style="background:linear-gradient(180deg,${color},${color}cc)"></div>` +
        `<div class="bc-body"><div class="bh" onclick="tg(this)">` +
        `<div class="bt">${esc(b.title)}<span class="ba">${esc(b.author)}</span></div>` +
        `<div class="bs">🟡 ${b.hl} · 💭 ${b.th}${prog}${recent}${link}</div>` +
        `</div><div class="bb" hidden>${itemsHtml}</div></div></div>`
      );
    })
    .join("");

  const crHtml = coreadHtml(coread, notes);
  const hasCoread = !!(crHtml && coread);
  // 注入前端的批注集（服务器 notes 为准，段落自带的 user/ai 兜底）——
  // 前端拿它判断「本机草稿是否比服务器新」，决定要不要提示同步
  const crInit = JSON.stringify(
    hasCoread
      ? Object.fromEntries(
          coread.segments
            .filter((s) => s.user || s.ai || s.mark || notes?.[s.id])
            .map((s) => {
              const n = notes?.[s.id] || {};
              const rec = { user: n.user ?? s.user ?? "", ai: n.ai ?? s.ai ?? "" };
              if (n.mark ?? s.mark) rec.mark = true;
              // 前端算「撤销上一批」和元信息日期要靠这两个字段
              if (n.ts) rec.ts = n.ts;
              if (n.batch) rec.batch = n.batch;
              return [s.id, rec];
            })
        )
      : {}
  );

  const bookName = hasCoread ? coread.meta?.book || "?" : "";
  const crBook = hasCoread
    ? `<div class="cr-book">当前共读：<b>${esc(cleanBookName(bookName))}</b>` +
      `<span class="cr-book-sub">全文 ${coread.meta?.totalSegments ?? coread.segments.length} 段已存服务器 · 本页只展示划线/批注 · 保存即写服务器</span></div>`
    : `<div class="cr-book">还没有共读书目` +
      `<span class="cr-book-sub">把 EPUB 拖进下面方框，自动拆段并保存（本机解析，不上传原书）</span></div>`;

  // 导入原书：拖入 EPUB → 浏览器本地拆段 → POST /coread。有书时折叠起来。
  const importBlock =
    `<details class="imp"${hasCoread ? "" : " open"}>` +
    `<summary>📥 导入原书（把 EPUB 拖进来自动拆段）</summary>` +
    `<div id="drop" class="drop">` +
    `<div class="drop-i">📚</div>` +
    `<div>把 <b>EPUB 文件</b>拖到这里，或 <a href="#" class="pick" id="epub-pick">选择文件</a></div>` +
    `<input type="file" id="epub-file" accept=".epub,application/epub+zip" hidden>` +
    `<div class="drop-s" id="up-status">拆段在你自己的设备上完成，只会把段落 JSON 传给服务器，EPUB 原件不出本机</div>` +
    `</div>` +
    `<div class="imp-note">导入新书会替换当前共读的那本。命令行同样可以：` +
    `<code>python tools/coread-upload.py 书.epub --url &lt;本页地址&gt;</code></div>` +
    `</details>`;

  const tabs =
    `<div class="tabs">\n` +
    `  <button class="tab${hasCoread ? "" : " off"}" id="tab-coread" onclick="go('coread')">📖 共读</button>\n` +
    `  <button class="tab${hasCoread ? " off" : ""}" id="tab-shelf" onclick="go('shelf')">📚 书架与笔记</button>\n` +
    `</div>`;

  // 有书的时候「导入原书」是低频动作，压到页尾；没书时它是唯一入口，必须留在顶部。
  const coreadPage =
    `<div id="page-coread" class="page"${hasCoread ? "" : " hidden"}>${crBook}` +
    (hasCoread ? "" : importBlock) +
    (crHtml || '<div class="panel"><div class="empty">还没有共读书目 —— 上面拖入一本 EPUB 即可</div></div>') +
    (hasCoread ? importBlock : "") +
    `</div>`;

  const shelfPage =
    `<div id="page-shelf" class="page"${hasCoread ? " hidden" : ""}>\n` +
    `<div class="sum-line">${summary}</div>\n` +
    `<input class="search" placeholder="搜索书名 / 作者 / 划线内容…">\n` +
    `${cards}\n` +
    (hasCoread ? "" : `<div class="empty">📥 想把一本 EPUB 变成共读页？切到「📖 共读」Tab 拖进去就行</div>`) +
    `</div>`;

  const date = generatedAt || new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>共读看板</title><style>${CSS}</style></head><body><div class="wrap">
<h1>📖 共读看板</h1>
<div class="sub">你的划线 🟡 · 想法 💭 · AI批注 🔵 · 生成于 ${date}</div>
${tabs}
${coreadPage}
${shelfPage}
<footer>微信读书官方 Agent Gateway · 双色共读：🟡你 🔵AI</footer>
<script>
var COREAD_NOTES=${crInit};
function tg(h){var b=h.nextElementSibling;b.hidden=!b.hidden}
var sb=document.querySelector('.search');
sb.addEventListener('input',function(){var q=sb.value.trim().toLowerCase();
document.querySelectorAll('.book-card').forEach(function(c){
var hit=!q||c.textContent.toLowerCase().includes(q);
c.style.display=hit?'':'none';
if(q&&hit){c.querySelector('.bb').hidden=false;
c.querySelectorAll('.mark').forEach(function(m){m.style.display=m.querySelector('.mt').textContent.toLowerCase().includes(q)?'':'none'})}
else{c.querySelectorAll('.mark').forEach(function(m){m.style.display=''})}
})});
${COREAD_JS}
${EPUB_PARSE_JS}
${IMPORT_JS}
function go(w){
  document.querySelectorAll('.page').forEach(function(p){p.hidden=true});
  document.getElementById('page-'+w).hidden=false;
  document.querySelectorAll('.tab').forEach(function(t){t.classList.add('off')});
  document.getElementById('tab-'+w).classList.remove('off');
  window.scrollTo({top:0});
}
</script>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// 一步到位：采集 + 渲染
//   opts.coread = { meta:{book,totalSegments}, segments:[{id,ch,chTitle,text,user,ai}] }
// ---------------------------------------------------------------------------
export async function buildDashboard(gw, opts = {}) {
  const data = await collect(gw, opts);
  return render(data, opts);
}
