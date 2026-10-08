/**
 * 烟测：微信读书「划线 + 想法」→ 共读看板 🟡 栏 同步
 * 全程本地：微信读书网关用假 fetch 顶掉，不碰真账号。
 * 覆盖：鉴权 / 书名匹配 bookId / 段落定位 / 保留 AI 批注 / 幂等 / 未匹配候选。
 */
import worker, { matchSegments, buildUserNotes } from "../src/index.js";

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
  };
}

// ---- 假微信读书网关 ----
const GATEWAY = {
  "/user/notebooks": {
    books: [
      { bookId: "B1", book: { title: "示例书", author: "示例作者" }, sort: 111 },
      { bookId: "B2", book: { title: "另一本示例书", author: "另一位作者" }, sort: 222 },
      // B3 模拟「自己导入微信读书的 EPUB」：那本书的笔记标题变成了作者名、作者是站点占位串
      { bookId: "B3", book: { title: "示例作者", author: "Administrator" }, sort: 333 },
      // B5 与 B1 是同一系列的续篇，用于验证「近似书名」能认出来、但不会压过精确命中
      { bookId: "B5", book: { title: "示例书续篇", author: "" }, sort: 555 },
    ],
  },
  "/book/bookmarklist": {
    updated: [
      { bookmarkId: 1, chapterUid: 10, markText: "第二段示例正文，含一句独特的话。" },
      { bookmarkId: 2, chapterUid: 10, markText: "这句在书里根本找不到" },
    ],
  },
  "/review/list/mine": {
    reviews: [{ review: { reviewId: "r1", abstract: "第一段示例正文。", content: "我在这里的想法" } }],
  },
};
const hitApis = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  hitApis.push(body.api_name);
  const r = GATEWAY[body.api_name];
  if (!r) return new Response(JSON.stringify({ errcode: 1, errmsg: "no route " + body.api_name }), { status: 200 });
  return new Response(JSON.stringify({ errcode: 0, ...r }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const BASE = "https://x.test";
const auth = { Authorization: "Bearer " + TOK };

const COREAD = {
  meta: { book: "示例书.epub", totalSegments: 3, chapters: [{ idx: 0, title: "第一章", segStart: 1, segEnd: 3 }] },
  segments: [
    { id: 1, ch: 0, chTitle: "第一章", text: "第一段示例正文。", user: "", ai: "" },
    { id: 2, ch: 0, chTitle: "第一章", text: "第二段示例正文，含一句独特的话。", user: "", ai: "" },
    { id: 3, ch: 0, chTitle: "第一章", text: "第三段示例正文。", user: "", ai: "" },
  ],
};

async function req(env, path, opts = {}) {
  const r = await worker.fetch(new Request(BASE + path, opts), env);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, json };
}

console.log("\n== 1. 纯函数：段落定位 ==");
{
  check("太短的锚文本直接放弃", matchSegments(COREAD.segments, "第一段").length === 0, "");
  check(
    "整句落在一段内 → 命中该段",
    JSON.stringify(matchSegments(COREAD.segments, "第二段示例正文，含一句独特的话。")) === "[2]",
    JSON.stringify(matchSegments(COREAD.segments, "第二段示例正文，含一句独特的话。"))
  );
  check(
    "跨段锚文本 → 命中被它包住的每一段",
    JSON.stringify(matchSegments(COREAD.segments, "第一段示例正文。第二段示例正文，含一句独特的话。")) === "[1,2]",
    JSON.stringify(matchSegments(COREAD.segments, "第一段示例正文。第二段示例正文，含一句独特的话。"))
  );
  const b = buildUserNotes(COREAD, GATEWAY["/book/bookmarklist"], GATEWAY["/review/list/mine"]);
  check("buildUserNotes 命中 2 段", b.map.size === 2, JSON.stringify([...b.map.keys()]));
  check("未匹配划线计数 = 1", b.hlMiss === 1 && b.hlHit === 1, JSON.stringify({ h: b.hlHit, m: b.hlMiss }));
  check("想法命中 = 1", b.thHit === 1 && b.thMiss === 0, JSON.stringify({ h: b.thHit, m: b.thMiss }));
  // 关键：划线 ≠ 评论。纯划线只打 mark，不产生 user 文字
  check("纯划线只标记、不写 user", b.map.get(2)?.mark === true && b.map.get(2)?.texts.length === 0, JSON.stringify(b.map.get(2)));
  check("想法写进 user、同时标记该段划过线", b.map.get(1)?.texts?.[0] === "我在这里的想法" && b.map.get(1)?.mark === true, JSON.stringify(b.map.get(1)));
}

console.log("\n== 2. 端点鉴权与前置条件 ==");
{
  const e0 = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  const r1 = await req(e0, "/coread/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("无口令 401", r1.status === 401, String(r1.status));

  const r2 = await req(e0, "/coread/sync", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("还没上传原书 → 500 并给出提示", r2.status === 500 && /共读原书/.test(r2.json?.error || ""), JSON.stringify(r2.json));

  const r3 = await req(e0, "/coread/sync", { method: "GET", headers: auth });
  check("GET 405", r3.status === 405, String(r3.status));
}

console.log("\n== 3. 正常同步：写 🟡 栏 + 保留 AI 批注 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  // 预置：第 1 段已有 AI 批注；第 9 段是人工批注（不在原文里，应原样留着）
  await env.COREAD_KV.put("coread-notes", JSON.stringify({ "1": { user: "", ai: "AI 的想法" }, "9": { user: "人工写的", ai: "" } }));
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(COREAD) });

  const r = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("同步 200", r.status === 200, r.status + " " + r.text.slice(0, 140));
  const j = r.json || {};
  check("ok=true", j.ok === true, JSON.stringify(j));
  check("按书名匹配到 B1", j.book?.id === "B1", JSON.stringify(j.book));
  check("划线 2 条 / 想法 1 条", j.highlights === 2 && j.thoughts === 1, JSON.stringify(j));
  check("写入 2 段", j.written === 2 && j.matchedSegments === 2, JSON.stringify(j));
  check("未匹配划线 1 条", j.unmatched?.highlights === 1, JSON.stringify(j.unmatched));
  check("确实调了网关的三个接口", ["/user/notebooks", "/book/bookmarklist", "/review/list/mine"].every((x) => hitApis.includes(x)), hitApis.join(","));

  const g = await req(env, "/coread/notes", { headers: auth });
  const notes = g.json?.notes || {};
  check("第 1 段 user = 我的想法", notes["1"]?.user === "我在这里的想法", JSON.stringify(notes["1"]));
  check("第 1 段 AI 批注被保留", notes["1"]?.ai === "AI 的想法", JSON.stringify(notes["1"]));
  check("第 2 段纯划线：user 为空（没被当成评论）", notes["2"]?.user === "", JSON.stringify(notes["2"]));
  check("第 2 段有 mark 标记", notes["2"]?.mark === true, JSON.stringify(notes["2"]));
  check("第 2 段没有 AI 批注（为空而非丢失）", notes["2"]?.ai === "", JSON.stringify(notes["2"]));
  check("统计 markedSegments = 2", j.markedSegments === 2, JSON.stringify(j));
  check("无关的人工批注原样保留", notes["9"]?.user === "人工写的", JSON.stringify(notes["9"]));

  const r2 = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("再同步一次 → 无变化（written=0）", r2.json?.written === 0, JSON.stringify(r2.json));
}

console.log("\n== 4. 书名匹配不上：给出候选，不乱写 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  const other = { ...COREAD, meta: { ...COREAD.meta, book: "查无此书的标题" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(other) });
  const r = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("返回 404", r.status === 404, String(r.status));
  check("ok=false 且带候选书单", r.json?.ok === false && (r.json?.candidates || []).length === 4, JSON.stringify((r.json?.candidates || []).length));
  check("want 回显共读书名", r.json?.want === "查无此书的标题", JSON.stringify(r.json?.want));
  check("候选里带书名与分数（给看板点选用）", r.json?.candidates?.[0]?.title === "示例书" && typeof r.json?.candidates?.[0]?.score === "number", JSON.stringify(r.json?.candidates?.[0]));
  const g = await req(env, "/coread/notes", { headers: auth });
  check("没写任何批注", (g.json?.total ?? -1) === 0, JSON.stringify(g.json));

  const r2 = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "B2" }),
  });
  check("显式传 bookId 可绕过书名匹配", r2.status === 200 && r2.json?.book?.id === "B2", JSON.stringify(r2.json));
}

