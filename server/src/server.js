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
import { buildDashboard, chaptersLookDegenerate, deriveChapters } from "./dashboard.js";

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
      "【共读书目】给指定段落写批注，直接落盘，看板立即可见。annotations 每项 { id, user?, ai?, mark? }：user=用户的思考（🟡），ai=助手的思考（🔵），mark=这段被用户划了线（只标记，不算评论）。没传的字段保持原状；传空字符串可清空；user/ai 都空且 mark=false 则删除该段条目。",
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
              user: { type: "string", description: "用户的思考（🟡）；不传=不改，传空串=清空" },
              ai: { type: "string", description: "助手的思考（🔵）；不传=不改" },
              mark: { type: "boolean", description: "是否标记为用户划线（划线 ≠ 评论）；不传=不改" },
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
      for (const it of list) {
        const rec = {};
        if (it.user !== undefined) rec.user = it.user;
        if (it.ai !== undefined) rec.ai = it.ai;
        if (it.mark !== undefined) rec.mark = !!it.mark;
        patch[String(it.id)] = rec;
      }
      const r = mergeNotes(patch);
      return { ok: true, changed: r.changed, totalAnnotated: r.total, ids: Object.keys(patch) };
    },
  },
  {
    name: "coread_sync",
    description:
      "【共读书目】把你在微信读书里的划线 + 想法拉进共读看板。划线只标「划过线」（不写进 🟡 评论），想法才写进 🟡「你的思考」栏。默认按共读书名自动匹配微信读书笔记本（容忍版本后缀 / 文件名差异 / 导入书标题变作者名；匹配不上会返回 candidates 候选书单，选中一个后再传 bookId 即绑定记住）。只覆盖 user/mark，AI 的 🔵 批注一律保留。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "微信读书 bookId（可选，默认按共读书名匹配）" },
      },
    },
    handler: (a) => syncUserNotes({ bookId: a?.bookId }),
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

// 书名 ↔ 微信读书 bookId 的绑定（看板点选一次即可记住）
const BIND_PATH =
  process.env.COREAD_BIND_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "coread-bind.json");

function readBinds() {
  return readJson(BIND_PATH) || {};
}
function writeBinds(all) {
  fs.mkdirSync(path.dirname(BIND_PATH), { recursive: true });
  fs.writeFileSync(BIND_PATH, JSON.stringify(all));
}

function readNotes() {
  return readJson(NOTES_PATH) || {};
}
// 批注条目结构：{ user, ai, mark?, ts }
//   user = 用户的思考（看板 🟡 栏）；ai = 助手的思考（🔵 栏）；
//   mark = 用户在这段划过线 —— 只做标记，**不算评论**（避免把划线当成想法）。
// 传进来的字段「没给」= 保持原状；给空字符串 = 清空；三者都空 = 删除该段条目。
function mergeNotes(patch) {
  const cur = readNotes();
  const has = (o, x) => o != null && Object.prototype.hasOwnProperty.call(o, x);
  let changed = 0;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!/^\d+$/.test(k)) continue;
    const before = cur[k] || {};
    const user = has(v, "user") ? String(v.user ?? "").trim() : before.user || "";
    const ai = has(v, "ai") ? String(v.ai ?? "").trim() : before.ai || "";
    const mark = has(v, "mark") ? !!v.mark : !!before.mark;
    if (!user && !ai && !mark) {
      if (cur[k]) {
        delete cur[k];
        changed++;
      }
      continue;
    }
    if (before.user === user && before.ai === ai && !!before.mark === mark) continue; // 没变化就不写
    const next = { user, ai, ts: v?.ts ?? Date.now() };
    if (mark) next.mark = true;
    cur[k] = next;
    changed++;
  }
  fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
  fs.writeFileSync(NOTES_PATH, JSON.stringify(cur));
  return { changed, total: Object.keys(cur).length };
}

// ---------------------------------------------------------------------------
// 微信读书 → 共读批注 同步
//   划线 → 只标 mark（看板「🟡 你划过线」，不当评论）；想法 → 写 user（🟡 你的思考）。
//   只动 user/mark，AI 的 🔵 原样保留。
// ---------------------------------------------------------------------------
const stripMarkup = (s) => String(s ?? "").replace(/<[^>]+>/g, "").trim();

