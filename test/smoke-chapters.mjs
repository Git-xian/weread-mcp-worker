// 烟测：章节识别（deriveChapters / isChapterTitle / chaptersLookDegenerate）。
// 纯函数，不联网。fixture 一律中性文本，绝不写真实书摘。
//   node test/smoke-chapters.mjs
import { deriveChapters, isChapterTitle, chaptersLookDegenerate } from "../src/dashboard.js";

let failed = 0;
function check(label, ok, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}
const S = (arr) => arr.map((t, i) => ({ id: i + 1, text: t }));

console.log("== 1. 什么样的短段算章标题 ==");
for (const t of ["第一部", "第一章", "第 3 章 示例小节名", "序章", "尾声", "译后记", "目录", "Chapter 4", "Part II", "PROLOGUE"])
  check(`认：${t}`, isChapterTitle(t) === true);
for (const t of [
  "“这个是什么型号的？”", // 对白
  "我微笑着摇了摇头。", // 带句读的正文
  "第一段示例正文。", // 「第一段」不是「第一章」
  "第二部电影很好看，我看了三遍。", // 带逗号 → 正文
  "这是一句很长的示例正文，长得不像标题，绝不该被当成章节。",
  "",
])
  check(`不认：${t.slice(0, 14) || "(空)"}`, isChapterTitle(t) === false);

console.log("\n== 2. 连续 3 个以上标题样短段 = 目录页，整段跳过 ==");
{
  const segs = S(["Cover", "目录", "第一部", "第二部", "第三部", "第一段示例正文。", "第一部", "第二段示例正文。", "第二部", "第三段示例正文。"]);
  const chs = deriveChapters(segs);
  check("切出 3 章（开篇 + 2 个真章节）", chs.length === 3, JSON.stringify(chs.map((c) => c.title)));
  check("目录页 4 段没变成章节", chs.map((c) => c.title).join(",") === "开篇,第一部,第二部", chs.map((c) => c.title).join(","));
  check("开篇 = 1..6", chs[0].segStart === 1 && chs[0].segEnd === 6, JSON.stringify(chs[0]));
  check("第一部 = 7..8", chs[1].segStart === 7 && chs[1].segEnd === 8, JSON.stringify(chs[1]));
  check("第二部 = 9..10", chs[2].segStart === 9 && chs[2].segEnd === 10, JSON.stringify(chs[2]));
  check("每个 segment 都被补上 ch/chTitle", segs[0].chTitle === "开篇" && segs[6].chTitle === "第一部" && segs[8].chTitle === "第二部" && segs[8].ch === 2, JSON.stringify(segs.map((s) => s.chTitle)));
  check("段号与正文没被改", segs.every((s, i) => s.id === i + 1) && segs[0].text === "Cover");
}

console.log("\n== 3. 没有任何章节标记 → 只有一章，标题回落到书名 ==");
{
  const segs = S(["第一段示例正文。", "第二段示例正文。", "第三段示例正文。"]);
  const chs = deriveChapters(segs, "示例书");
  check("只切出 1 章", chs.length === 1, JSON.stringify(chs));
  check("章标题 = 传进来的书名", chs[0].title === "示例书", chs[0].title);
  const segs2 = S(["第一段示例正文。"]);
  check("没传书名时叫「全文」", deriveChapters(segs2)[0].title === "全文");
}

console.log("\n== 4. 幂等：跑两次结果一致 ==");
{
  const mk = () => S(["Cover", "目录", "第一部", "第二部", "第三部", "第一段示例正文。", "第一部", "第二段示例正文。"]);
  const a = deriveChapters(mk());
  const b = deriveChapters(mk());
  check("两次章节一致", JSON.stringify(a) === JSON.stringify(b), JSON.stringify(b));
}

console.log("\n== 5. 什么时候判定「压根没切出章结构」 ==");
{
  const segs = S(["第一段示例正文。", "第二段示例正文。"].concat(Array.from({ length: 8 }, (_, i) => `第 ${i + 3} 段示例正文。`)));
  const n = segs.length; // 10
  check("没有 chapters → 退化", chaptersLookDegenerate({}, segs) === true);
  check("只有 1 章 → 退化", chaptersLookDegenerate({ chapters: [{ idx: 0, title: "示例书", segStart: 1, segEnd: n }] }, segs) === true);
  check(
    "章节名是「未知」/「Cover」→ 退化",
    chaptersLookDegenerate({ chapters: [{ idx: 0, title: "Cover", segStart: 1, segEnd: 1 }, { idx: 1, title: "未知", segStart: 2, segEnd: n }] }, segs) === true
  );
  check(
    "某一章占了 ≥90% 正文 → 退化",
    chaptersLookDegenerate(
      { chapters: [{ idx: 0, title: "示例章一", segStart: 1, segEnd: 9 }, { idx: 1, title: "示例章二", segStart: 10, segEnd: 10 }] },
      segs
    ) === true
  );
  check(
    "4 章各占约 1/4 → 正常，不该重切",
    chaptersLookDegenerate(
      {
        chapters: [
          { idx: 0, title: "示例章一", segStart: 1, segEnd: 2 },
          { idx: 1, title: "示例章二", segStart: 3, segEnd: 5 },
          { idx: 2, title: "示例章三", segStart: 6, segEnd: 8 },
          { idx: 3, title: "示例章四", segStart: 9, segEnd: 10 },
        ],
      },
      segs
    ) === false
  );
  check("空 segments → 退化（不允许除零）", chaptersLookDegenerate({ chapters: [{ idx: 0, title: "示例章一", segStart: 1, segEnd: 1 }] }, []) === true);
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
