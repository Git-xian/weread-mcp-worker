// 烟测：POST/GET /coread（上传共读数据）。
// 用内存假 KV 和假 fetch，不联网、不碰真 key。
//   node test/smoke-coread.mjs
import worker from "../src/index.js";

function fakeKV() {
  const store = new Map();
  return {
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      store.set(k, v);
    },
    _dump: () => store,
  };
}

const COREAD = {
  meta: { book: "示例书.epub", totalSegments: 2 },
  segments: [
    { id: 1, ch: 0, chTitle: "第一章", text: "第一段示例正文。", user: "划线1", ai: "" },
    { id: 2, ch: 0, chTitle: "第一章", text: "第二段示例正文。", user: "", ai: "助手批注" },
  ],
};

let failed = 0;
function check(label, ok, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}

const req = (method, body, token, path = "/coread") =>
  new Request(`https://x.workers.dev${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

// 1) 没配 MCP_AUTH_TOKEN：拒绝（不允许裸奔写库）
{
  const kv = fakeKV();
  const res = await worker.fetch(req("POST", JSON.stringify(COREAD), ""), { COREAD_KV: kv });
  check("未配置口令 → 401", res.status === 401, `status=${res.status}`);
}

// 2) 口令错 → 401
{
  const kv = fakeKV();
  const res = await worker.fetch(req("POST", JSON.stringify(COREAD), "wrong"), {
    MCP_AUTH_TOKEN: "t0ken",
    COREAD_KV: kv,
  });
  check("口令错误 → 401", res.status === 401, `status=${res.status}`);
}

// 3) 口令对但没绑 KV → 400 + hint
{
  const res = await worker.fetch(req("POST", JSON.stringify(COREAD), "t0ken"), { MCP_AUTH_TOKEN: "t0ken" });
  const j = await res.json();
  check("未绑 KV → 400", res.status === 400 && /KV/.test(j.hint || ""), `status=${res.status}`);
}

// 4) body 不是 JSON 也不是 base64url → 400
{
  const kv = fakeKV();
  const res = await worker.fetch(req("POST", "!!!not json!!!", "t0ken"), { MCP_AUTH_TOKEN: "t0ken", COREAD_KV: kv });
  check("非法 body → 400", res.status === 400, `status=${res.status}`);
}

// 5) 结构不对（缺 segments）→ 400
{
  const kv = fakeKV();
  const res = await worker.fetch(req("POST", JSON.stringify({ meta: {} }), "t0ken"), {
    MCP_AUTH_TOKEN: "t0ken",
    COREAD_KV: kv,
  });
  check("缺 segments → 400", res.status === 400, `status=${res.status}`);
}

// 6) 正常上传 JSON → 200，KV 里是 coread 键
{
  const kv = fakeKV();
  const res = await worker.fetch(req("POST", JSON.stringify(COREAD), "t0ken"), {
    MCP_AUTH_TOKEN: "t0ken",
    COREAD_KV: kv,
  });
  const j = await res.json();
  check("正常上传 → 200 + 回摘要", res.status === 200 && j.ok && j.segments === 2 && j.book === "示例书.epub", JSON.stringify(j));

  // 7) GET 状态：只回摘要
  const s = await worker.fetch(req("GET", null, "t0ken"), { MCP_AUTH_TOKEN: "t0ken", COREAD_KV: kv });
  const sj = await s.json();
  check("GET /coread → 摘要（无正文）", s.status === 200 && sj.uploaded === true && sj.segments === 2 && !("segments" in sj && Array.isArray(sj.segments)));
}

// 8) base64url 上传也能吃
{
  const kv = fakeKV();
  const b64 = Buffer.from(JSON.stringify(COREAD), "utf8").toString("base64url");
  const res = await worker.fetch(req("POST", b64, "t0ken"), { MCP_AUTH_TOKEN: "t0ken", COREAD_KV: kv });
  check("base64url body → 200", res.status === 200, `status=${res.status}`);
}

// 9) 不支持的方法 → 405
{
  const kv = fakeKV();
  const res = await worker.fetch(req("DELETE", null, "t0ken"), { MCP_AUTH_TOKEN: "t0ken", COREAD_KV: kv });
  check("DELETE → 405", res.status === 405, `status=${res.status}`);
}

// 10) 原有路由没被破坏
{
  const res = await worker.fetch(new Request("https://x.workers.dev/"), {});
  const j = await res.json();
  check("GET / → 200 且列出 /coread", res.status === 200 && j.coread === "/coread", JSON.stringify(j));
}
{
  const res = await worker.fetch(new Request("https://x.workers.dev/mcp", { method: "POST", body: "{}" }), { MCP_AUTH_TOKEN: "t0ken" });
  check("/mcp 无口令 → 401（鉴权仍在）", res.status === 401, `status=${res.status}`);
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