function normMatch(s) {
  return String(s ?? "")
    .replace(/\.epub$/i, "")
    .replace(/[\s\u00a0\u3000]+/g, "")
    .replace(/[《》「」『』【】“”‘’"'’]/g, "")
    .toLowerCase();
}

// 书名噪声词：版本 / 装帧 / 站点来源……跨版本比对时先抹掉。
// 为什么需要：微信读书读的常是官方版，交给 AI 的却是别处下的版本，
// 文件名会多出「精装版 / 全X册 / z-library.sk」这类差异，不抹掉就永远配不上。
const NAME_NOISE =
  /(epub|mobi|azw3?|pdf|txt|docx?|扫描版|影印版|精装|平装|典藏|珍藏|纪念版|新版|全本|完整版|修订版|增订版|插图版|注释版|双语版|中文版|简体版|繁体版|全集|文集|套装|合集|合辑|全[一二三四五六七八九十\d]*册|第[一二三四五六七八九十百\d]+版|zlib|zlibrary|z-library|1lib|libgen|annasarchive|annas-archive|libsk|thepiratebay|epubee|kindle|amazon|unknown|undefined|administrator|佚名)/gi;

const stripNoise = (s) => String(s ?? "").replace(NAME_NOISE, "");
// 去掉括号（圆括号/方括号）里的内容 —— 作者名、站点名、丛书名都在里面
const dropBrackets = (s) => String(s ?? "").replace(/[（(【\[][^）)】\]]*[）)】\]]/g, " ");

/**
 * 书名的「可比对形态」：去扩展名 → 去括号 → 去版本噪声 → 归一化。
 * 「示例书 (某作者) (z-library.sk).epub」→「示例书」
 */
function nameClean(s) {
  return normMatch(stripNoise(dropBrackets(String(s ?? "").replace(/\.epub$/i, ""))));
}

/**
 * 把书名/文件名切成若干可比较的词：括号外的正文 + 括号里的每一段，再按分隔符拆。
 * 「示例书 (某作者) (z-library.sk).epub」→ ["示例书", "某作者"]
 * 为什么需要：自己导入微信读书的 EPUB，那本书的笔记标题常常变成**作者名**
 * （导入书的 title 会是作者名、author 是站点生成的占位串），得靠这些词兜底。
 */
function nameTokens(s) {
  const raw = String(s ?? "").replace(/\.epub$/i, "");
  const out = [];
  const push = (x) => {
    for (const w of normMatch(stripNoise(x)).split(/[·:：,，、_/／|~～\-—+&]+/)) {
      if (w.length >= 3 && !out.includes(w)) out.push(w);
    }
  };
  push(dropBrackets(raw));
  for (const m of raw.matchAll(/[（(]([^）)]*)[）)]/g)) push(m[1]);
  if (!out.length) push(raw);
  return out;
}

