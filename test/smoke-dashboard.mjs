/**
 * 看板烟测：直接挂载 Worker 的 fetch 处理器，验证 /dashboard 路由。
 *   node test/smoke-dashboard.mjs
 * Key 从 WEREAD_KEY_FILE 或「当前用户桌面的 wxds.txt」读取（只为真实调用，不打印）。
 */
import worker from "../src/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_FILE = process.env.WEREAD_KEY_FILE || path.join(os.homedir(), "Desktop", "wxds.txt");
let key = "";
try {
  key = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch {
  /* 没 key 就只测鉴权分支 */
}
console.log(key ? "key 已加载：wrk-***" + key.slice(-4) : "未找到 key 文件（只测鉴权分支）");

const env = { MCP_AUTH_TOKEN: "test-token" };
if (key) env.WEREAD_API_KEY = key;

async function call(p) {
  const res = await worker.fetch(new Request("http://localhost" + p), env);
  return { status: res.status, ct: res.headers.get("content-type"), text: await res.text() };
}

// 1) 无 token 应被拒
const noTok = await call("/dashboard");
console.log("无 token ->", noTok.status, "(期望 403)");

// 2) 正确 token
if (key) {
  const r = await call("/dashboard?token=test-token&books=3");
  console.log("带 token ->", r.status, "|", r.ct, "|", Math.round(r.text.length / 1024), "KB");
  const checks = {
    "标题「共读看板」": r.text.includes("共读看板"),
    "双 Tab 容器": r.text.includes('class="tabs"'),
    "📖 共读 Tab": r.text.includes('id="tab-coread"'),
    "📚 书架 Tab": r.text.includes('id="tab-shelf"'),
    "共读页 / 书架页": r.text.includes('id="page-coread"') && r.text.includes('id="page-shelf"'),
    "书脊色条书卡": r.text.includes("bc-spine"),
    "汇总行": r.text.includes('class="sum-line"'),
    "助手批注区": r.text.includes("助手批注区"),
    "搜索框": r.text.includes('class="search"'),
    "是完整 HTML": r.text.startsWith("<!DOCTYPE html>"),
  };
  for (const [k, v] of Object.entries(checks)) console.log("   ", v ? "✓" : "✗", k);
  console.log("   → 结论:", Object.values(checks).every(Boolean) ? "通过" : "有缺失");
} else {
  const r = await call("/dashboard?token=test-token");
  console.log("无 key 时 ->", r.status, "(期望 500)");
}
