/**
 * 看板前端交互烟测 —— 在 jsdom 里真跑页面脚本。
 * 覆盖：只渲染有批注的段落 / 划线≠评论 / 章节折叠与跳转 / 保存后自动收起编辑器 /
 *       保存写服务器 / 页尾下载与同步提示条 / 书架进度百分比不越界。
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
    totalSegments: 4,
    chapters: [
      { idx: 0, title: "第一章", segStart: 1, segEnd: 2 },
      { idx: 1, title: "第二章", segStart: 3, segEnd: 4 },
    ],
  },
  segments: [
    { id: 1, ch: 0, chTitle: "第一章", text: "第一段正文。" },
    { id: 2, ch: 0, chTitle: "第一章", text: "第二段正文。" },
    { id: 3, ch: 1, chTitle: "第二章", text: "第三段正文。" },
    { id: 4, ch: 1, chTitle: "第二章", text: "第四段正文。" },
  ],
};
// 第 1 段：有想法 + 助手批注；第 4 段：只有划线标记（mark），没有想法
const notes = { "1": { user: "已有批注", ai: "已有助手批注" }, "4": { mark: true } };

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
let syncMode = "ok"; // ok | cands —— 控制假 /coread/sync 返回什么
window.fetch = (url, opts = {}) => {
  calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
  if (String(url).includes("coread/search")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ hits: [{ id: 3, chTitle: "第二章", text: "第三段正文。", snippet: "…第三段正文…" }] }),
    });
  }
  if (String(url).includes("coread/sync")) {
    if (syncMode === "cands") {
      return Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({
            ok: false,
            error: "微信读书里没找到与共读书名匹配的笔记本",
            want: "测试书",
            candidates: [
              { bookId: "B1", title: "测试书", author: "某作者", score: 1 },
              { bookId: "B9", title: "另一本不相干的书", author: "", score: 0.3 },
            ],
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, highlights: 3, thoughts: 2, markedSegments: 3, written: 4 }) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, changed: 1, total: 1 }) });
};

// ---------- 1. 只渲染有批注的段落 ----------
const segs = doc.querySelectorAll("#coread .seg");
check("只渲染 2 段（有想法的第 1 段 + 只划线的第 4 段）", segs.length === 2, `${segs.length}`);
check("含第 1 段正文", doc.getElementById("coread").textContent.includes("第一段正文"));
check("不含第 2 段正文", !doc.body.textContent.includes("第二段正文"));
check("不含第 3 段正文", !doc.body.textContent.includes("第三段正文"));
check("显示段号", /第 1 段/.test(doc.getElementById("seg-1").textContent));
check("共读页没有搜索框（原文由人类在微信读书里读）", !doc.getElementById("cr-q") && !doc.querySelector("#coread .cr-search"), "");
check("共读页没有搜索结果区", !doc.getElementById("cr-hits"));
check("有同步提示条（默认隐藏）", doc.getElementById("sync-bar").hidden === true);
check("页尾统计 2 段", /已批注\s*2\s*段/.test(doc.getElementById("foot-hint").textContent), doc.getElementById("foot-hint").textContent);
check("编辑器里没有下载按钮", doc.querySelectorAll("#editor button.dl").length === 0);
check("页尾有下载按钮", doc.querySelectorAll("#coread .cr-foot button.dl").length === 1);
check("编辑器初始隐藏", doc.getElementById("editor").hidden === true);
check("共读书名去掉了 .epub 后缀", /当前共读：<b>测试书<\/b>/.test(doc.querySelector(".cr-book").innerHTML), doc.querySelector(".cr-book").innerHTML.slice(0, 80));

// ---------- 1b. 划线 ≠ 评论 ----------
const s4 = doc.getElementById("seg-4");
check("只划线的段落也渲染出来", !!s4);
check("只划线显示「🟡 你划过线」", /🟡 你划过线/.test(s4.textContent), s4.textContent);
check("划线没有伪装成「🟡 你：」评论", !/🟡 你：/.test(s4.textContent), s4.textContent);
check("划线段落带 hl 类", /(^|\s)hl(\s|$)/.test(s4.className), s4.className);

// ---------- 1c. 章节目录条 ----------
{
  const toc = doc.getElementById("cr-toc");
  check("有章节目录条", !!toc);
  const chips = toc ? toc.querySelectorAll("button.toc-i") : [];
  check("目录条列出 2 章", chips.length === 2, `${chips.length}`);
  check("目录条带章名与条数", /第一章/.test(chips[0].textContent) && /1/.test(chips[0].textContent), chips[0] && chips[0].textContent);
  check("有「全部收起」按钮", !!doc.getElementById("toc-all"));
  check("每章一个折叠区", doc.querySelectorAll("#coread .cr-ch").length === 2);
  check("第 1 段在第 1 章里", doc.getElementById("crch-0").contains(doc.getElementById("seg-1")));
  check("章标题可点（就地折叠）", !!doc.querySelector("#crch-0 .cth") && typeof window.tgCh === "function");
}

// ---------- 1d. 章折叠 / 全部收起 ----------
{
  const sec0 = doc.getElementById("crch-0");
  const body0 = sec0.querySelector(".ch-body");
  const th0 = sec0.querySelector(".cth");
  check("默认展开", body0.hidden === false);
  th0.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("点章标题 → 该章收起", body0.hidden === true);
  check("收起后带 fold 类（箭头转向）", /(^|\s)fold(\s|$)/.test(sec0.className), sec0.className);
  th0.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("再点 → 展开", body0.hidden === false);

  const all = doc.getElementById("toc-all");
  all.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("「全部收起」收掉两章", doc.querySelectorAll("#coread .ch-body[hidden]").length === 2, `${doc.querySelectorAll("#coread .ch-body[hidden]").length}`);
  check("按钮变成「全部展开」", /全部展开/.test(all.textContent), all.textContent);
  all.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("「全部展开」展开两章", doc.querySelectorAll("#coread .ch-body:not([hidden])").length === 2);
  check("按钮变回「全部收起」", /全部收起/.test(all.textContent), all.textContent);
}

// ---------- 1e. 点目录跳章 ----------
{
  const sec1 = doc.getElementById("crch-1");
  const body1 = sec1.querySelector(".ch-body");
  // 先收起，验证跳转会顺带展开
  sec1.querySelector(".cth").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("第 2 章已收起", body1.hidden === true);
  window.jumpCh(1);
  check("跳转会把目标章展开", body1.hidden === false);
  check("跳转后目录高亮该章", /(^|\s)on(\s|$)/.test(doc.querySelectorAll("button.toc-i")[1].className), doc.querySelectorAll("button.toc-i")[1].className);
  check("跳转时章标题闪一下", /(^|\s)flash(\s|$)/.test(sec1.querySelector(".cth").className));
  check("跳到不存在的章不报错", (() => { try { window.jumpCh(99); return true } catch (e) { return false } })());
}

// ---------- 2. 点段落 → 编辑器 ----------
segs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("点段落后编辑器出现", doc.getElementById("editor").hidden === false);
check("记录当前段 id = 1", window.cur === 1, `cur=${window.cur}`);
check("回填已有批注", doc.getElementById("edit-user").value === "已有批注" && doc.getElementById("edit-ai").value === "已有助手批注");
check("已有的闻舟批注显示成「🔵 闻舟：」", /🔵 闻舟：/.test(doc.getElementById("seg-1").textContent), doc.getElementById("seg-1").textContent);
check("页面上不再出现「🔵 助手：」", !/🔵 助手：/.test(doc.body.textContent));
check("编辑器里有「收起」按钮", !!doc.querySelector("#editor .ed-row button.cx"));

// ---------- 2b. 收起 / 再点同段切换 ----------
{
  doc.querySelector("#editor .ed-row button.cx").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("点「收起」→ 编辑器收回", doc.getElementById("editor").hidden === true);
  check("收起后段落选中态也清掉", !/(^|\s)on(\s|$)/.test(doc.getElementById("seg-1").className), doc.getElementById("seg-1").className);
  segs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("再点该段 → 编辑器又出来", doc.getElementById("editor").hidden === false);
  segs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("再点一次同一段 → 又收回（切换）", doc.getElementById("editor").hidden === true);
  segs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // 留给后续用例：编辑器打开
  const ed = doc.getElementById("editor");
  check("编辑器回到编辑器跟随被点段落", doc.getElementById("seg-1").nextElementSibling === ed);
}

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

// ---------- 5b. 给「只划线」的段落补想法：mark 不会被丢掉 ----------
doc.getElementById("seg-4").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("点划线段落：你的批注框是空的（划线不等于评论）", doc.getElementById("edit-user").value === "" && doc.getElementById("edit-ai").value === "");
const tu2 = doc.getElementById("edit-user");
tu2.value = "我给这段补个想法";
tu2.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(750);
doc.getElementById("btn-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
const mc = calls[calls.length - 1];
check("保存时带上 mark:true", mc.body?.["4"]?.mark === true, JSON.stringify(mc.body));
check("同时写入新想法", mc.body?.["4"]?.user === "我给这段补个想法", JSON.stringify(mc.body));
check("段落上出现了「🟡 你：」", /🟡 你：/.test(doc.getElementById("seg-4").textContent), doc.getElementById("seg-4").textContent);

// ---------- 6. 同步提示条在页尾 ----------
{
  const html = doc.getElementById("coread").innerHTML;
  check("cr-foot 在 sync-bar 之前（提示条压尾）", html.indexOf('class="cr-foot"') < html.indexOf('id="sync-bar"'), "cr-foot@" + html.indexOf('class="cr-foot"') + " sync-bar@" + html.indexOf('id="sync-bar"'));
  check("同步提示条自带 hidden（0 条时不显示）", doc.getElementById("sync-bar").hidden === true);
}

// ---------- 7. 页尾下载 ----------
doc.querySelector("#coread .cr-foot button.dl").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("页尾按钮下载 coread-notes.json", downloaded?.name === "coread-notes.json", JSON.stringify(downloaded));

// ---------- 8. 导入区还在 ----------
check("有导入原书的折叠区", !!doc.querySelector("details.imp"));
check("有拖拽区与文件选择", !!doc.getElementById("drop") && !!doc.getElementById("epub-file"));

// ---------- 9. 同步微信读书划线 ----------
check("有「同步微信读书」按钮", !!doc.getElementById("btn-sync"));
check("按钮在共读面板里", !!doc.querySelector("#coread .cr-tools #btn-sync"));
check("按钮文案含「同步微信读书」", /同步微信读书/.test(doc.getElementById("btn-sync").textContent));
doc.getElementById("btn-sync").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
const syncCall = calls.find((c) => c.url.includes("coread/sync"));
check("点击后 POST /coread/sync", !!syncCall, JSON.stringify(calls.map((c) => c.url)));
check("按钮点后进入同步中/已同步状态", /同步中|已同步/.test(doc.getElementById("btn-sync").textContent), doc.getElementById("btn-sync").textContent);
check("同步结果显示在提示行", /已同步/.test(doc.getElementById("sync-hint").textContent), doc.getElementById("sync-hint").textContent);

// ---------- 10. 匹配不上 → 列候选，点一本即绑定 ----------
check("候选区默认隐藏", doc.getElementById("cr-cands").hidden === true);
syncMode = "cands";
doc.getElementById("btn-sync").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
const box = doc.getElementById("cr-cands");
check("候选区展开", box.hidden === false);
check("候选里有可点的书", !!box.querySelector("button.cand"));
check("候选带书名与相似度分数", /测试书/.test(box.textContent) && !!box.querySelector("button.cand .cs"), box.textContent.slice(0, 60));
check("文案说明没自动认出", /没自动认出/.test(box.textContent), box.textContent.slice(0, 60));
check("提示行引导点选", /点选/.test(doc.getElementById("sync-hint").textContent), doc.getElementById("sync-hint").textContent);
check("匹配不上不算失败：按钮恢复可点", doc.getElementById("btn-sync").disabled === false);

syncMode = "ok";
box.querySelector("button.cand").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
const bindCall = calls[calls.length - 1];
check("点候选 → 带 bookId 再发同步", bindCall.url.includes("coread/sync") && bindCall.body?.bookId === "B1", JSON.stringify(bindCall));
check("绑定后提示已绑定并同步", /已绑定并同步/.test(doc.getElementById("sync-hint").textContent), doc.getElementById("sync-hint").textContent);
check("候选区收起", doc.getElementById("cr-cands").hidden === true);

// ---------- 12. 保存完自动收起编辑器 ----------
{
  doc.getElementById("seg-1").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("开始前编辑器是开着的", doc.getElementById("editor").hidden === false);
  const tu = doc.getElementById("edit-user");
  tu.value = "写完这句就收起";
  tu.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(700); // 等自动暂存（600ms）
  doc.getElementById("btn-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  check("保存后先给出提示", /已写入服务器/.test(doc.getElementById("save-hint").textContent), doc.getElementById("save-hint").textContent);
  check("保存后浮动提示亮起（收起后也看得见）", /(^|\s)on(\s|$)/.test(doc.getElementById("cr-toast").className), doc.getElementById("cr-toast").className);
  await sleep(800);
  check("保存后编辑器自动收起", doc.getElementById("editor").hidden === true);
  check("自动收起后段落选中态清掉", !/(^|\s)on(\s|$)/.test(doc.getElementById("seg-1").className));
  check("内容已落到段落上（没收起成空）", /写完这句就收起/.test(doc.getElementById("seg-1").textContent), doc.getElementById("seg-1").textContent);
}

// ---------- 13. 书架卡片：进度百分比必须留在卡片里 ----------
{
  const shelfData = {
    shelf: {},
    nbBooks: [
      {
        bookId: "B1",
        book: { title: "示例书", author: "某作者", deepLink: "https://example.test/book" },
        sort: 1760000000,
        readingProgress: { percent: 36 },
      },
    ],
    nbTotal: 1,
    details: {
      B1: {
        bookmark: { updated: [{ chapterUid: 1, markText: "示例划线一句", createTime: 1760000000 }], chapters: [{ chapterUid: 1, title: "第一章" }] },
        review: { reviews: [] },
      },
    },
  };
  const h = render(shelfData, { generatedAt: "2026-01-01" });
  check("进度条 + 百分比都渲染", h.includes('class="prog"') && h.includes('<b class="pv">36%</b>'), "");
  check("百分比紧跟进度条（同一个 .bs 行里）", /class="prog"><span class="pb" style="width:36%"><\/span><\/span><b class="pv">36%<\/b>/.test(h), "");
  check("不再用会掉出卡片的绝对定位", !h.includes(".prog b{position:absolute"), "");
  check("书卡里有「闻舟批注区」", h.includes("闻舟批注区") && !h.includes("助手批注区"), "");
  check("页脚不再写 AI", !h.includes("🔵AI") && h.includes("🔵闻舟"), "");
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