console.log("\n== 5. 文件名带站点后缀，仍能按主标题匹配 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  const junk = { ...COREAD, meta: { ...COREAD.meta, book: "示例书 (某作者) (z-library.sk, 1lib.sk).epub" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(junk) });
  const r = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("带后缀的共读书名仍匹配到 B1", r.status === 200 && r.json?.book?.id === "B1", JSON.stringify(r.json));
  check("并且写入了批注", (r.json?.written ?? 0) > 0, JSON.stringify(r.json));
  check("回显的是微信读书里的正式书名", r.json?.book?.title === "示例书", JSON.stringify(r.json?.book));
}

console.log("\n== 6. 导入书的笔记标题变成作者名 → 用文件名里的作者兜底 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  // 书名叫「示例新书」，微信读书那边笔记标题却是「示例作者」（作者被当成了书名）
  const imported = { ...COREAD, meta: { ...COREAD.meta, book: "示例新书 (示例作者) (z-library.sk, 1lib.sk).epub" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(imported) });
  const r = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("主标题对不上时，按作者兜底匹配到 B3", r.status === 200 && r.json?.book?.id === "B3", JSON.stringify(r.json?.book));
  check("返回命中方式（作者/关键词）", /作者/.test(r.json?.matched || ""), JSON.stringify(r.json?.matched));
  check("并且真的写入了批注", (r.json?.written ?? 0) > 0, JSON.stringify(r.json));
}

