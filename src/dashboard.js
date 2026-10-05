/**
 * 共读书架看板 · 自包含 HTML 生成器
 *
 * 纯函数，不依赖任何平台 API —— Cloudflare Workers 版与 Node 版共用同一份。
 * 数据全部来自微信读书官方网关（经注入的 gw 适配器），不读写任何本地文件。
 *
 *   gw: (apiName, params) => Promise<json>   // 由各形态自己注入（Worker 带 env；Node 从环境变量取 key）
 *
 * 子请求预算：读免费版 Workers（单请求上限 50 个子请求）设了 maxBooks 上限，
 * 每本书 2 个子请求（划线 + 想法），基础 3 个（书架/统计/笔记本）。
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
  ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—";

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

// ---------------------------------------------------------------------------
// 渲染：把采集结果拼成一个自包含 HTML
// ---------------------------------------------------------------------------
export function render({ shelf, stats, nbBooks, nbTotal, details }, { generatedAt } = {}) {
  const books = shelf?.books || [];
  const rd = stats?.overall || stats || {};

  const perBook = nbBooks
    .map((nb) => {
      const meta = nb.book || {};
      const d = details[nb.bookId] || {};
      const bm = d.bookmark || {};
      const hl = bm.updated || bm.items || [];
      const rv = d.review || {};
      const th = Array.isArray(rv.reviews) ? rv.reviews : [];
      const chMeta = bm.chapters || [];
      const chMap = Object.fromEntries(chMeta.map((c) => [c.chapterUid, c.title]));

      const items = [];
      for (const h of hl) {
        items.push({
          type: "highlight",
          chapterUid: h.chapterUid,
          chapterTitle: chMap[h.chapterUid] || "",
          text: h.markText || "",
          createAt: h.createTime,
          range: h.range,
        });
      }
      for (const t of th) {
        const r = t.review || {};
        const cu = r.chapterUid ?? t.chapterUid;
        items.push({
          type: "thought",
          chapterUid: cu,
          chapterTitle: chMap[cu] || "",
          text:
            r.abstract ||
            String(r.htmlContent || "").replace(/<[^>]+>/g, "").trim(),
          createAt: r.createTime,
          range: r.range,
        });
      }
      items.sort(
        (a, b) =>
          (a.chapterUid || 0) - (b.chapterUid || 0) ||
          String(a.range ?? "").localeCompare(String(b.range ?? ""))
      );

      const prog = nb.readingProgress || {};
      return {
        bookId: nb.bookId,
        title: meta.title || nb.title || "未知书名",
        author: meta.author || nb.author || "",
        deepLink: meta.deepLink || nb.deepLink || "",
        highlightCount: hl.length,
        thoughtCount: th.length,
        progress: prog.percent != null ? prog : null,
        items,
      };
    })
    .sort(
      (a, b) =>
        b.highlightCount + b.thoughtCount - (a.highlightCount + a.thoughtCount)
    );

  const totalHl = perBook.reduce((s, b) => s + b.highlightCount, 0);
  const totalTh = perBook.reduce((s, b) => s + b.thoughtCount, 0);

  // 阅读热力图
  const heatArr = rd.readStat || rd.readTimes || [];
  const heat = heatArr
    .map((x) => ({
      date: fmtDate(x.date ?? x.dt ?? x.time),
      minutes: Math.round((x.readTime ?? x.time ?? 0) / 60),
    }))
    .filter((x) => x.date);
  const maxHeat = Math.max(1, ...heat.map((d) => d.minutes));
  const topBooks = (rd.preferBooks || []).slice(0, 5);

  const cards = perBook
    .map((b) => {
      const itemsHtml = b.items
        .map(
          (it, i) => `
    <div class="mark ${it.type}">
      <div class="mark-meta">${it.type === "highlight" ? "🟡 划线" : "💭 想法"} · ${esc(it.chapterTitle)}${it.createAt ? " · " + fmtDate(it.createAt) : ""}</div>
      <div class="mark-text">${esc(it.text)}</div>
      <div class="ai-slot">🔵 <i>AI 批注区（等我们一起读到这段时填上）</i></div>
    </div>`
        )
        .join("");
      const progBar = b.progress
        ? `<div class="prog"><div class="prog-bar" style="width:${Math.min(100, b.progress.percent)}%"></div><span>${b.progress.percent}%</span></div>`
        : "";
      const link = b.deepLink
        ? `<a class="open" href="${esc(b.deepLink)}" target="_blank" rel="noopener">打开阅读 ↗</a>`
        : "";
      return `
  <div class="book-card" id="book-${esc(b.bookId)}">
    <div class="book-head" onclick="toggleBook(this)">
      <div class="book-title">${esc(b.title)}<span class="book-author">${esc(b.author)}</span></div>
      <div class="book-stats">🟡 ${b.highlightCount} · 💭 ${b.thoughtCount} ${progBar} ${link}</div>
    </div>
    <div class="book-body" hidden>${itemsHtml || '<div class="empty">这本书还没有笔记</div>'}</div>
  </div>`;
    })
    .join("");

  const heatCells = heat
    .map((d) => {
      const lvl = d.minutes === 0 ? 0 : Math.min(4, Math.ceil((d.minutes / maxHeat) * 4));
      return `<div class="cell l${lvl}" title="${d.date}：${d.minutes} 分钟"></div>`;
    })
    .join("");

  const topHtml = topBooks.length
    ? topBooks
        .map((b, i) => {
          const t = b.book?.title || b.title || "—";
          return `<div class="top-row"><span class="top-rank">${i + 1}</span><span class="top-title">${esc(t)}</span><span class="top-time">${fmtTime(b.readTime ?? b.time)}</span></div>`;
        })
        .join("")
    : '<div class="empty">暂无数据</div>';

  const date = generatedAt || new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>共读看板 · WeRead × AI</title>
<style>
:root { --bg:#faf7f2; --card:#fff; --ink:#2c2a26; --sub:#8a8578; --yellow:#f5c518; --blue:#4a90d9; --purple:#9b6bd3; --line:#e8e2d6; }
* { box-sizing:border-box; margin:0; }
body { background:var(--bg); color:var(--ink); font:15px/1.7 "PingFang SC","Microsoft YaHei",sans-serif; padding:32px 16px 80px; }
.wrap { max-width:860px; margin:0 auto; }
h1 { font-size:22px; font-weight:700; letter-spacing:.5px; }
.sub { color:var(--sub); font-size:13px; margin:4px 0 24px; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:20px; }
.kpi { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.kpi b { display:block; font-size:22px; }
.kpi span { color:var(--sub); font-size:12px; }
.panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:20px; }
.panel h3 { font-size:14px; color:var(--sub); font-weight:600; margin-bottom:10px; }
.heat { display:grid; grid-template-columns:repeat(auto-fill,minmax(13px,1fr)); gap:3px; }
.cell { aspect-ratio:1; border-radius:3px; background:#efece5; }
.cell.l1 { background:#cfe3f7; } .cell.l2 { background:#a3cbef; } .cell.l3 { background:#6fa8de; } .cell.l4 { background:#3d7fc1; }
.cell:hover { outline:2px solid #4a90d9; }
.top-row { display:flex; align-items:baseline; gap:10px; padding:4px 0; font-size:14px; }
.top-rank { color:var(--sub); width:18px; }
.top-time { margin-left:auto; color:var(--sub); font-size:12px; }
.search { width:100%; padding:9px 14px; border:1px solid var(--line); border-radius:10px; font:inherit; margin-bottom:14px; background:#fff; }
.book-card { background:var(--card); border:1px solid var(--line); border-radius:12px; margin-bottom:12px; overflow:hidden; }
.book-head { padding:14px 18px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.book-head:hover { background:#fdfbf7; }
.book-title { font-weight:600; font-size:15px; }
.book-author { color:var(--sub); font-weight:400; font-size:13px; margin-left:8px; }
.book-stats { color:var(--sub); font-size:12px; white-space:nowrap; display:flex; align-items:center; gap:8px; }
.prog { display:inline-block; width:80px; height:5px; background:#efece5; border-radius:3px; position:relative; }
.prog-bar { height:100%; background:var(--blue); border-radius:3px; }
.prog span { position:absolute; left:calc(100% + 6px); top:-5px; font-size:11px; }
.open { color:var(--blue); font-size:12px; text-decoration:none; }
.book-body { border-top:1px dashed var(--line); padding:6px 18px 14px; }
.mark { padding:12px 0; border-bottom:1px dashed var(--line); }
.mark:last-of-type { border-bottom:none; }
.mark-meta { color:var(--sub); font-size:12px; margin-bottom:4px; }
.mark-text { font-size:14px; }
.mark.highlight .mark-text { border-left:3px solid var(--yellow); padding-left:10px; }
.mark.thought .mark-text { border-left:3px solid var(--purple); padding-left:10px; }
.ai-slot { margin-top:8px; padding:8px 12px; background:#f4f8fd; border-left:3px solid var(--blue); border-radius:0 6px 6px 0; font-size:13px; color:#5b7fa6; }
.empty { color:var(--sub); text-align:center; padding:20px; }
footer { margin-top:32px; text-align:center; color:var(--sub); font-size:12px; }
footer a { color:var(--blue); }
</style></head><body><div class="wrap">
<h1>📖 共读看板</h1>
<div class="sub">你的划线 🟡 · 你的想法 💭 · AI 批注 🔵（点书名展开） · 生成于 ${date}</div>

<div class="kpis">
  <div class="kpi"><b>${books.length}</b><span>书架藏书</span></div>
  <div class="kpi"><b>${nbTotal ?? nbBooks.length}</b><span>有笔记的书</span></div>
  <div class="kpi"><b>${totalHl}</b><span>划线总数</span></div>
  <div class="kpi"><b>${totalTh}</b><span>想法总数</span></div>
  <div class="kpi"><b>${fmtTime(rd.totalReadTime)}</b><span>累计阅读</span></div>
</div>

<div class="panel"><h3>🔥 阅读热力图${heat.length ? `（近 ${heat.length} 天）` : ""}</h3>
  <div class="heat">${heatCells || '<div class="empty">暂无统计数据</div>'}</div></div>

<div class="panel"><h3>🏆 最常读的书</h3>${topHtml}</div>

<input class="search" placeholder="搜索书名 / 作者 / 划线内容…（输入即过滤）">

${cards}

<footer>数据来自微信读书官方 Agent Gateway · 本页由看板服务实时生成 · 🔵 AI 批注区等我们共读时填上</footer>
<script>
function toggleBook(h){ const b = h.nextElementSibling; b.hidden = !b.hidden; }
const sb = document.querySelector('.search');
sb.addEventListener('input', () => {
  const q = sb.value.trim().toLowerCase();
  document.querySelectorAll('.book-card').forEach(card => {
    const hit = !q || card.textContent.toLowerCase().includes(q);
    card.style.display = hit ? '' : 'none';
    if (q && hit) { card.querySelector('.book-body').hidden = false;
      card.querySelectorAll('.mark').forEach(m => {
        m.style.display = m.querySelector('.mark-text').textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    } else { card.querySelectorAll('.mark').forEach(m => m.style.display = ''); }
  });
});
</script>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// 一步到位：采集 + 渲染
// ---------------------------------------------------------------------------
export async function buildDashboard(gw, opts = {}) {
  const data = await collect(gw, opts);
  return render(data, opts);
}