// 最长公共子串长度（书名都短，O(n·m) 够用）——用于「换了译本 / 改了副标题」的近似匹配
function lcsLen(a, b) {
  if (!a || !b) return 0;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 给一个微信读书笔记本打相似度分（0~1）。
 * 想「别那么精准也认得出」，但**不能乱认**：标题必须有实打实的重合；
 * 作者只做加成、不单独决定（否则同一作者的其他书会被误配）。
 */
function scoreNotebook(want, entry) {
  const nTitle = entry?.book?.title || entry?.title || "";
  const nAuthor = entry?.book?.author || entry?.author || "";
  const tClean = nameClean(nTitle);
  const tTokens = nameTokens(nTitle);
  let s = 0;
  if (tClean && want.cleans.includes(tClean)) s = 1;
  else if (tClean) {
    for (const w of want.tokens) {
      for (const c of tTokens.length ? tTokens : [tClean]) {
        if (!c) continue;
        if (w === c) s = Math.max(s, 0.9);
        else {
          const L = lcsLen(w, c);
          // 最长公共子串要够长、且占较长那个词的比重够大，才算「像」（避免短书名到处碰瓷）
          if (L >= 3) s = Math.max(s, 0.5 + (0.4 * L) / Math.max(w.length, c.length));
        }
      }
    }
  }
  const aClean = nameClean(nAuthor);
  const aHit =
    !!want.author && !!aClean && (aClean === want.author || (want.author.length >= 3 && aClean.includes(want.author)));
  if (s >= 0.5 && aHit) s = Math.min(1, s + 0.06); // 作者一致：只加成，不独自决定
  return { bookId: entry?.bookId, title: nTitle, author: nAuthor, score: Math.round(s * 100) / 100 };
}

/** 共读书名的所有比对信号：原始名 / 真实书名 / 文件名 → 词 + 归一化形态 + 作者 */
function wantOf(coread) {
  const m = coread?.meta || {};
  const names = [m.book, m.title, m.file].filter((x) => x && String(x).trim());
  const tokens = [];
  const cleans = [];
  for (const x of names) {
    for (const t of nameTokens(x)) if (!tokens.includes(t)) tokens.push(t);
    const c = nameClean(x);
    if (c && !cleans.includes(c)) cleans.push(c);
  }
  return { names, tokens, cleans, author: nameClean(m.author || "") };
}

const MATCH_MIN = 0.7; // 自动匹配的下限；低于它只给候选，绝不硬凑

export function matchSegments(segments, anchor, maxInside = 3, maxContaining = 3) {
  const key = normMatch(anchor);
  if (key.length < 4) return [];
  const inside = [];
  const containing = [];
  for (const s of segments) {
    const ns = normMatch(s.text);
    if (!ns) continue;
    if (ns.includes(key)) {
      inside.push(s.id);
      if (inside.length >= maxInside) break;
    } else if (ns.length >= 6 && key.includes(ns)) {
      containing.push(s.id);
    }
  }
  return inside.length ? inside : containing.slice(0, maxContaining);
}

/**
 * 把 bookmarks / myReviews 映射成 { 段id → { texts:[想法…], mark:bool } }
 *
 *   - 纯划线（bookmark）→ 只把该段标成 mark=true，**不写进 user**。
 *     看板据此在段落上打「🟡 你划过线」标记，而不是把你的划线当成你的评论。
 *   - 想法（review）→ 文字进 texts（看板 🟡 栏）；它通常附着在一段划线原文上，
 *     所以顺带把命中的段也标 mark=true。
 */
export function buildUserNotes(coread, bookmarks, reviews) {
  const map = new Map();
  let hlHit = 0,
    hlMiss = 0,
    thHit = 0,
    thMiss = 0;

  const ensure = (id) => {
    if (!map.has(id)) map.set(id, { texts: [], mark: false });
    return map.get(id);
  };

  for (const b of bookmarks?.updated || []) {
    const t = b?.markText || "";
    if (!t.trim()) continue;
    const ids = matchSegments(coread.segments, t);
    if (ids.length) hlHit++;
    else hlMiss++;
    for (const id of ids) ensure(id).mark = true;
  }
  for (const it of reviews?.reviews || []) {
    const r = it?.review || {};
    const anchor = r.abstract || stripMarkup(r.htmlContent) || "";
    const thought = stripMarkup(r.content) || stripMarkup(it?.content) || "";
    if (!anchor.trim() && !thought.trim()) continue;
    const ids = matchSegments(coread.segments, anchor || thought);
    if (ids.length) thHit++;
    else thMiss++;
    for (const id of ids) {
      const e = ensure(id);
      if (anchor.trim()) e.mark = true;
      if (thought && !e.texts.includes(thought)) e.texts.push(thought);
    }
  }
  return { map, hlHit, hlMiss, thHit, thMiss };
}

/**
 * 在「有笔记的书」里按相似度找 bookId。
 * 匹配不上（或不够像）就只回候选书单 + 分数，让用户在看板上点选绑定 —— 不硬凑。
 */
async function resolveBookId(coread, explicit) {
  if (explicit) return { bookId: String(explicit), matched: "手动指定" };
  let list = [];
  let note = null;
  try {
    const nb = await callGateway("/user/notebooks", { count: 100 });
    list = nb.books || nb.notebooks || [];
  } catch (e) {
    note = String(e?.message ?? e);
    list = [];
  }
  const want = wantOf(coread);
  const scored = list
    .map((b) => scoreNotebook(want, b))
    .filter((x) => x.bookId)
    .sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 10);
  const best = scored[0];
  if (!best || best.score < MATCH_MIN) return { bookId: null, candidates, note };
  const second = scored[1];
  const ambiguous = !!(second && second.score >= MATCH_MIN && second.score >= best.score - 0.05);
  const how = best.score >= 1 ? "书名" : best.score >= 0.9 ? "书名/作者关键词" : "近似书名";
  return {
    bookId: best.bookId,
    title: best.title,
    matched: `${how}（${best.score}）`,
    score: best.score,
    ambiguous,
    candidates,
  };
}