console.log("\n== 7. 官方版 vs 别处下的版本：名字不完全一样，也认得出 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  // 微信读书读官方版、共读用的是别处下的版本，文件名多了一串站点前缀
  const other = { ...COREAD, meta: { ...COREAD.meta, book: "某站的示例书续篇.epub", file: "某站的示例书续篇.epub" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(other) });
  const r = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("近似书名也匹配到 B5（不因多几个字就卡住）", r.status === 200 && r.json?.book?.id === "B5", JSON.stringify(r.json?.book));
  check("命中方式标为「近似书名」", /近似/.test(r.json?.matched || ""), JSON.stringify(r.json?.matched));
  check("带相似度分数", typeof r.json?.score === "number" && r.json.score >= 0.7, JSON.stringify(r.json?.score));
  check("短书名碰瓷被挡住（另一本示例书不该赢）", r.json?.book?.id !== "B2", JSON.stringify(r.json?.book));
}

console.log("\n== 8. 版本后缀/装帧词不影响匹配 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  const ed = { ...COREAD, meta: { ...COREAD.meta, book: "示例书（精装典藏版）(z-library.sk).epub" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(ed) });
  const r = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  check("去掉「精装典藏版」后缀后精确命中 B1", r.json?.book?.id === "B1" && r.json?.score === 1, JSON.stringify({ b: r.json?.book, s: r.json?.score }));
}

console.log("\n== 9. 点选绑定：选中一次就记住，下次直接用 ==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  const weird = { ...COREAD, meta: { ...COREAD.meta, book: "一本书上完全没有的书名" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(weird) });

  const r1 = await req(env, "/coread/sync?token=" + TOK, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
  check("先自动匹配 → 匹配不上，给候选", r1.status === 404 && (r1.json?.candidates || []).length === 4, JSON.stringify(r1.json?.candidates?.length));

  const r2 = await req(env, "/coread/sync?token=" + TOK, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "B2" }),
  });
  check("按候选点选（传 bookId）→ 同步成功", r2.status === 200 && r2.json?.book?.id === "B2", JSON.stringify(r2.json?.book));

  const r3 = await req(env, "/coread/sync?token=" + TOK, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
  check("再点同步：不重新猜，沿用上次绑定", r3.json?.book?.id === "B2" && /绑定/.test(r3.json?.matched || ""), JSON.stringify({ b: r3.json?.book, m: r3.json?.matched }));

  const g = await req(env, "/coread", { headers: auth });
  check("状态接口回显已绑定的笔记本", g.json?.linked?.bookId === "B2", JSON.stringify(g.json?.linked));
}

console.log("\n== 10. 只靠作者像、书名完全无关 → 不硬认（不写错书）==");
{
  const env = { COREAD_KV: memKV(), MCP_AUTH_TOKEN: TOK, WEREAD_API_KEY: "wrk-dummy" };
  // 作者与 B1 的作者一致，但书名八竿子打不着 —— 不能因此就把 B1 的划线搬过来
  const bait = { ...COREAD, meta: { ...COREAD.meta, book: "完全无关的另一部作品", author: "示例作者" } };
  await req(env, "/coread", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(bait) });
  const r = await req(env, "/coread/sync?token=" + TOK, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
  check("返回 404（作者一致不足以下结论）", r.status === 404 && r.json?.ok === false, JSON.stringify(r.status));
  const g = await req(env, "/coread/notes", { headers: auth });
  check("没写任何批注", (g.json?.total ?? -1) === 0, JSON.stringify(g.json));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
