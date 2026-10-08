import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callGateway } from "./weread.js";
import { buildDashboard } from "./dashboard.js";

// ---------------------------------------------------------------------------
// 工具定义：每个 tool 薄封装一个微信读书官方网关接口。
// handler(a, env) -> 网关返回的 JSON
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "weread_search",
    description:
      "在微信读书书城搜索。keyword 为检索词；scope 指定类型（0=全部,10=电子书,16=网文,14=听书,6=作者,12=全文,13=书单,2=公众号,4=文章），默认 10（电子书）。返回分组结果，含 bookId/deepLink/评分等。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键词" },
        scope: { type: "integer", description: "搜索类型，默认 10（电子书）" },
        count: { type: "integer", description: "每页数量（不传用服务端默认 15）" },
        maxIdx: { type: "integer", description: "翻页偏移，默认 0" },
      },
      required: ["keyword"],
    },
    handler: (a, env) =>
      callGateway("/store/search", { keyword: a.keyword, scope: a.scope ?? 10, count: a.count, maxIdx: a.maxIdx }, env),
  },
  {
    name: "weread_shelf",
    description:
      "获取书架全量列表（/shelf/sync）。返回 books[]（电子书）、albums[]（专辑/有声书）、mp（文章收藏入口）、archive[]（书单）。书架条目数 = books.length + albums.length + (mp 非空 ? 1 : 0)。",
    inputSchema: { type: "object", properties: {} },
    handler: (_a, env) => callGateway("/shelf/sync", {}, env),
  },
  {
    name: "weread_notebooks",
    description:
      "获取笔记本概览（/user/notebooks）：所有有笔记的书及数量。分页用游标：首请求只传 count；若 hasMore=1，取本页最后一条的 sort 作为下一页 lastSort。单本书总笔记数 = reviewCount + noteCount + bookmarkCount。",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", description: "每页数量，默认 20" },
        lastSort: { type: "integer", description: "翻页游标（上一页最后一条的 sort）" },
      },
    },
    handler: (a, env) => callGateway("/user/notebooks", { count: a.count, lastSort: a.lastSort }, env),
  },
  {
    name: "weread_book_info",
    description: "获取书籍基本信息（/book/info）：书名、作者、简介、出版社、评分等。需要 bookId（可由 weread_search 得到）。",
    inputSchema: { type: "object", properties: { bookId: { type: "string", description: "书籍 ID" } }, required: ["bookId"] },
    handler: (a, env) => callGateway("/book/info", { bookId: a.bookId }, env),
  },
  {
    name: "weread_chapters",
    description: "获取书籍章节目录（/book/chapterinfo）：章节 title、chapterUid、序号、字数等。需要 bookId。",
    inputSchema: { type: "object", properties: { bookId: { type: "string", description: "书籍 ID" } }, required: ["bookId"] },
    handler: (a, env) => callGateway("/book/chapterinfo", { bookId: a.bookId }, env),
  },
  {
    name: "weread_progress",
    description: "获取某本书的阅读进度（/book/getprogress）：进度百分比（0-100，1=1%）、累计阅读时长（秒）。需要 bookId。",
    inputSchema: { type: "object", properties: { bookId: { type: "string", description: "书籍 ID" } }, required: ["bookId"] },
    handler: (a, env) => callGateway("/book/getprogress", { bookId: a.bookId }, env),
  },
  {
    name: "weread_readdata",
    description:
      "获取个人阅读统计（/readdata/detail）。mode：weekly=本周, monthly=本月(默认), annually=本年, overall=总计。所有时长字段单位为秒。baseTime 可选，传历史时间戳可查该周期数据。",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["weekly", "monthly", "annually", "overall"], description: "统计维度，默认 monthly" },
        baseTime: { type: "integer", description: "基准时间戳（0=当前周期）" },
      },
    },
    handler: (a, env) => callGateway("/readdata/detail", { mode: a.mode ?? "monthly", baseTime: a.baseTime }, env),
  },
  {
    name: "weread_book_notes",
    description:
      "获取某本书的个人笔记内容：同时拉划线（/book/bookmarklist）和个人想法/点评（/review/list/mine），合并返回 { bookmarks, myReviews }。需要 bookId。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        count: { type: "integer", description: "想法每页数量，默认 20" },
      },
      required: ["bookId"],
    },
    handler: async (a, env) => {
      const [bookmarks, myReviews] = await Promise.all([
        callGateway("/book/bookmarklist", { bookId: a.bookId }, env),
        callGateway("/review/list/mine", { bookid: a.bookId, count: a.count }, env),
      ]);
      return { bookmarks, myReviews };
    },
  },
  {
    name: "weread_reviews",
    description:
      "获取书籍公开点评（/review/list）。reviewListType：0=全部(默认),1=推荐,2=不行,3=最新,4=一般。评分口径 20=一星…100=五星。需要 bookId。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        reviewListType: { type: "integer", description: "筛选类型，默认 0" },
        count: { type: "integer", description: "每页数量，默认 20" },
        maxIdx: { type: "integer", description: "翻页偏移" },
        synckey: { type: "integer", description: "翻页游标" },
      },
      required: ["bookId"],
    },
    handler: (a, env) =>
      callGateway("/review/list", { bookId: a.bookId, reviewListType: a.reviewListType, count: a.count, maxIdx: a.maxIdx, synckey: a.synckey }, env),
  },
  {
    name: "weread_best_bookmarks",
    description: "获取书籍热门划线（/book/bestbookmarks）：含划线原文与划线人数，按热度排序，最多 20 条。需要 bookId，chapterUid 可选（0=全部章节）。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        chapterUid: { type: "integer", description: "章节 UID，默认 0（全部）" },
        synckey: { type: "integer", description: "增量同步 key，默认 0" },
      },
      required: ["bookId"],
    },
    handler: (a, env) => callGateway("/book/bestbookmarks", { bookId: a.bookId, chapterUid: a.chapterUid, synckey: a.synckey }, env),
  },
  {
    name: "weread_recommend",
    description: "个性化推荐好书（/book/recommend，即 App 首页「为你推荐」）。分页用 searchIdx 作为下一页 maxIdx。",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", description: "每页数量，默认 12" },
        maxIdx: { type: "integer", description: "翻页偏移，默认 0" },
      },
    },
    handler: (a, env) => callGateway("/book/recommend", { count: a.count, maxIdx: a.maxIdx }, env),
  },
  {
    name: "weread_similar",
    description: "相似书推荐（/book/similar，即书籍详情页「相似推荐」）。需要 bookId；count 与 maxIdx 必须显式传（默认 count=12、maxIdx=0），翻页带 sessionId。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        count: { type: "integer", description: "每页数量，默认 12" },
        maxIdx: { type: "integer", description: "翻页偏移，默认 0" },
        sessionId: { type: "string", description: "翻页会话 ID（首次不传）" },
      },
      required: ["bookId"],
    },
    handler: (a, env) =>
      callGateway("/book/similar", { bookId: a.bookId, count: a.count ?? 12, maxIdx: a.maxIdx ?? 0, sessionId: a.sessionId }, env),
  },
  {
    name: "weread_endpoints",
    description: "列出官方网关当前所有可用接口及参数定义（/_list）。用于探查能力或调试。",
    inputSchema: { type: "object", properties: {} },
    handler: (_a, env) => callGateway("/_list", {}, env),
  },
  {
    name: "weread_call",
    description:
      "原始调用逃生口：直接向官方网关发任意 api_name + 平铺参数（不包 params）。仅在其它专用工具覆盖不到时使用。",
    inputSchema: {
      type: "object",
      properties: {
        api_name: { type: "string", description: "网关接口名，如 /book/info" },
        params: { type: "object", description: "平铺的业务参数对象（会被展开到 body 顶层）" },
      },
      required: ["api_name"],
    },
    handler: (a, env) => callGateway(a.api_name, a.params || {}, env),
  },

  // -------------------------------------------------------------------------
  // 共读原文与批注（数据在服务器 KV，与微信读书网关无关）
  // 原文不进看板页面，只供 AI 阅读；批注写回后看板立即可见。
  // -------------------------------------------------------------------------
  {
    name: "coread_outline",
    description:
      "【共读书目】列出服务器上共读书目的章节目录（章节标题 + 起止段号）。先看结构，再决定读哪几段。",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, env) => {
      const coread = await getCoread(env);
      const meta = coread.meta || {};
      return {
        book: meta.book ?? null,
        totalSegments: meta.totalSegments ?? coread.segments.length,
        chapters: meta.chapters || [],
      };
    },
  },
  {
    name: "coread_read",
    description:
      "【共读书目】按段落范围读原书正文。from/to 为段号（含两端，从 1 开始）；单次最多 60 段，超了会截断并在 nextFrom 给出续读起点。",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "integer", description: "起始段号（含），默认 1" },
        to: { type: "integer", description: "结束段号（含），默认按 limit 推算" },
        limit: { type: "integer", description: "最多返回多少段，默认 40，上限 60" },
      },
    },
    handler: async (a, env) => {
      const coread = await getCoread(env);
      const total = coread.meta?.totalSegments ?? coread.segments.length;
      const from = Math.max(1, a.from ?? 1);
      const limit = Math.max(1, Math.min(60, a.limit ?? 40));
      const to = Math.min(total, a.to ?? from + limit - 1);
      const segs = coread.segments.filter((s) => s.id >= from && s.id <= to).slice(0, limit);
      const last = segs.length ? segs[segs.length - 1].id : from - 1;
      return {
        book: coread.meta?.book ?? null,
        totalSegments: total,
        from: segs.length ? segs[0].id : null,
        to: last,
        truncated: last < to,
        nextFrom: last < total ? last + 1 : null,
        segments: segs.map((s) => ({ id: s.id, chTitle: s.chTitle || "", text: s.text })),
      };
    },
  },
  {
    name: "coread_search",
    description:
      "【共读书目】在共读书目正文里做关键词搜索（纯服务端，不走微信读书网关）。返回命中段落，含完整正文 text 与上下文片段 snippet。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "关键词" },
        limit: { type: "integer", description: "最多返回多少段，默认 20，上限 100" },
      },
      required: ["q"],
    },
    handler: async (a, env) => {
      const coread = await getCoread(env);
      const limit = Math.max(1, Math.min(100, a.limit ?? 20));
      const hits = searchSegments(coread, a.q, limit);
      return { book: coread.meta?.book ?? null, q: a.q, count: hits.length, hits };
    },
  },
  {
    name: "coread_annotate",
    description:
      "【共读书目】给指定段落写批注，直接落 KV，看板立即可见。annotations 每项 { id, user?, ai? }：user=用户的思考，ai=助手的思考（这两栏就是看板上双色批注）；两栏都传空字符串表示删除该段批注。",
    inputSchema: {
      type: "object",
      properties: {
        annotations: {
          type: "array",
          description: "要写入的批注列表",
          items: {
            type: "object",
            properties: {
              id: { type: "integer", description: "段号" },
              user: { type: "string", description: "用户的思考（可省略）" },
              ai: { type: "string", description: "助手的思考（可省略）" },
            },
            required: ["id"],
          },
        },
      },
      required: ["annotations"],
    },
    handler: async (a, env) => {
      if (!env.COREAD_KV) throw new Error("COREAD_KV 未绑定");
      const list = Array.isArray(a.annotations) ? a.annotations : [];
      if (!list.length) throw new Error("annotations 为空");
      await getCoread(env); // 校验书已上传，避免写进一个没原文的批注库
      const patch = {};
      for (const it of list) patch[String(it.id)] = { user: it.user ?? "", ai: it.ai ?? "" };
      const r = await mergeNotes(env, patch);
      return { ok: true, changed: r.changed, totalAnnotated: r.total, ids: Object.keys(patch) };
    },
  },
];

