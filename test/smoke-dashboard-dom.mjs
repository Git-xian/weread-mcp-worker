/**
 * 看板前端交互烟测 —— 在 jsdom 里真跑页面脚本。
 * 覆盖：只渲染有批注的段落 / 搜索原文加批注 / 保存写服务器 / 页尾下载。
 *
 *   npm i jsdom --no-save    # 没装就自动跳过，不影响其它测试
 *   node test/smoke-dashboard-dom.mjs
 */
import { render } from "../src/dashboard.js";

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("跳过：未安装 jsdom（npm i jsdom --no-save 后可跑本测试）");
  process.exit(0);
}

const coread = {
  meta: {
    book: "测试书.epub",
    totalSegments: 3,
    chapters: [
      { idx: 0, title: "第一章", segStart: 1, segEnd: 2 },
      { idx: 1, title: "第二章", segStart: 3, segEnd: 3 },
    ],
  },
  segments: [
    { id: 1, ch: 0, chTitle: "第一章", text: "第一段正文。" },
    { id: 2, ch: 0, chTitle: "第一章", text: "第二段正文。" },
    { id: 3, ch: 1, chTitle: "第二章", text: "第三段正文。" },
  ],
};
// 批注只存在于第 1 段
const notes = { "1": { user: "已有批注", ai: "已有助手批注" } };

const html = render({ shelf: {}, nbBooks: [], nbTotal: 0, details: {} }, { generatedAt: "2026-01-01", coread, notes });

let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/dashboard?token=t",
});
const { window } = dom;
const doc = window.document;

// ---- 打桩：下载、fetch ----
let downloaded = null;
window.URL.createObjectURL = () => "blob:fake";
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {
  if (this.download) downloaded = { name: this.download };
};

const calls = [];
window.fetch = (url, opts = {}) => {
  calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
  if (String(url).includes("coread/search")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ hits: [{ id: 3, chTitle: "第二章", text: "第三段正文。", snippet: "…第三段正文…" }] }),
    });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, changed: 1, total: 1 }) });
};

// ---------- 1. 只渲染有批注的段落 ----------
const segs = doc.querySelectorAll("#coread .seg");
check("只渲染 1 段（只有第 1 段有批注）", segs.length === 1, `${segs.length}`);
check("含第 1 段正文", doc.getElementById("coread").textContent.includes("第一段正文"));
check("不含第 2 段正文", !doc.body.textContent.includes("第二段正文"));
check("不含第 3 段正文", !doc.body.textContent.includes("第三段正文"));
check("显示段号", /第 1 段/.test(doc.getElementById("seg-1").textContent));
check("有搜索原文入口", !!doc.getElementById("cr-q"));
check("有同步提示条（默认隐藏）", doc.getElementById("sync-bar").hidden === true);
check("页尾统计 1 段", /已批注\s*1\s*段/.test(doc.getElementById("foot-hint").textContent), doc.getElementById("foot-hint").textContent);
check("编辑器里没有下载按钮", doc.querySelectorAll("#editor button.dl").length === 0);
check("页尾有下载按钮", doc.querySelectorAll("#coread .cr-foot button.dl").length === 1);
check("编辑器初始隐藏", doc.getElementById("editor").hidden === true);

// ---------- 2. 点段落 → 编辑器 ----------
segs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("点段落后编辑器出现", doc.getElementById("editor").hidden === false);
check("记录当前段 id = 1", window.cur === 1, `cur=${window.cur}`);
check("回填已有批注", doc.getElementById("edit-user").value === "已有批注" && doc.getElementById("edit-ai").value === "已有助手批注");

// ---------- 3. 输入 → 本机暂存（不写服务器）----------
const before = calls.length;
const taU = doc.getElementById("edit-user");
taU.value = "我改了一下";
taU.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(750);
check("输入后本机暂存", JSON.parse(window.localStorage.getItem("coread-notes") || "{}")["1"]?.user === "我改了一下");
check("自动暂存不写服务器", calls.length === before, `${calls.length} vs ${before}`);
check("段落上即时显示新批注", /我改了一下/.test(doc.getElementById("seg-1").textContent));

// ---------- 4. 保存 → 写服务器 ----------
doc.getElementById("btn-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(50);
const noteCall = calls.find((c) => c.url.includes("coread/notes"));
check("保存发了 POST /coread/notes", !!noteCall, JSON.stringify(calls.map((c) => c.url)));
check("body 是 { id: {user, ai} }", noteCall?.body?.["1"]?.user === "我改了一下", JSON.stringify(noteCall?.body));
check("提示已写入服务器", /已写入服务器/.test(doc.getElementById("save-hint").textContent), doc.getElementById("save-hint").textContent);

// ---------- 5. 清空 + 保存 = 删除该段批注 ----------
const taA = doc.getElementById("edit-ai");
taU.value = "";
taA.value = "";
taA.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(750);
doc.getElementById("btn-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(50);
const lastCall = calls[calls.length - 1];
check("删除时 body 为空串", lastCall.body?.["1"]?.user === "" && lastCall.body?.["1"]?.ai === "", JSON.stringify(lastCall.body));
check("段落上的批注标记消失", !/🟡 你：/.test(doc.getElementById("seg-1").textContent));

// ---------- 6. 搜索原文 → 加段落 → 写批注 ----------
doc.getElementById("cr-q").value = "第三段";
window.crSearch();
await sleep(60);
check("搜索结果渲染出来了", /第三段正文/.test(doc.getElementById("cr-hits").textContent), doc.getElementById("cr-hits").textContent.slice(0, 80));
const hit = doc.querySelector("#cr-hits .hit");
check("有可点结果", !!hit);
if (hit) hit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("搜索到的段落被加进列表", !!doc.getElementById("seg-3"));
check("新段落显示未批注标记", /未批注/.test(doc.getElementById("seg-3")?.textContent || ""));
check("编辑器跟到新段落", window.cur === 3, `cur=${window.cur}`);

// ---------- 7. 页尾下载 ----------
doc.querySelector("#coread .cr-foot button.dl").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("页尾按钮下载 coread-notes.json", downloaded?.name === "coread-notes.json", JSON.stringify(downloaded));

// ---------- 8. 导入区还在 ----------
check("有导入原书的折叠区", !!doc.querySelector("details.imp"));
check("有拖拽区与文件选择", !!doc.getElementById("drop") && !!doc.getElementById("epub-file"));

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
