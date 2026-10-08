#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
epub-split.py — 把 EPUB 拆成「段」并存 SQLite，供看板「📖 共读」逐段对照（纯标准库）。

EPUB 本质是 zip + html，这里用 zipfile + 简易 HTML 文本抽取，不需要 ebooklib。
只做本地解析，不联网、不上传。

用法:
  python tools/epub-split.py <book.epub> <输出目录>

产物（输出目录下）:
  segments.db   表 segments(id, chapter_idx, chapter_title, para_idx, text)
  book.json     { book, chapters[], totalSegments, dbPath }

下一步: python tools/coread-export.py <输出目录> coread.json --b64
"""
import json, os, re, sqlite3, sys, zipfile, html as html_mod

BLOCK = re.compile(r"<(p|h[1-6]|li|blockquote|div)[^>]*>(.*?)</\1>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")


def html_to_blocks(raw):
    """把一章的 html 拆成段落文本列表。"""
    raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw, flags=re.S | re.I)
    out = []
    for m in BLOCK.finditer(raw):
        text = html_mod.unescape(TAG.sub("", m.group(2))).strip()
        text = re.sub(r"\s+", " ", text)
        if len(text) >= 2:  # 丢掉纯标点/空段
            out.append(text)
    if not out:  # 兜底：整页文本
        text = html_mod.unescape(TAG.sub("", raw)).strip()
        if text:
            out = [p.strip() for p in re.split(r"\n+", text) if len(p.strip()) >= 2]
    return out


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: python tools/epub-split.py <book.epub> <输出目录>")
    epub_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    db_path = os.path.join(out_dir, "segments.db")

    z = zipfile.ZipFile(epub_path)
    # 找 spine 顺序（简化：按 opf 里的 spine；找不到就按文件名排序）
    opf_name, spine_files = None, []
    for n in z.namelist():
        if n.endswith(".opf"):
            opf_name = n
            break
    meta_title, meta_author = "", ""
    if opf_name:
        opf = z.read(opf_name).decode("utf-8", "ignore")
        base = os.path.dirname(opf_name)
        # 取 EPUB 自己的书名/作者（dc:title / dc:creator）——
        # 文件名常被下载站改得面目全非，书内元数据才更可能跟微信读书的书名对上
        m = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", opf, re.S | re.I) or \
            re.search(r"<title[^>]*>(.*?)</title>", opf, re.S | re.I)
        if m:
            meta_title = html_mod.unescape(TAG.sub("", m.group(1))).strip()
        m = re.search(r"<dc:creator[^>]*>(.*?)</dc:creator>", opf, re.S | re.I)
        if m:
            meta_author = html_mod.unescape(TAG.sub("", m.group(1))).strip()
        manifest = dict(re.findall(r'<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf))
        for idref in re.findall(r'<itemref[^>]*idref="([^"]+)"', opf):
            href = manifest.get(idref)
            if href:
                full = os.path.normpath(os.path.join(base, href)).replace("\\", "/")
                spine_files.append(full)
    if not spine_files:
        spine_files = sorted(n for n in z.namelist() if n.lower().endswith((".xhtml", ".html")))

    chapters, seg_idx = [], 0
    db = sqlite3.connect(db_path)
    db.execute("CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY, chapter_idx INT, chapter_title TEXT, para_idx INT, text TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS chapters (idx INTEGER PRIMARY KEY, title TEXT, seg_start INT, seg_end INT)")
    for ci, name in enumerate(spine_files):
        try:
            raw = z.read(name).decode("utf-8", "ignore")
        except KeyError:
            continue
        title_m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
        title = html_mod.unescape(title_m.group(1)).strip() if title_m else os.path.basename(name)
        blocks = html_to_blocks(raw)
        if not blocks:
            continue
        seg_start = seg_idx
        for pi, text in enumerate(blocks):
            db.execute("INSERT INTO segments (chapter_idx, chapter_title, para_idx, text) VALUES (?,?,?,?)",
                       (ci, title, pi, text))
            seg_idx += 1
        chapters.append({"idx": ci, "title": title, "segStart": seg_start, "segEnd": seg_idx})
    db.commit()
    meta = {"book": meta_title or os.path.basename(epub_path), "title": meta_title,
            "author": meta_author, "file": os.path.basename(epub_path),
            "chapters": chapters, "totalSegments": seg_idx, "dbPath": db_path}
    with open(os.path.join(out_dir, "book.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    db.close()
    print(f"✓ {len(chapters)} 章 / {seg_idx} 段 → {db_path}")


if __name__ == "__main__":
    main()
