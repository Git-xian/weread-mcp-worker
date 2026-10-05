#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
coread-upload.py —— 一条命令把 EPUB 变成看板的共读数据。

把「拆书 → 导出 → 上传」三步合成一步，直接喂给服务：

  # 用 EPUB（自动拆段后上传）
  python tools/coread-upload.py 你的书.epub --url https://xxx.com --token 你的口令

  # 也可以直接传已经导出的 coread.json
  python tools/coread-upload.py coread.json --url https://xxx.com --token 你的口令

--url  服务地址，/mcp、/dashboard 结尾都行，会自动截到根；末尾带 ?token= 也会自动识别
--token 访问口令（也可用环境变量 MCP_AUTH_TOKEN）
--keep  保留中间产物（segments.db / coread.json），默认用临时目录

不联网的地方：拆书 / 导出都在本地完成，只把结果 JSON POST 给服务。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

import io as _io
if hasattr(sys.stdout, "buffer"):
    sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = _io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd):
    r = subprocess.run([sys.executable] + cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit((r.stderr or r.stdout or "子步骤失败").strip())
    return (r.stdout or "").strip()


def base_url(u):
    """把 .../mcp、.../dashboard、.../ 统一截成根。"""
    u = u.strip()
    if "?" in u:
        q = urllib.parse.urlparse(u).query
        u = u.split("?", 1)[0]
    else:
        q = ""
    for suffix in ("/mcp", "/dashboard", "/coread"):
        if u.endswith(suffix):
            u = u[: -len(suffix)]
    out = u.rstrip("/")
    tok = urllib.parse.parse_qs(q).get("token", [""])[0]
    return out, tok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="EPUB 文件，或已导出的 coread.json")
    ap.add_argument("--url", required=True, help="服务地址，如 https://xxx.com（/mcp 结尾也可）")
    ap.add_argument("--token", default=os.environ.get("MCP_AUTH_TOKEN", ""), help="访问口令（默认取环境变量 MCP_AUTH_TOKEN）")
    ap.add_argument("--keep", action="store_true", help="保留中间产物")
    a = ap.parse_args()

    root, url_token = base_url(a.url)
    token = a.token or url_token
    if not token:
        sys.exit("缺少口令：加 --token 你的口令（或设环境变量 MCP_AUTH_TOKEN，或让 --url 带上 ?token=）")

    src = os.path.abspath(a.source)
    if not os.path.exists(src):
        sys.exit(f"找不到文件：{src}")

    tmp = None
    if src.lower().endswith(".epub"):
        if a.keep:
            work = os.path.join(os.path.dirname(src), os.path.splitext(os.path.basename(src))[0] + "-coread")
            os.makedirs(work, exist_ok=True)
        else:
            tmp = tempfile.mkdtemp(prefix="coread-")
            work = tmp
        print(f"① 拆 EPUB → {work}")
        run([os.path.join(HERE, "epub-split.py"), src, work])
        coread_path = os.path.join(work, "coread.json")
        print("② 导出 coread.json")
        print("   " + run([os.path.join(HERE, "coread-export.py"), work, coread_path]).replace("\n", "\n   "))
    else:
        coread_path = src
        print(f"① 直接用现成的 {os.path.basename(src)}")

    with open(coread_path, "rb") as f:
        body = f.read()
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception as e:
        sys.exit(f"不是合法的 coread.json：{e}")

    endpoint = root + "/coread"
    print(f"③ 上传 → {endpoint}（{len(body) / 1024:.1f} KB，{len(data.get('segments', []))} 段）")
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "coread-upload"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕开本机代理
    try:
        with opener.open(req, timeout=120) as r:
            res = json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            j = json.loads(raw or "{}")
            msg = j.get("error", raw)
            if j.get("hint"):
                msg += "：" + j["hint"]
        except Exception:
            msg = raw[:300]
        sys.exit(f"上传失败 {e.code}：{msg}")
    except Exception as e:
        sys.exit(f"连不上 {endpoint}：{e}")

    print(f"✓ 已保存《{res.get('book') or '?'}》· {res.get('segments', '?')} 段")
    print(f"  打开看板：{root}/dashboard?token=<你的口令>")
    if tmp:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
