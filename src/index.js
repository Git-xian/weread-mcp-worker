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

  try {
    const page = await buildDashboard((n, p) => callGateway(n, p, env), { maxBooks, coread });
    return html(page);
  } catch (e) {
    return html(`<h1>看板生成失败</h1><pre>${String(e.message ?? e)}</pre>`, 500);
  }
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
      return json({ ok: true, name: "weread-mcp", endpoint: "/mcp", dashboard: "/dashboard" });
    }
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      return handleDashboard(request, env, url);
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
