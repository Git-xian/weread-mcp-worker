/**
 * 看板前端交互烟测（保存按钮 / 页尾下载批注 / 批注增删）—— 在 jsdom 里真跑页面脚本。
 *
 *   npm i -D jsdom     # 没装就自动跳过，不影响其它测试
 *   node test/smoke-dashboard-dom.mjs
 *
 * 页面由 render() 现场合成（不需要网关、不需要真实数据）。
 */
import { render } from "../src/dashboard.js";

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("跳过：未安装 jsdom（npm i -D jsdom 后可跑本测试）");
  process.exit(0);
}

const coread = {
  meta: { book: "测试书.epub", totalSegments: 3 },
  segments: [
    { id: 1, ch: 0, chTitle: "第一章", text: "第一段正文。", user: "已有批注", ai: "已有助手批注" },
    { id: 2, ch: 0, chTitle: "第一章", text: "第二段正文。", user: "", ai: "" },
    { id: 3, ch: 1, chTitle: "第二章", text: "第三段正文。", user: "", ai: "" },
  ],
};

const html = render(
  { shelf: {}, nbBooks: [], nbTotal: 0, details: {} },
  { generatedAt: "2026-01-01", coread }
);

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

let downloaded = null;
window.URL.createObjectURL = () => "blob:fake";
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {
  if (this.download) downloaded = { name: this.download };
};

// ---------- 布局：下载批注必须在页尾，保存按钮在编辑器里 ----------
const foot = doc.querySelector("#coread .cr-foot");
const segs = doc.querySelectorAll("#coread .seg");
check("共读页渲染出 3 段", segs.length === 3, `${segs.length}`);
check("存在页尾操作条", !!foot);
check("页尾只有一个下载按钮", doc.querySelectorAll("#coread .cr-foot button.dl").length === 1);
check("编辑器里没有下载按钮", doc.querySelectorAll("#editor button.dl").length === 0);
check("编辑器里有保存按钮", /保存/.test(doc.getElementById("btn-save").textContent));
check("页尾排在所有段落之后",
  !!(segs[segs.length - 1].compareDocumentPosition(foot) & window.Node.DOCUMENT_POSITION_FOLLOWING));
check("初始批注数 = 1", /已暂存\s*1\s*条/.test(doc.getElementById("foot-hint").textContent),
  doc.getElementById("foot-hint").textContent);
check("编辑器初始隐藏", doc.getElementById("editor").hidden === true);

// ---------- 点一个空白段落 → 编辑器跟随 ----------
segs[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("点段落后编辑器出现", doc.getElementById("editor").hidden === false);
check("编辑器排在被点段落之后",
  !!(segs[1].compareDocumentPosition(doc.getElementById("editor")) & window.Node.DOCUMENT_POSITION_FOLLOWING));
check("记录当前段 id = 2", window.cur === 2, `cur=${window.cur}`);
check("载入已有批注：第 1 段回填", (() => {
  segs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return doc.getElementById("edit-user").value === "已有批注" && doc.getElementById("edit-ai").value === "已有助手批注";
})());

// ---------- 输入 → 自动暂存 ----------
segs[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const taU = doc.getElementById("edit-user");
taU.value = "我写的批注";
taU.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(750);
check("输入后自动暂存", JSON.parse(window.localStorage.getItem("coread-notes") || "{}")["2"]?.user === "我写的批注");
check("段落上出现 🟡 批注", /我写的批注/.test(doc.getElementById("seg-2").textContent));
check("页尾计数 +1 → 2", /已暂存\s*2\s*条/.test(doc.getElementById("foot-hint").textContent),
  doc.getElementById("foot-hint").textContent);

// ---------- 保存按钮 ----------
const btn = doc.getElementById("btn-save");
btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("保存按钮给出「已保存」", /已保存/.test(btn.textContent), btn.textContent);
check("保存提示带时间", /已保存到本机/.test(doc.getElementById("save-hint").textContent),
  doc.getElementById("save-hint").textContent);
check("保存后内容仍在", JSON.parse(window.localStorage.getItem("coread-notes") || "{}")["2"]?.user === "我写的批注");

// ---------- 清空两个框 + 保存 = 删除该段批注 ----------
taU.value = "";
const taA = doc.getElementById("edit-ai");
taA.value = "";
taA.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(750);
check("清空后该段批注被移除", !JSON.parse(window.localStorage.getItem("coread-notes") || "{}")["2"]);
check("段落上的批注标记消失", !/🟡 你：/.test(doc.getElementById("seg-2").textContent));
check("页尾计数回到 1", /已暂存\s*1\s*条/.test(doc.getElementById("foot-hint").textContent));

// ---------- 页尾下载 ----------
doc.querySelector("#coread .cr-foot button.dl").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("页尾按钮下载 coread-notes.json", downloaded?.name === "coread-notes.json", JSON.stringify(downloaded));

// ---------- 导入区 ----------
check("有导入原书的折叠区", !!doc.querySelector("details.imp"));
check("有拖拽区与文件选择", !!doc.getElementById("drop") && !!doc.getElementById("epub-file"));
check("页面脚本无未捕获错误", true);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
