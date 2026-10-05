/**
 * 把看板渲染成静态 HTML 文件（真实网关数据），方便本地预览。
 *   node test/render-to-file.mjs [books] [coread.json]
 * 若 preview/coread.json 存在（或命令行指定），会带上共读页一起渲染。
 * 输出：preview/dashboard-preview.html
 */
import worker from "../src/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_FILE = process.env.WEREAD_KEY_FILE || path.join(os.homedir(), "Desktop", "wxds.txt");
let key = "";
try { key = fs.readFileSync(KEY_FILE, "utf8").trim(); } catch { }

if (!key) {
  console.error("没找到 key 文件，无法拉真实数据:", KEY_FILE);
  process.exit(1);
}

const env = { MCP_AUTH_TOKEN: "preview-token", WEREAD_API_KEY: key };
const books = process.argv[2] || "10";

// 可选共读数据：命令行路径 > preview/coread.json。用模拟 KV 绑定注入（避免超长 URL）。
const coreadPath = process.argv[3] || path.join(process.cwd(), "preview", "coread.json");
if (fs.existsSync(coreadPath)) {
  const obj = JSON.parse(fs.readFileSync(coreadPath, "utf8"));
  env.COREAD_KV = { get: async () => obj };
  console.log("带上共读数据:", coreadPath, "|", obj.segments?.length ?? 0, "段");
} else {
  console.log("无共读数据（共读页显示占位）");
}

const res = await worker.fetch(
  new Request(`http://localhost/dashboard?token=preview-token&books=${books}`),
  env
);
const html = await res.text();

const outDir = path.join(process.cwd(), "preview");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "dashboard-preview.html");
fs.writeFileSync(outFile, html, "utf8");

console.log("status:", res.status, "|", res.headers.get("content-type"));
console.log("size:", (html.length / 1024).toFixed(1), "KB");
console.log("written ->", outFile);
