/**
 * 共读看板 · 自包含 HTML 生成器
 *
 * 与原版 weread_dashboard.py 的产物（demo-dashboard.html）**结构 1:1 对齐**：
 *   顶栏 → 双 Tab（📖 共读 / 📚 书架与笔记）
 *   - 共读页：EPUB 逐段对照，点任意段落 → 写 🟡你的 / 🔵助手的批注，可下载 JSON
 *   - 书架页：汇总行 + 搜索 + 书脊色条书卡（🟡 划线 / 💭 想法 / 🔵 助手批注区）
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

// ---------------------------------------------------------------------------
// 采集：并发拉基础数据，再按批拉每本书的划线 + 想法
// ---------------------------------------------------------------------------
export async function collect(gw, { maxBooks = 12 } = {}) {
  const [shelf, stats, notebooks] = await Promise.all([
    gw("/shelf/sync", {}),
    gw("/readdata/detail", { mode: "overall" }).catch(() => null),
    gw("/user/notebooks", { count: 50 }),
  ]);

  const allNb = notebooks.books || notebooks.notebooks || [];
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
function coreadHtml(coread) {
  if (!coread || !Array.isArray(coread.segments) || !coread.segments.length) return "";
  const chMap = {};
  for (const s of coread.segments) (chMap[s.ch] ||= []).push(s);

  const parts = [
    '<div class="panel" id="coread">',
    '<h3 class="cr-head">📖 共读模式（原版书对照）<span class="cr-sub">点任意段落 → 写 🟡你的 / 🔵助手的批注</span></h3>',
  ];
  for (const ci of Object.keys(chMap).sort((a, b) => a - b)) {
    parts.push(`<h4 class="cth">${esc(chMap[ci][0]?.chTitle || "")}</h4>`);
    for (const s of chMap[ci]) {
      const u = s.user ? `<div class="u-note">🟡 你：${esc(s.user)}</div>` : "";
      const a = s.ai ? `<div class="a-note">🔵 助手：${esc(s.ai)}</div>` : "";
      parts.push(
        `<div class="seg" id="seg-${s.id}" onclick="pick(${s.id})">` +
          `<div class="seg-text">${esc(s.text)}</div>${u}${a}</div>`
      );
    }
  }
  parts.push(`<div id="editor" hidden>
      <div id="edit-which" class="mm"></div>
      <textarea id="edit-user" placeholder="🟡 你的批注…" oninput="autoSave()"></textarea>
      <textarea id="edit-ai" placeholder="🔵 助手的批注…" oninput="autoSave()"></textarea>
      <div class="ed-row">
        <button class="sv" onclick="saveNow()" id="btn-save">💾 保存</button>
        <span class="hint" id="save-hint">输入即自动暂存到本机；点「保存」立即写入</span>
      </div>
    </div>`);
  // 页尾操作条：整页批注统一在这里导出
  parts.push(`<div class="cr-foot">
      <button class="dl" onclick="downloadNotes()">⬇ 下载批注</button>
      <span class="hint" id="foot-hint"></span>
    </div></div>`);
  return parts.join("");
}

// 共读交互 JS（与原版 COREAD_JS 一致）
const COREAD_JS = `
function renderNotes(el, n){
  var un=el.querySelector('.u-note'); if(un)un.remove();
  var an=el.querySelector('.a-note'); if(an)an.remove();
  if(n.user){var u=document.createElement('div');u.className='u-note';u.textContent='🟡 你：'+n.user;el.appendChild(u)}
  if(n.ai){var a=document.createElement('div');a.className='a-note';a.textContent='🔵 助手：'+n.ai;el.appendChild(a)}
}
function persist(){
  try{ localStorage.setItem('coread-notes', JSON.stringify(COREAD_NOTES)); }catch(e){}
}
function loadPersisted(){
  try{
    var s=localStorage.getItem('coread-notes');
    if(!s) return;
    var saved=JSON.parse(s);
    for(var k in saved){
      if(!COREAD_NOTES[k] || (!COREAD_NOTES[k].user && !COREAD_NOTES[k].ai) || saved[k].user || saved[k].ts > (COREAD_NOTES[k].ts||0))
        COREAD_NOTES[k]=saved[k];
    }
    for(var k in COREAD_NOTES){
      var el=document.getElementById('seg-'+k);
      if(el) renderNotes(el, COREAD_NOTES[k]);
    }
  }catch(e){}
}
function pick(id){
  document.querySelectorAll('.seg.on').forEach(function(x){x.classList.remove('on')});
  var el=document.getElementById('seg-'+id); if(!el) return; el.classList.add('on');cur=id;
  var ed=document.getElementById('editor');
  el.after(ed); ed.hidden=false;            // 编辑器跟随点选段落
  document.getElementById('edit-which').textContent='第 '+id+' 段 · '+(el.querySelector('.seg-text').textContent.slice(0,40))+'…';
  var n=COREAD_NOTES[String(id)]||{};
  document.getElementById('edit-user').value=n.user||'';
  document.getElementById('edit-ai').value=n.ai||'';
  setSaveHint('已载入本机暂存内容');
}
// 把当前编辑框写进内存 + localStorage（空白则视为删除该段批注）
function commitNote(){
  if(cur==null) return;
  var u=document.getElementById('edit-user').value, a=document.getElementById('edit-ai').value;
  var k=String(cur), el=document.getElementById('seg-'+cur);
  if(u.trim()||a.trim()){
    COREAD_NOTES[k]={user:u,ai:a,ts:Date.now()};
    if(el)renderNotes(el,COREAD_NOTES[k]);
  }else{
    delete COREAD_NOTES[k];
    if(el)renderNotes(el,{});
  }
  persist(); refreshFoot();
}
function noteCount(){
  var n=0; for(var k in COREAD_NOTES){var v=COREAD_NOTES[k]; if(v&&(v.user||v.ai))n++} return n;
}
function refreshFoot(){
  var el=document.getElementById('foot-hint');
  if(el) el.textContent='已暂存 '+noteCount()+' 条批注（存在本机浏览器）· 下载 JSON 发给助手即长期保存';
}
function setSaveHint(msg,ok){
  var h=document.getElementById('save-hint'); if(!h) return;
  h.textContent=msg;
  h.className='hint'+(ok?' ok':'');
}
function saveNow(){
  commitNote();
  var b=document.getElementById('btn-save');
  if(b){var old=b.textContent;b.textContent='✓ 已保存';b.classList.add('done');setTimeout(function(){b.textContent=old;b.classList.remove('done')},1200)}
  setSaveHint('✓ 已保存到本机 · '+new Date().toLocaleTimeString(),true);
}
function downloadNotes(){
  commitNote();
  var blob=new Blob([JSON.stringify(COREAD_NOTES,null,2)],{type:'application/json'});
  var aEl=document.createElement('a');
  aEl.href=URL.createObjectURL(blob);
  aEl.download='coread-notes.json';
  aEl.click();
  URL.revokeObjectURL(aEl.href);
}
// 输入即自动保存（停顿 600ms 后触发），保存按钮只是显式确认
var _t=null;
function autoSave(){
  if(cur==null)return;
  clearTimeout(_t);
  _t=setTimeout(function(){commitNote();setSaveHint('已自动暂存 · 未点保存')},600);
}
refreshFoot();
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
  var spine=[];
  if(opfName){
    var opf=await entryText(files[opfName]);
    var base=opfName.replace(/[^\/]*$/,'');
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
  return {meta:{book:fileName||'',chapters:chapters,totalSegments:segments.length},segments:segments};
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
body{background:var(--bg);color:var(--ink);font:15px/1.7 "PingFang SC","Microsoft YaHei",sans-serif;padding:28px 14px 80px}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:22px}.sub{color:var(--sub);font-size:13px;margin:4px 0 14px}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{flex:1;font:inherit;font-size:14px;font-weight:600;padding:10px 0;border:1px solid var(--blue);border-radius:10px;background:var(--card);color:var(--ink);cursor:pointer;box-shadow:0 1px 4px rgba(74,144,217,.15)}
.tab.off{background:#e9e4da;color:#a39c8c;font-weight:400;border-color:#e0dacd;box-shadow:none}
.sum-line{color:var(--sub);font-size:13px;margin-bottom:12px}
.sum-line b{color:var(--ink)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:18px}
.panel h3{font-size:14px;color:var(--sub);margin-bottom:10px}.hint{font-weight:400;font-size:11px;margin-left:8px}
.cr-book{background:#f4f8fd;border:1px solid #d8e5f4;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:14px}
.cr-book-sub{display:block;color:var(--sub);font-size:11px;margin-top:2px}
.cr-head{display:block}
.cr-sub{display:block;font-weight:400;font-size:12px;color:var(--sub);margin-top:3px}
.search{width:100%;padding:9px 14px;border:1px solid var(--line);border-radius:10px;font:inherit;margin-bottom:12px;background:#fff}
.book-card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden;display:flex}
.bc-spine{width:6px;flex:0 0 6px}
.bc-body{flex:1;min-width:0}
.bh{padding:13px 16px 13px 12px;cursor:pointer;display:block}
.bh:hover{background:#fdfbf7}
.bt{font-weight:600;font-size:15px;line-height:1.45;word-break:break-word}
.ba{color:var(--sub);font-weight:400;font-size:13px;margin-left:8px;white-space:normal}
.bs{color:var(--sub);font-size:12px;display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap}
.prog{display:inline-flex;align-items:center;width:78px;height:5px;background:#efece5;border-radius:3px;flex:0 0 auto}
.pb{height:100%;background:var(--blue);border-radius:3px}
.prog b{position:absolute;left:calc(100% + 6px);font-size:11px;color:var(--sub);font-weight:400;white-space:nowrap}
.rd{color:#8a9a6b;font-size:11px}
.open{color:var(--blue);font-size:12px;text-decoration:none;margin-left:auto}
.bb{border-top:1px dashed var(--line);padding:4px 16px 12px}
.mark{padding:11px 0;border-bottom:1px dashed var(--line)}.mark:last-child{border:0}
.mm{color:var(--sub);font-size:12px;margin-bottom:3px}.mt{font-size:14px}
.highlight .mt{border-left:3px solid var(--yellow);padding-left:10px}
.thought .mt{border-left:3px solid var(--purple);padding-left:10px}
.ai{margin-top:7px;padding:7px 11px;background:#f4f8fd;border-left:3px solid var(--blue);border-radius:0 6px 6px 0;font-size:13px;color:#5b7fa6}
.empty{color:var(--sub);text-align:center;padding:16px}
.cth{margin:14px 0 6px;color:#6b6250;font-size:15px}
.seg{padding:8px 10px;border-radius:8px;cursor:pointer;margin:2px 0}
.seg:hover{background:#fdf8ea}
.seg.on{background:#fdf3d1;outline:1px solid var(--yellow)}
.seg-text{font-size:14px}
.u-note{margin-top:5px;font-size:13px;background:#fdf6d8;border-left:3px solid var(--yellow);padding:5px 9px;border-radius:0 6px 6px 0}
.a-note{margin-top:5px;font-size:13px;background:#f4f8fd;border-left:3px solid var(--blue);padding:5px 9px;border-radius:0 6px 6px 0}
#editor{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
textarea{width:100%;min-height:56px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;margin:4px 0}
button{font:inherit;padding:7px 16px;border:0;border-radius:8px;background:var(--blue);color:#fff;cursor:pointer}
button.dl{background:#6ba26b}
button.sv{background:var(--blue)}
button.sv.done{background:#4a9d6a}
.ed-row{display:flex;align-items:center;gap:8px;margin-top:2px}
.ed-row .hint{flex:1;font-size:11px}
.hint.ok{color:#4a9d6a}
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
`;

// ---------------------------------------------------------------------------
// 渲染：把采集结果 + 可选共读数据拼成自包含 HTML（结构对齐原版）
// ---------------------------------------------------------------------------
export function render({ shelf, nbBooks, nbTotal, details }, { generatedAt, coread = null } = {}) {
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
              `<div class="ai">🔵 <i>助手批注区</i></div></div>`
          )
          .join("") || '<div class="empty">无笔记</div>';
      const prog =
        b.progress != null
          ? `<div class="prog"><div class="pb" style="width:${Math.min(100, b.progress)}%"></div><b>${b.progress}%</b></div>`
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

  const crHtml = coreadHtml(coread);
  const hasCoread = !!(crHtml && coread);
  const crInit = JSON.stringify(
    hasCoread
      ? Object.fromEntries(coread.segments.map((s) => [s.id, { user: s.user || "", ai: s.ai || "" }]))
      : {}
  );

  const bookName = hasCoread ? coread.meta?.book || "?" : "";
  const crBook = hasCoread
    ? `<div class="cr-book">当前共读：<b>${esc(bookName)}</b>` +
      `<span class="cr-book-sub">批注暂存在本机浏览器；页尾「⬇ 下载批注」导出 JSON</span></div>`
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

  const coreadPage =
    `<div id="page-coread" class="page"${hasCoread ? "" : " hidden"}>${crBook}${importBlock}` +
    (crHtml || '<div class="panel"><div class="empty">还没有共读书目 —— 上面拖入一本 EPUB 即可</div></div>') +
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
<div class="sub">你的划线 🟡 · 想法 💭 · AI 批注 🔵 · 生成于 ${date}</div>
${tabs}
${coreadPage}
${shelfPage}
<footer>微信读书官方 Agent Gateway · 双色共读：🟡你 🔵AI</footer>
<script>
var COREAD_NOTES=${crInit};
var cur=null;
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
loadPersisted();
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
