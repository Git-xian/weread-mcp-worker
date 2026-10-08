/**
 * 烟测：共读批注（KV 分层存）+ 原文搜索 + MCP 4 个新工具 + 看板只渲染有批注的段落
 * 全部本地跑，不碰微信读书网关。
 */
import worker from "../src/index.js";
import { render } from "../src/dashboard.js";

const TOK = "t0ken";
let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, extra ? "→ " + extra : "");
  }
}

function memKV() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
    async delete(k) {
      m.delete(k);
    },
    _m: m,
  };
}

const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
const BASE = "https://x.test";
const auth = { Authorization: "Bearer " + TOK };

const COREAD = {
  meta: {
    book: "测试书.epub",
    totalSegments: 5,
    chapters: [
      { idx: 0, title: "第一章", segStart: 1, segEnd: 3 },
      { idx: 1, title: "第二章", segStart: 4, segEnd: 5 },
    ],
  },
  segments: [
    { id: 1, ch: 0, chTitle: "第一章", text: "第一段示例正文。", user: "", ai: "" },
    { id: 2, ch: 0, chTitle: "第一章", text: "第二段示例正文。", user: "", ai: "" },
    { id: 3, ch: 0, chTitle: "第一章", text: "第三段示例正文。", user: "", ai: "" },
    { id: 4, ch: 1, chTitle: "第二章", text: "第四段示例正文。", user: "", ai: "" },
    { id: 5, ch: 1, chTitle: "第二章", text: "第五段示例正文。", user: "", ai: "" },
  ],
};

