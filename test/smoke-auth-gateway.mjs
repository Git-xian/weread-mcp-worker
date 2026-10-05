import worker from "../src/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function call(body, headers = {}, env = {}) {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, text: await res.text() };
}

const TI = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

const noAuth = await call(TI, {}, { MCP_AUTH_TOKEN: "secret123" });
console.log("无 token ->", noAuth.status, "(期望 401):", noAuth.text.slice(0, 80));

const withAuth = await call(TI, { Authorization: "Bearer secret123" }, { MCP_AUTH_TOKEN: "secret123" });
console.log("带正确 token ->", withAuth.status, "(期望 200)");

const wrongAuth = await call(TI, { Authorization: "Bearer wrong" }, { MCP_AUTH_TOKEN: "secret123" });
console.log("带错误 token ->", wrongAuth.status, "(期望 401)");

// key 文件路径不写死：优先环境变量，其次当前用户桌面
const KEY_FILE = process.env.WEREAD_KEY_FILE || path.join(os.homedir(), "Desktop", "wxds.txt");
let key = "";
try { key = fs.readFileSync(KEY_FILE, "utf8").trim(); } catch {}
if (key) {
  const r = await call(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "weread_endpoints", arguments: {} } },
    {},
    { WEREAD_API_KEY: key }
  );
  console.log("\n真实网关 /_list ->", r.status);
  console.log(r.text.slice(0, 260));
} else {
  console.log(`\n未找到 ${KEY_FILE}，跳过真实调用`);
}
