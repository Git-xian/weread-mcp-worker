#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
coread-export.py — 把 epub_split.py 拆出来的共读库，导出成远程看板能吃的 coread.json。

共读库目录（epub_split.py 的产物）通常含：
  book.json           书名 / 段落总数等
  segments.db         SQLite，表 segments(id, chapter_idx, chapter_title, para_idx, text)
  coread-notes.json   批注 {"<segId>": {"user": "...", "ai": "..."}}（可无）

用法：
  python coread-export.py <共读库目录> [输出 coread.json] [--b64]

  --b64   额外打印 base64url 编码（可直接拼到 /dashboard?coread=<b64>）

远程看板加载方式：
  · Cloudflare / Node：把 coread.json 放进 KV（键 coread）或 serve 的目录，
    然后用 ?coread=<路径|b64> 传入；Node 版也可设环境变量 COREAD_FILE。
"""
import base64
import json
import os
import sqlite3
import sys

import io as _io
if hasattr(sys.stdout, "buffer"):
    sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = _io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    want_b64 = "--b64" in sys.argv

    if not args:
        sys.exit("用法: python coread-export.py <共读库目录> [输出 coread.json] [--b64]")

    src = args[0]
    out = args[1] if len(args) > 1 else os.path.join(src, "coread.json")

    book_json = os.path.join(src, "book.json")
    db_path = os.path.join(src, "segments.db")
    notes_path = os.path.join(src, "coread-notes.json")

    if not os.path.exists(db_path):
        sys.exit(f"没找到 segments.db：{db_path}")

    meta = {}
    if os.path.exists(book_json):
        with open(book_json, encoding="utf-8") as f:
            meta = json.load(f)

    notes = {}
    if os.path.exists(notes_path):
        try:
            with open(notes_path, encoding="utf-8") as f:
                notes = json.load(f)
        except Exception as e:
            print(f"（批注文件读取失败，忽略：{e}）", file=sys.stderr)

    db = sqlite3.connect(db_path)
    rows = db.execute(
        "SELECT id, chapter_idx, chapter_title, para_idx, text FROM segments ORDER BY id"
    ).fetchall()
    db.close()

    segments = []
    for r in rows:
        sid, ch, ch_title, _idx, text = r
        n = notes.get(str(sid)) or {}
        segments.append(
            {
                "id": sid,
                "ch": ch,
                "chTitle": ch_title or "",
                "text": text or "",
                "user": n.get("user", ""),
                "ai": n.get("ai", ""),
            }
        )

    payload = {
        "meta": {
            "book": meta.get("book") or os.path.basename(src.rstrip("/\\")),
            "totalSegments": meta.get("totalSegments") or len(segments),
        },
        "segments": segments,
    }

    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    n_notes = sum(1 for s in segments if s["user"] or s["ai"])
    print(f"✓ {out}")
    print(f"  {payload['meta']['book']} · {len(segments)} 段 · {n_notes} 条批注")

    if want_b64:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        b64 = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        print("\nbase64url（拼到 ?coread= 后面）：")
        print(b64)


if __name__ == "__main__":
    main()