async function req(path, opts = {}) {
  const r = await worker.fetch(new Request(BASE + path, opts), env);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, json };
}
const post = (path, body, headers = auth) =>
  req(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function mcp(method, params, id = 1) {
  const r = await req("/mcp", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return r.json;
}

console.log("\n== 1. 上传原文 ==");
{
  const r = await post("/coread", COREAD);
  check("POST /coread 200", r.status === 200, r.status + " " + r.text.slice(0, 120));
  check("返回段数 5", r.json?.segments === 5, JSON.stringify(r.json));
}

console.log("\n== 2. 批注读写 ==");
{
  const r1 = await post("/coread/notes", { 2: { user: "我的想法", ai: "助手想法" } });
  check("POST /coread/notes 200", r1.status === 200, r1.text.slice(0, 120));
  check("changed=1 total=1", r1.json?.changed === 1 && r1.json?.total === 1, JSON.stringify(r1.json));

  const r2 = await post("/coread/notes", { 4: { ai: "只写AI" } });
  check("增量写第二条 → total=2", r2.json?.total === 2, JSON.stringify(r2.json));

  const r3 = await req("/coread/notes", { headers: auth });
  check("GET /coread/notes 两条", r3.json?.total === 2, JSON.stringify(r3.json));
  check(
    "内容正确",
    r3.json?.notes?.["2"]?.user === "我的想法" && r3.json?.notes?.["4"]?.ai === "只写AI",
    JSON.stringify(r3.json?.notes)
  );

  const r4 = await post("/coread/notes", { 2: { user: "", ai: "" } });
  check("空内容=删除该段", r4.json?.total === 1, JSON.stringify(r4.json));

  const r5 = await post("/coread/notes", {}, { "Content-Type": "application/json" });
  check("无口令 401", r5.status === 401, String(r5.status));

  const r6 = await post("/coread/notes", "[1,2]");
  check("数组 body 400", r6.status === 400, String(r6.status));

  const r7 = await post("/coread/notes", { notes: { 5: { ai: "包裹在 notes 里也认" } } });
  check("支持 {notes:{...}} 包裹", r7.json?.total === 2, JSON.stringify(r7.json));
}

console.log("\n== 3. 原文搜索 ==");
{
  const r = await req("/coread/search?q=" + encodeURIComponent("示例") + "&token=" + TOK);
  check("命中 5 段", r.json?.count === 5, JSON.stringify(r.json?.hits?.map((h) => h.id)));
  check("带 snippet", !!r.json?.hits?.[0]?.snippet, JSON.stringify(r.json?.hits?.[0]));
  check("带完整 text", r.json?.hits?.[0]?.text?.includes("示例"), "");
  const r2 = await req("/coread/search?q=zzzz&token=" + TOK);
  check("无命中 count=0", r2.json?.count === 0, JSON.stringify(r2.json));
  const r3 = await req("/coread/search?q=%E7%A4%BA%E4%BE%8B");
  check("无口令 401", r3.status === 401, String(r3.status));
}

console.log("\n== 4. 看板只渲染有批注的段落 ==");
{
  const notes = { 4: { user: "", ai: "只写AI" } };
  const html = render({ shelf: {}, nbBooks: [], nbTotal: 0, details: {} }, { coread: COREAD, notes });
  check("含第 4 段正文", html.includes("第四段示例正文"));
  check("不含第 1 段正文", !html.includes("第一段示例正文"));
  check("不含第 2 段正文", !html.includes("第二段示例正文"));
  check("不含第 5 段正文", !html.includes("第五段示例正文"));
  check("含 AI 批注", html.includes("只写AI"));
  check("条数标注为 1", /共 <b>1<\/b> 条/.test(html), "");
  check("共读页没有搜索框（原文由人类在微信读书里读）", !html.includes('id="cr-q"') && !html.includes('class="cr-search"'));
  check("同步提示条在页尾（cr-foot 之后）", html.indexOf('class="cr-foot"') < html.indexOf('id="sync-bar"'));

  const html0 = render({ shelf: {}, nbBooks: [], nbTotal: 0, details: {} }, { coread: COREAD, notes: {} });
  check("零批注时不出现任何正文", !html0.includes("第一段示例正文") && !html0.includes("第五段示例正文"));
  check("零批注时给空状态", html0.includes("还没有任何划线或批注"));
}

console.log("\n== 5. MCP 工具 ==");
{
  const l = await mcp("tools/list", {});
  const names = (l?.result?.tools || []).map((t) => t.name);
  check("工具数 19（14+5）", names.length === 19, names.length + " → " + names.join(","));
  for (const n of ["coread_outline", "coread_read", "coread_search", "coread_annotate", "coread_sync"])
    check("含 " + n, names.includes(n));

  const o = JSON.parse((await mcp("tools/call", { name: "coread_outline", arguments: {} })).result.content[0].text);
  check("outline 章节数 2 + 书名", o.chapters.length === 2 && o.book === "测试书.epub", JSON.stringify(o));

  const rd = JSON.parse((await mcp("tools/call", { name: "coread_read", arguments: { from: 1, to: 3 } })).result.content[0].text);
  check("read 返回 3 段", rd.segments.length === 3, JSON.stringify(rd).slice(0, 150));
  check("read from/to 正确", rd.from === 1 && rd.to === 3, JSON.stringify({ f: rd.from, t: rd.to }));
  check("read 带正文", rd.segments[0].text.includes("第一段"), "");

  const rd2 = JSON.parse((await mcp("tools/call", { name: "coread_read", arguments: { from: 1, limit: 2 } })).result.content[0].text);
  check("limit 生效 + nextFrom", rd2.segments.length === 2 && rd2.nextFrom === 3, JSON.stringify({ n: rd2.segments.length, next: rd2.nextFrom }));

  const ss = JSON.parse((await mcp("tools/call", { name: "coread_search", arguments: { q: "第三段" } })).result.content[0].text);
  check("search 命中 1 段", ss.count === 1 && ss.hits[0].id === 3, JSON.stringify(ss).slice(0, 120));

  const aa = JSON.parse(
    (await mcp("tools/call", { name: "coread_annotate", arguments: { annotations: [{ id: 1, ai: "AI 的划线思考" }, { id: 3, user: "我的划线思考" }] } })).result.content[0].text
  );
  check("annotate 写入 2 条", aa.ok === true && aa.ids.length === 2, JSON.stringify(aa));

  const chk = await req("/coread/notes", { headers: auth });
  check("落库后共 4 条（4/5 + 新写 1/3）", chk.json?.total === 4, JSON.stringify(chk.json?.total));

  const html2 = render({ shelf: {}, nbBooks: [], nbTotal: 0, details: {} }, { coread: COREAD, notes: chk.json.notes });
  check("看板出现新批注段", html2.includes("第一段示例正文") && html2.includes("第三段示例正文") && html2.includes("AI 的划线思考"));
  check("被删批注的第 2 段不再出现", !html2.includes("第二段示例正文"));
}

console.log("\n== 6. 状态摘要 ==");
{
  const s = await req("/coread?token=" + TOK);
  check("annotated=4", s.json?.annotated === 4, JSON.stringify(s.json));
  const notFound = await req("/coread/nope");
  check("未知路径仍 404", notFound.status === 404, String(notFound.status));
}

console.log("\n== 7. 划线标记（mark）：划线 ≠ 评论 ==");
{
  const r1 = await post("/coread/notes", { 2: { mark: true } });
  check("只写 mark 也能建条目", r1.json?.total === 5, JSON.stringify(r1.json));
  const g1 = await req("/coread/notes", { headers: auth });
  check(
    "mark 条目 user/ai 都为空、mark 为真",
    g1.json?.notes?.["2"]?.user === "" && g1.json?.notes?.["2"]?.ai === "" && g1.json?.notes?.["2"]?.mark === true,
    JSON.stringify(g1.json?.notes?.["2"])
  );

  // 部分更新：只传 ai 时，不能把已有的 user 冲掉
  await post("/coread/notes", { 3: { ai: "补一条AI" } });
  const g2 = await req("/coread/notes", { headers: auth });
  check(
    "只传 ai → 原 user 保留（部分更新语义）",
    g2.json?.notes?.["3"]?.user === "我的划线思考" && g2.json?.notes?.["3"]?.ai === "补一条AI",
    JSON.stringify(g2.json?.notes?.["3"])
  );

  const h = render({ shelf: {}, nbBooks: [], nbTotal: 0, details: {} }, { coread: COREAD, notes: g2.json.notes });
  check("划线段落出现在看板上", h.includes("第二段示例正文"));
  check("渲染成「你划过线」而非「你：<划线原文>」", h.includes("🟡 你划过线") && !/🟡 你：第二段示例正文/.test(h), "");
  check("该段落带 hl 类", /class="seg hl"/.test(h), "");

  const r3 = await post("/coread/notes", { 2: { mark: false } });
  check("清掉 mark 且无内容 → 删除条目", r3.json?.total === 4, JSON.stringify(r3.json));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
