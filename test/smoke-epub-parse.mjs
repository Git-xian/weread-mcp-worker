// 烟测：浏览器内 EPUB 解析器（src/dashboard.js 里的 EPUB_PARSE_JS）
// 直接取出页面里跑的同一段源码，在 Node 里跑，覆盖 stored / deflate 两种压缩。
//   node test/smoke-epub-parse.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EPUB_PARSE_JS } from "../src/dashboard.js";

const parseEpub = new Function(EPUB_PARSE_JS + "\nreturn parseEpub;")();

// 最小 zip 写入器（解析器不校验 CRC，故 CRC 填 0）
function buildZip(entries, useDeflate) {
  const locals = [], cdir = [];
  let off = 0;
  for (const [name, dataBuf] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = useDeflate ? zlib.deflateRawSync(dataBuf) : dataBuf;
    const method = useDeflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(dataBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(off, 42);
    cdir.push(ch, nameBuf);
    off += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(cdir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
 <manifest>
  <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  <item id="c2" href="sub/ch2.xhtml" media-type="application/xhtml+xml"/>
 </manifest>
 <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const CH1 = `<html><head><title>第一章 城市</title></head><body>
<p>城市就像梦境。</p><p>忽必烈问 &amp; 答 &mdash; 马可回答 &#x3002;</p><li>列表项 abc</li>
</body></html>`;
const CH2 = `<html><head><title>第二章 记忆</title></head><body>
<p>他把旅行写成了重读。</p>
</body></html>`;

const files = [
  ["META-INF/container.xml", Buffer.from('<?xml version="1.0"?><container/>', "utf8")],
  ["OEBPS/content.opf", Buffer.from(OPF, "utf8")],
  ["OEBPS/ch1.xhtml", Buffer.from(CH1, "utf8")],
  ["OEBPS/sub/ch2.xhtml", Buffer.from(CH2, "utf8")],
];

let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

for (const useDeflate of [false, true]) {
  const tag = useDeflate ? "deflate" : "stored";
  const zip = buildZip(files, useDeflate);
  const data = await parseEpub(zip, `demo-${tag}.epub`, () => {});
  const texts = data.segments.map((s) => s.text);
  check(`[${tag}] 段数 = 4`, data.segments.length === 4, `got ${data.segments.length}`);
  check(`[${tag}] 按 spine 顺序（第1章在前）`, texts[0] === "城市就像梦境。", texts[0]);
  check(`[${tag}] 保持章节标题`, data.segments[0].chTitle === "第一章 城市" && data.segments[3].chTitle === "第二章 记忆",
    `${data.segments[0].chTitle} / ${data.segments[3].chTitle}`);
  check(`[${tag}] 实体解码（&amp; &mdash; &#x3002;）`,
    texts[1] === "忽必烈问 & 答 — 马可回答 。", texts[1]);
  check(`[${tag}] 子目录 href 归一化（OEBPS/sub/ch2.xhtml 命中）`, texts[3] === "他把旅行写成了重读。", texts[3]);
  check(`[${tag}] meta 完整`, data.meta.book === `demo-${tag}.epub` && data.meta.totalSegments === 4 && data.meta.chapters.length === 2);
  check(`[${tag}] 段 id 从 1 递增`, data.segments.every((s, i) => s.id === i + 1));
}

// 与 python 端产出结构对齐（tools/coread-export.py 的字段）
{
  const data = await parseEpub(buildZip(files, true), "x.epub", () => {});
  const keys = Object.keys(data.segments[0]).sort().join(",");
  check("段字段与 coread-export.py 一致", keys === "ai,ch,chTitle,id,text,user", keys);
}

// 非 zip 应报错而不卡死
{
  let msg = "";
  try {
    await parseEpub(Buffer.from("not a zip at all"), "bad.epub", () => {});
  } catch (e) {
    msg = e.message;
  }
  check("非法文件给出明确报错", /不是有效的 EPUB/.test(msg), msg);
}

// 真实 demo.epub（python make_test_epub.py 的产物，位于系统临时目录）也过一遍
{
  const p = path.join(os.tmpdir(), "test-epub", "demo.epub");
  if (fs.existsSync(p)) {
    const d = await parseEpub(fs.readFileSync(p), "demo.epub", () => {});
    check("真实 demo.epub 解析出段落", d.segments.length > 0, `${d.segments.length} 段`);
  } else {
    console.log("- 跳过 demo.epub（未生成）");
  }
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
