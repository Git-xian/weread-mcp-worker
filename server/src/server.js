import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { callGateway, prune } from "./weread.js";
import { buildDashboard } from "./dashboard.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

// ---------------------------------------------------------------------------
// 工具定义：每个 tool 薄封装一个微信读书官方网关接口。
// 参数命名尽量贴近官方文档；分页游标按文档要求平铺在 body 顶层。
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "weread_search",
    description:
      "在微信读书书城搜索。keyword 为检索词；scope 指定搜索类型（0=全部,10=电子书,16=网文,14=听书,6=作者,12=全文,13=书单,2=公众号,4=文章），默认 10（电子书）。返回分组结果，含 bookId/deepLink/评分等。",
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
    handler: (a) => callGateway("/store/search", { keyword: a.keyword, scope: a.scope ?? 10, count: a.count, maxIdx: a.maxIdx }),
  },
  {
    name: "weread_shelf",
    description:
      "获取用户微信读书书架全量列表（/shelf/sync）。返回 books[]（电子书）、albums[]（专辑/有声书）、mp（文章收藏入口）、archive[]（书单）。书架条目数 = books.length + albums.length + (mp 非空 ? 1 : 0)。",
    inputSchema: { type: "object", properties: {} },
    handler: () => callGateway("/shelf/sync"),
  },
  {
    name: "weread_notebooks",
    description:
      "获取笔记本概览（/user/notebooks）：所有有笔记的书及笔记数量。分页用游标：首请求只传 count；若 hasMore=1，取本页最后一条的 sort 作为下一页 lastSort。单本书总笔记数 = reviewCount + noteCount + bookmarkCount。",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", description: "每页数量，默认 20" },
        lastSort: { type: "integer", description: "翻页游标（上一页最后一条的 sort）" },
      },
    },
    handler: (a) => callGateway("/user/notebooks", { count: a.count, lastSort: a.lastSort }),
  },
  {
    name: "weread_book_info",
    description: "获取书籍基本信息（/book/info）：书名、作者、简介、出版社、评分等。需要 bookId（可由 weread_search 得到）。",
    inputSchema: { type: "object", properties: { bookId: { type: "string", description: "书籍 ID" } }, required: ["bookId"] },
    handler: (a) => callGateway("/book/info", { bookId: a.bookId }),
  },
  {
    name: "weread_chapters",
    description: "获取书籍章节目录（/book/chapterinfo）：章节 title、chapterUid、序号、字数等。需要 bookId。",
    inputSchema: { type: "object", properties: { bookId: { type: "string", description: "书籍 ID" } }, required: ["bookId"] },
    handler: (a) => callGateway("/book/chapterinfo", { bookId: a.bookId }),
  },
  {
    name: "weread_progress",
    description: "获取某本书的阅读进度（/book/getprogress）：进度百分比（0-100，1=1%）、累计阅读时长（秒）。需要 bookId。",
    inputSchema: { type: "object", properties: { bookId: { type: "string", description: "书籍 ID" } }, required: ["bookId"] },
    handler: (a) => callGateway("/book/getprogress", { bookId: a.bookId }),
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
    handler: (a) => callGateway("/readdata/detail", { mode: a.mode ?? "monthly", baseTime: a.baseTime }),
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
    handler: async (a) => {
      const [bookmarks, myReviews] = await Promise.all([
        callGateway("/book/bookmarklist", { bookId: a.bookId }),
        callGateway("/review/list/mine", { bookid: a.bookId, count: a.count }),
      ]);
      return { bookmarks, myReviews };
    },
  },
  {
    name: "weread_reviews",
    description:
      "获取书籍公开点评（/review/list）。reviewListType：0=全部(默认), 1=推荐, 2=不行, 3=最新, 4=一般。评分口径 20=一星…100=五星。需要 bookId。",
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
    handler: (a) =>
      callGateway("/review/list", {
        bookId: a.bookId,
        reviewListType: a.reviewListType,
        count: a.count,
        maxIdx: a.maxIdx,
        synckey: a.synckey,
      }),
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
    handler: (a) => callGateway("/book/bestbookmarks", { bookId: a.bookId, chapterUid: a.chapterUid, synckey: a.synckey }),
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
    handler: (a) => callGateway("/book/recommend", { count: a.count, maxIdx: a.maxIdx }),
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
    handler: (a) =>
      callGateway("/book/similar", {
        bookId: a.bookId,
        count: a.count ?? 12,
        maxIdx: a.maxIdx ?? 0,
        sessionId: a.sessionId,
      }),
  },
  {
    name: "weread_endpoints",
    description: "列出官方网关当前所有可用接口及参数定义（/_list）。用于探查能力或调试。",
    inputSchema: { type: "object", properties: {} },
    handler: () => callGateway("/_list", {}),
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
    handler: (a) => callGateway(a.api_name, a.params || {}),
  },

  // -------------------------------------------------------------------------
  // 共读原文与批注（数据在服务器本地文件，与微信读书网关无关）
  // -------------------------------------------------------------------------
  {
    name: "coread_outline",
    description: "【共读书目】列出服务器上共读书目的章节目录（章节标题 + 起止段号）。先看结构，再决定读哪几段。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const coread = getCoread();
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
    handler: async (a) => {
      const coread = getCoread();
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
      "【共读书目】在共读书目正文里做关键词搜索（纯本地，不走微信读书网关）。返回命中段落，含完整正文 text 与上下文片段 snippet。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "关键词" },
        limit: { type: "integer", description: "最多返回多少段，默认 20，上限 100" },
      },
      required: ["q"],
    },
    handler: async (a) => {
      const coread = getCoread();
      const limit = Math.max(1, Math.min(100, a.limit ?? 20));
      const hits = searchSegments(coread, a.q, limit);
      return { book: coread.meta?.book ?? null, q: a.q, count: hits.length, hits };
    },
  },
  {
    name: "coread_annotate",
    description:
      "【共读书目】给指定段落写批注，直接落盘，看板立即可见。annotations 每项 { id, user?, ai? }：user=用户的思考，ai=助手的思考（这两栏就是看板上双色批注）；两栏都传空字符串表示删除该段批注。",
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
    handler: async (a) => {
      const list = Array.isArray(a.annotations) ? a.annotations : [];
      if (!list.length) throw new Error("annotations 为空");
      getCoread(); // 校验书已上传
      const patch = {};
      for (const it of list) patch[String(it.id)] = { user: it.user ?? "", ai: it.ai ?? "" };
      const r = mergeNotes(patch);
      return { ok: true, changed: r.changed, totalAnnotated: r.total, ids: Object.keys(patch) };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server（每个会话一个实例）
// ---------------------------------------------------------------------------
function createServer() {
  const server = new Server(
    { name: "weread-mcp-server", version: "0.1.0" },
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
      const data = await tool.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `调用失败：${e.message}` }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP（Streamable HTTP 传输 + 可选 Bearer 鉴权）
// ---------------------------------------------------------------------------
const app = express();

// ---------------------------------------------------------------------------
// 共读数据上传：POST /coread（Bearer 鉴权）→ 落成本地文件；GET /coread 查状态
// 必须注册在全局 express.json 之前，才能给这条路单独放宽 body 上限（整本书好几 MB）
// ---------------------------------------------------------------------------
const COREAD_PATH =
  process.env.COREAD_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "coread.json");

// 批注与原文分开存：AI 写批注时不必重写整本原文
const NOTES_PATH =
  process.env.COREAD_NOTES_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "coread-notes.json");

function readNotes() {
  return readJson(NOTES_PATH) || {};
}
function mergeNotes(patch) {
  const cur = readNotes();
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
  fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
  fs.writeFileSync(NOTES_PATH, JSON.stringify(cur));
  return { changed, total: Object.keys(cur).length };
}
function getCoread() {
  const d = readJson(COREAD_PATH);
  if (!d || !Array.isArray(d.segments)) {
    throw new Error("服务器上还没有共读原书。先在看板（📖 共读 Tab）拖入 EPUB，或用 POST /coread 上传。");
  }
  return d;
}
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
      (from > 0 ? "…" : "") + t.slice(from, i + kw.length + 40) + (i + kw.length + 40 < t.length ? "…" : "");
    out.push({ id: s.id, ch: s.ch, chTitle: s.chTitle || "", text: t, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

const authOk = (req) => {
  const h = req.headers.authorization || "";
  return !!AUTH_TOKEN && h.startsWith("Bearer ") && h.slice(7) === AUTH_TOKEN;
};

app.post("/coread", express.json({ limit: "32mb" }), (req, res) => {
  if (!authOk(req)) {
    return res.status(401).json({ error: "unauthorized", hint: "带上 Authorization: Bearer <MCP_AUTH_TOKEN>" });
  }
  const data = req.body;
  if (!data || !Array.isArray(data.segments)) {
    return res.status(400).json({ error: "结构不对：需要 { meta:{book,totalSegments}, segments:[{id,ch,chTitle,text,user,ai}] }" });
  }
  const raw = JSON.stringify(data);
  try {
    fs.mkdirSync(path.dirname(COREAD_PATH), { recursive: true });
    fs.writeFileSync(COREAD_PATH, raw);
  } catch (e) {
    return res.status(500).json({ error: "写入失败：" + e.message, path: COREAD_PATH });
  }
  console.log(`[weread-mcp] 已保存共读数据 → ${COREAD_PATH}（${data.segments.length} 段）`);
  res.json({ ok: true, key: "coread", path: COREAD_PATH, book: data.meta?.book ?? null, segments: data.segments.length, bytes: raw.length });
});

app.get("/coread", (req, res) => {
  if (!authOk(req) && String(req.query.token || "") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const data = readJson(COREAD_PATH);
  const annotated = Object.keys(readNotes()).length;
  if (!data) return res.json({ uploaded: false, path: COREAD_PATH, annotated });
  res.json({ uploaded: true, path: COREAD_PATH, book: data.meta?.book ?? null, segments: data.segments?.length ?? 0, annotated });
});

// ---------------------------------------------------------------------------
// 共读批注：GET/POST /coread/notes（Bearer 或 ?token=）
// 某段 user/ai 都传空字符串 = 删除该段批注
// ---------------------------------------------------------------------------
app.post("/coread/notes", express.json({ limit: "2mb" }), (req, res) => {
  if (!authOk(req) && String(req.query.token || "") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  let patch = req.body;
  if (patch && typeof patch.notes === "object" && patch.notes) patch = patch.notes;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return res.status(400).json({ error: '结构不对：需要 { "<段id>": { user, ai } }' });
  }
  const r = mergeNotes(patch);
  res.json({ ok: true, changed: r.changed, total: r.total });
});

app.get("/coread/notes", (req, res) => {
  if (!authOk(req) && String(req.query.token || "") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const notes = readNotes();
  res.json({ total: Object.keys(notes).length, notes });
});

// 原文搜索（看板搜索框与 AI 的 coread_search 共用）
app.get("/coread/search", (req, res) => {
  if (!authOk(req) && String(req.query.token || "") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const coread = readJson(COREAD_PATH);
  if (!coread || !Array.isArray(coread.segments)) return res.status(404).json({ error: "还没上传原书" });
  const q = String(req.query.q || "");
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const hits = searchSegments(coread, q, limit);
  res.json({
    book: coread.meta?.book ?? null,
    totalSegments: coread.meta?.totalSegments ?? coread.segments.length,
    q,
    count: hits.length,
    hits,
  });
});

app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, name: "weread-mcp-server", dashboard: "/dashboard", coread: "/coread", notes: "/coread/notes", search: "/coread/search" })
);

// ---------------------------------------------------------------------------
// 看板：GET /dashboard?token=<MCP_AUTH_TOKEN>&books=<1..20>
// 实时拉官方网关数据，渲染成自包含 HTML。手机/电脑浏览器直接打开即可。
// ---------------------------------------------------------------------------
app.get("/dashboard", async (req, res) => {
  if (AUTH_TOKEN) {
    const t =
      String(req.query.token || "") ||
      (req.headers.authorization || "").replace(/^Bearer /, "");
    if (t !== AUTH_TOKEN) {
      return res
        .status(403)
        .type("html")
        .send("<h1>403 需要访问口令</h1><p>请在地址后加上 <code>?token=你的MCP_AUTH_TOKEN</code> 再打开。</p>");
    }
  }
  const maxBooks = Math.max(1, Math.min(20, parseInt(req.query.books, 10) || 12));
  // 共读数据（可选）：?coread=<本地 JSON 路径 或 base64url>，或 COREAD_FILE / 上传落盘的那份
  const coread = loadCoread(req.query.coread) || readJson(COREAD_PATH);
  const notes = coread ? readNotes() : null;
  try {
    const page = await buildDashboard((n, p) => callGateway(n, p), { maxBooks, coread, notes });
    res.type("html").send(page);
  } catch (e) {
    res.status(500).type("html").send(`<h1>看板生成失败</h1><pre>${String(e.message ?? e)}</pre>`);
  }
});

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// 支持两种写法：文件路径，或内联 base64url（与 Worker 版一致）
function loadCoread(v) {
  if (!v) return null;
  const s = String(v);
  if (fs.existsSync(s)) return readJson(s);
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

app.use("/mcp", (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const h = req.headers.authorization || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (got !== AUTH_TOKEN) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "unauthorized" },
      id: null,
    });
  }
  next();
});

const transports = {};

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await createServer().connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: 无有效 session" },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[weread-mcp] POST /mcp 出错:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("无效或缺失的 session id");
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, HOST, () => {
  console.log(`[weread-mcp] 已启动：http://${HOST}:${PORT}/mcp`);
  console.log(`[weread-mcp] 鉴权：${AUTH_TOKEN ? "已开启 Bearer Token" : "未开启（本机开发模式）"}`);
});