export async function syncUserNotes({ bookId } = {}) {
  const coread = getCoread();
  const want = wantOf(coread);
  const bindKey = want.cleans[0] || "";

  const pull = (id) =>
    Promise.all([
      callGateway("/book/bookmarklist", { bookId: id }),
      callGateway("/review/list/mine", { bookid: id, count: 100 }),
    ]);

  let r = null;
  if (bookId) {
    r = { bookId: String(bookId), matched: "手动指定" };
    const all = readBinds();
    all[bindKey] = { bookId: String(bookId), title: "", ts: Date.now() };
    writeBinds(all);
  } else if (bindKey) {
    const bound = readBinds()[bindKey];
    if (bound?.bookId) r = { bookId: bound.bookId, title: bound.title, matched: "沿用上次绑定" };
  }

  let bookmarks, myReviews;
  if (r) {
    try {
      [bookmarks, myReviews] = await pull(r.bookId);
    } catch (e) {
      if (bookId) throw e; // 手动指定的失败，如实报错
      const all = readBinds(); // 绑定失效 → 清掉，回到自动匹配
      if (all[bindKey]) {
        delete all[bindKey];
        writeBinds(all);
      }
      r = null;
    }
  }
  if (!r) {
    r = await resolveBookId(coread, undefined);
    if (!r.bookId) {
      const out = {
        ok: false,
        error: "微信读书里没找到与共读书名匹配的笔记本，可在看板上点选一本绑定",
        want: coread?.meta?.book || null,
        candidates: r.candidates || [],
      };
      if (r.note) out.hint = r.note;
      return out;
    }
    [bookmarks, myReviews] = await pull(r.bookId);
    const all = readBinds();
    all[bindKey] = { bookId: r.bookId, title: r.title || "", ts: Date.now() };
    writeBinds(all);
  }
  const built = buildUserNotes(coread, bookmarks, myReviews);
  const notes = readNotes();
  let written = 0;
  for (const [id, e] of built.map) {
    const k = String(id);
    const user = e.texts.join(" / ");
    const mark = !!e.mark;
    const before = notes[k] || {};
    if (before.user === user && !!before.mark === mark) continue; // 没变化就不写
    const next = { user, ai: before.ai || "", ts: Date.now() };
    if (mark) next.mark = true;
    notes[k] = next;
    written++;
  }
  if (written) {
    fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
    fs.writeFileSync(NOTES_PATH, JSON.stringify(notes));
  }
  const entries = Object.values(notes);
  return {
    ok: true,
    book: { id: r.bookId, title: r.title || null },
    matched: r.matched || null, // 命中的方式（书名 / 作者关键词 / 近似），便于核对
    score: r.score ?? null,
    ambiguous: !!r.ambiguous, // 有另一本分数接近 → 提示可能选错，可显式传 bookId
    highlights: (bookmarks?.updated || []).length,
    thoughts: (myReviews?.reviews || []).length,
    matchedSegments: built.map.size,
    markedSegments: entries.filter((n) => n?.mark).length,
    written,
    unmatched: { highlights: built.hlMiss, thoughts: built.thMiss },
    totalAnnotated: entries.length,
  };
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
  // 章结构兜底：整本正文挤在一个 xhtml 里的 EPUB，「按文件切章」等于没切，
  // 这里按正文里的章节标记（第X部/章 …）重切一次，否则看板全挂在一章下面。
  if (!data.meta) data.meta = {};
  if (chaptersLookDegenerate(data.meta, data.segments)) {
    data.meta.chapters = deriveChapters(data.segments, data.meta.title || data.meta.book || "");
  }
  const raw = JSON.stringify(data);
  try {
    fs.mkdirSync(path.dirname(COREAD_PATH), { recursive: true });
    fs.writeFileSync(COREAD_PATH, raw);
  } catch (e) {
    return res.status(500).json({ error: "写入失败：" + e.message, path: COREAD_PATH });
  }
  console.log(`[weread-mcp] 已保存共读数据 → ${COREAD_PATH}（${data.segments.length} 段）`);
  res.json({ ok: true, key: "coread", path: COREAD_PATH, book: data.meta?.book ?? null, segments: data.segments.length, chapters: (data.meta?.chapters || []).length, bytes: raw.length });
});

app.get("/coread", (req, res) => {
  if (!authOk(req) && String(req.query.token || "") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const data = readJson(COREAD_PATH);
  const annotated = Object.keys(readNotes()).length;
  const bindKey = data ? wantOf(data).cleans[0] || "" : "";
  const bound = bindKey ? readBinds()[bindKey] || null : null;
  if (!data) return res.json({ uploaded: false, path: COREAD_PATH, annotated });
  res.json({
    uploaded: true,
    path: COREAD_PATH,
    book: data.meta?.book ?? null,
    author: data.meta?.author ?? null,
    segments: data.segments?.length ?? 0,
    annotated,
    linked: bound ? { bookId: bound.bookId, title: bound.title || null } : null, // 已绑定的微信读书笔记本
  });
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

// 从微信读书拉「我的划线 + 想法」→ 写 🟡 栏（保留 AI 的 🔵）
app.post("/coread/sync", express.json({ limit: "1mb" }), async (req, res) => {
  if (!authOk(req) && String(req.query.token || "") !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const bookId = req.body?.bookId || req.query.bookId || undefined;
  try {
    const out = await syncUserNotes({ bookId });
    res.status(out.ok ? 200 : 404).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, name: "weread-mcp-server", dashboard: "/dashboard", coread: "/coread", notes: "/coread/notes", search: "/coread/search", sync: "/coread/sync" })
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