// ---------------------------------------------------------------------------
// 每个请求一个 Server 实例（无状态模式）
// ---------------------------------------------------------------------------
function createServer(env) {
  const server = new Server(
    { name: "weread-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = req.params?.arguments || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
    }
    try {
      const data = await tool.handler(args, env);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `调用失败：${e.message}` }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Worker 入口
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function withCors(res) {
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function bearer(request) {
  const a = request.headers.get("authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// 看板：GET /dashboard?token=<MCP_AUTH_TOKEN>&books=<1..20>
// 数据实时来自官方网关，渲染成一个自包含 HTML 页面（浏览器直接打开即可）。
// ---------------------------------------------------------------------------
async function handleDashboard(request, env, url) {
  const token = url.searchParams.get("token") || bearer(request);
  if (env.MCP_AUTH_TOKEN && token !== env.MCP_AUTH_TOKEN) {
    return html(
      "<h1>403 需要访问口令</h1><p>请在地址后加上 <code>?token=你的MCP_AUTH_TOKEN</code> 再打开。</p>",
      403
    );
  }
  if (!env.WEREAD_API_KEY) {
    return html("<h1>500 未配置密钥</h1><p>请先设置 Worker Secret <code>WEREAD_API_KEY</code>。</p>", 500);
  }

  const maxBooks = clampInt(url.searchParams.get("books"), 1, 20, 12);

  // 共读数据（可选）：优先 KV 绑定 COREAD_KV 的 "coread" 键，其次 URL 内联 base64url。
  // 结构与原版一致：{ meta:{book,totalSegments}, segments:[{id,ch,chTitle,text,user,ai}] }
  let coread = null;
  try {
    if (env.COREAD_KV) coread = await env.COREAD_KV.get("coread", "json");
  } catch {
    /* KV 未绑定或读取失败：忽略 */
  }
  if (!coread) {
    const inline = url.searchParams.get("coread");
    if (inline) {
      try {
        coread = b64urlJson(inline);
      } catch {
        /* 非法内联数据：忽略，退回无共读 */
      }
    }
  }

  // 批注单独一个 KV 键：AI 经 MCP 增量写批注时不必重传整本原文
  const notes = coread ? await readNotes(env) : null;

  try {
    const page = await buildDashboard((n, p) => callGateway(n, p, env), { maxBooks, coread, notes });
    return html(page);
  } catch (e) {
    return html(`<h1>看板生成失败</h1><pre>${String(e.message ?? e)}</pre>`, 500);
  }
}

// ---------------------------------------------------------------------------
// 上传共读数据：POST /coread  （body = coread.json 原文，或 base64url）
// 受 MCP_AUTH_TOKEN 保护，写入 KV 绑定的 "coread" 键。
//   curl -X POST "https://<你的地址>/coread" \
//        -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
//        -H "Content-Type: application/json" \
//        --data-binary @coread.json
// ---------------------------------------------------------------------------
const COREAD_MAX = 24 * 1024 * 1024; // KV 单值上限 25 MiB，留点余量

async function handleCoreadUpload(request, env, url) {
  const token = bearer(request) || url.searchParams.get("token") || "";
  if (!env.MCP_AUTH_TOKEN || token !== env.MCP_AUTH_TOKEN) {
    return json({ error: "unauthorized", hint: "带上 Authorization: Bearer <MCP_AUTH_TOKEN>" }, 401);
  }
  if (!env.COREAD_KV) {
    return json(
      {
        error: "COREAD_KV 未绑定",
        hint: "在 wrangler.toml 里加 [[kv_namespaces]] binding=\"COREAD_KV\" 并重新部署，或在 Cloudflare 后台给 Worker 加 KV 绑定。",
      },
      400
    );
  }

  const raw = await request.text();
  if (!raw.trim()) return json({ error: "空 body：请把 coread.json 的内容作为请求体" }, 400);
  if (raw.length > COREAD_MAX) {
    return json({ error: `太大：${raw.length} 字节，KV 单值上限 25 MiB` }, 413);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    try {
      data = b64urlJson(raw.trim());
    } catch {
      return json({ error: "body 既不是 JSON 也不是 base64url" }, 400);
    }
  }
  if (!data || !Array.isArray(data.segments)) {
    return json({ error: "结构不对：需要 { meta:{book,totalSegments}, segments:[{id,ch,chTitle,text,user,ai}] }" }, 400);
  }

  await env.COREAD_KV.put("coread", JSON.stringify(data));
  return json({
    ok: true,
    key: "coread",
    book: data.meta?.book ?? null,
    segments: data.segments.length,
    bytes: raw.length,
    view: "/dashboard?token=<MCP_AUTH_TOKEN>",
  });
}

// 查看已上传的共读数据（只回摘要，不回正文）
async function handleCoreadStatus(request, env, url) {
  const token = bearer(request) || url.searchParams.get("token") || "";
  if (!env.MCP_AUTH_TOKEN || token !== env.MCP_AUTH_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.COREAD_KV) return json({ bound: false, uploaded: false, hint: "COREAD_KV 未绑定" });
  const data = await env.COREAD_KV.get("coread", "json");
  const notes = await readNotes(env);
  const annotated = Object.keys(notes).length;
  if (!data) return json({ bound: true, uploaded: false, annotated });
  return json({ bound: true, uploaded: true, book: data.meta?.book ?? null, segments: data.segments?.length ?? 0, annotated });
}

// ---------------------------------------------------------------------------
// 共读批注：GET/POST /coread/notes
//   批注与原文分开存（KV 键 "coread-notes"），AI 写批注不必重传整本原文。
//   结构 { "<段id>": { user:"我的思考", ai:"助手思考", ts } }
//   某段 user/ai 都传空字符串 = 删除该段批注。
// ---------------------------------------------------------------------------
const NOTES_MAX = 2 * 1024 * 1024;

async function readNotes(env) {
  try {
    return (env.COREAD_KV && (await env.COREAD_KV.get("coread-notes", "json"))) || {};
  } catch {
    return {};
  }
}

async function mergeNotes(env, patch) {
  const cur = await readNotes(env);
  let changed = 0;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!/^\d+$/.test(k)) continue;
    const user = String(v?.user ?? "").trim();
    const ai = String(v?.ai ?? "").trim();
    if (!user && !ai) {
      if (cur[k]) {
        delete cur[k];
        changed++;
      }
      continue;
    }
    const before = cur[k] || {};
    if (before.user !== user || before.ai !== ai) changed++;
    cur[k] = { user, ai, ts: v?.ts ?? Date.now() };
  }
  await env.COREAD_KV.put("coread-notes", JSON.stringify(cur));
  return { changed, total: Object.keys(cur).length };
}

async function handleNotes(request, env, url) {
  const token = bearer(request) || url.searchParams.get("token") || "";
  if (!env.MCP_AUTH_TOKEN || token !== env.MCP_AUTH_TOKEN) return json({ error: "unauthorized" }, 401);
  if (!env.COREAD_KV) return json({ error: "COREAD_KV 未绑定" }, 400);

  if (request.method === "GET") {
    const notes = await readNotes(env);
    return json({ total: Object.keys(notes).length, notes });
  }
  const raw = await request.text();
  if (raw.length > NOTES_MAX) return json({ error: "批注体积过大" }, 413);
  let patch;
  try {
    patch = JSON.parse(raw || "{}");
  } catch {
    return json({ error: "body 需要是 JSON 对象" }, 400);
  }
  if (patch && typeof patch.notes === "object" && patch.notes) patch = patch.notes;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return json({ error: '结构不对：需要 { "<段id>": { user, ai } }' }, 400);
  }
  const r = await mergeNotes(env, patch);
  return json({ ok: true, changed: r.changed, total: r.total });
}

// ---------------------------------------------------------------------------
// 搜索原文：GET /coread/search?q=xxx&limit=20
// 纯服务端搜索，人类看板的搜索框与 AI 的 coread_search 工具共用。
// ---------------------------------------------------------------------------
function searchSegments(coread, q, limit) {
  const kw = String(q || "").trim();
  if (!kw) return [];
  const lower = kw.toLowerCase();
  const out = [];
  for (const s of coread.segments) {
    const t = String(s.text || "");
    const i = t.toLowerCase().indexOf(lower);
    if (i < 0) continue;
    const from = Math.max(0, i - 30);
    const snippet =
      (from > 0 ? "…" : "") +
      t.slice(from, i + kw.length + 40) +
      (i + kw.length + 40 < t.length ? "…" : "");
    out.push({ id: s.id, ch: s.ch, chTitle: s.chTitle || "", text: t, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

async function handleCoreadSearch(request, env, url) {
  const token = bearer(request) || url.searchParams.get("token") || "";
  if (!env.MCP_AUTH_TOKEN || token !== env.MCP_AUTH_TOKEN) return json({ error: "unauthorized" }, 401);
  if (!env.COREAD_KV) return json({ error: "COREAD_KV 未绑定" }, 400);
  const coread = await env.COREAD_KV.get("coread", "json");
  if (!coread || !Array.isArray(coread.segments)) return json({ error: "还没上传原书" }, 404);
  const q = url.searchParams.get("q") || "";
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);
  const hits = searchSegments(coread, q, limit);
  return json({ book: coread.meta?.book ?? null, totalSegments: coread.meta?.totalSegments ?? coread.segments.length, q, count: hits.length, hits });
}

// 取服务器上的共读书目（给 MCP 工具用；没有就抛错）
async function getCoread(env) {
  if (!env.COREAD_KV) throw new Error("COREAD_KV 未绑定");
  const coread = await env.COREAD_KV.get("coread", "json");
  if (!coread || !Array.isArray(coread.segments)) {
    throw new Error("服务器上还没有共读原书。先在看板（📖 共读 Tab）拖入 EPUB，或用 POST /coread 上传。");
  }
  return coread;
}

// base64url → JSON（UTF-8 安全）
function b64urlJson(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return json({ ok: true, name: "weread-mcp", endpoint: "/mcp", dashboard: "/dashboard", coread: "/coread", notes: "/coread/notes", search: "/coread/search" });
    }
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      return handleDashboard(request, env, url);
    }
    if (url.pathname === "/coread" || url.pathname === "/coread/") {
      if (request.method === "POST") return handleCoreadUpload(request, env, url);
      if (request.method === "GET") return handleCoreadStatus(request, env, url);
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/coread/notes" || url.pathname === "/coread/notes/") {
      if (request.method === "GET" || request.method === "POST") return handleNotes(request, env, url);
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/coread/search" || url.pathname === "/coread/search/") {
      if (request.method === "GET") return handleCoreadSearch(request, env, url);
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);

    // Bearer 鉴权：配置了 MCP_AUTH_TOKEN 就强制校验
    if (env.MCP_AUTH_TOKEN) {
      const auth = request.headers.get("authorization") || "";
      const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (got !== env.MCP_AUTH_TOKEN) {
        return json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }, 401);
      }
    }

    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // 无状态：每个请求独立
        enableJsonResponse: true,
      });
      const server = createServer(env);
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      return withCors(res);
    } catch (e) {
      return json({ jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${e.message}` }, id: null }, 500);
    }
  },
};
