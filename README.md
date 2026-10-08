# 微信读书 · 远程 MCP

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Git-xian/weread-mcp-worker)

把微信读书官方网关的能力包成 **远程 MCP**。手机 App 等**没有本地沙箱**的前端，填一个 URL + 口令就能调用（不需要在你手机上跑任何进程）。

同一个能力，提供**两种运行形态**，按你的部署环境二选一：

| 形态 | 代码 | 跑在哪 | 适合 |
|------|------|--------|------|
| **Cloudflare Workers** | 仓库根目录（`src/` + `wrangler.toml`） | Cloudflare 边缘 | 零运维、免费额度、想要一键按钮 |
| **Node 服务** | `server/` | 你的 **VPS** 或**自己电脑** | 有自己的机器/域名、要绕开 `workers.dev` 被墙 |

> ⚠️ 两份代码**不通用**：Workers 版是 fetch handler，只能在 Cloudflare 跑；VPS/本机请用 `server/`。

- 传输：MCP **Streamable HTTP**（无状态），端点固定 `/mcp`
- **看板**：内置 `GET /dashboard`，双 Tab（**📖 共读** + **📚 书架与笔记**），手机浏览器直接打开
- **共读是「批注看板」**：📖 共读 Tab **只显示被划线/批注过的段落**（🟡 你 / 🔵 闻舟），整本原文**不铺在页面上**，只存在服务器供 AI 阅读
- **划线 ≠ 评论**：你在微信读书画的线只作**标记**（段落黄边 + 「🟡 你划过线」），**只有写下的想法**才进 🟡 栏
- **AI 能读原书**：`coread_outline` / `coread_read` / `coread_search` 读原文，`coread_annotate` 写批注 —— 看板立即可见
- **🟡 栏自动填**：看板上有「**🔄 同步微信读书划线**」按钮，一键把你微信读书里的**想法**按原文对齐写进 🟡 栏（划线同步为标记），也可让 AI 调 `coread_sync`
- **原书导入**：在看板「📖 共读」里**直接拖入 EPUB**（浏览器本地拆段），或用 `tools/coread-upload.py` 一条命令版
- 存储：原文与批注**分开存**（Workers 用 KV / Node 用文件），只有你的 `wrk-` key 放在服务端
- 工具：**19 个** —— 14 个微信读书网关 + 5 个共读原文/批注/同步

---

## 仓库结构

```
├── LICENSE         # MIT
├── src/            # Cloudflare Workers 版（wrangler 入口）
│   ├── index.js    #   MCP 服务 + /dashboard 路由
│   └── dashboard.js #  看板渲染（两种形态共用）：书架页 + 只显示批注的共读页
├── wrangler.toml   #   └ Workers 配置
├── server/         # Node 版（Express + Streamable HTTP）—— VPS / 本机用
│   ├── src/        #   服务 + 网关客户端 + dashboard.js
│   ├── Dockerfile
│   └── .env.example
├── tools/          # 本地预处理（除上传外都不联网）
│   ├── coread-upload.py   # 一条命令：EPUB → 拆段 → 导出 → 上传
│   ├── epub-split.py      # EPUB → segments.db + book.json（把书拆成段）
│   └── coread-export.py   # segments.db → coread.json（看板吃的格式，含批注）
├── deploy/         # VPS 部署配置
│   ├── docker-compose.yml   # app + Caddy（自动 HTTPS）
│   ├── Caddyfile
│   ├── .env.example
│   └── systemd/weread-mcp.service   # 不用 Docker 时用
├── docs/
│   ├── 部署-VPS.md
│   └── 部署-自己电脑.md
└── test/           # Worker 版烟测
```

---

## 选哪条路？

| 你的情况 | 走这条 | 教程 |
|----------|--------|------|
| 有 **VPS + 域名** | **Node 版 + VPS**（推荐，国内可达性最好） | [docs/部署-VPS.md](docs/部署-VPS.md) |
| 想让数据**不出本机**、或先本地跑通 | **Node 版 + 自己电脑** | [docs/部署-自己电脑.md](docs/部署-自己电脑.md) |
| 没有服务器、不想运维 | **Cloudflare Workers**（下方）+ 最好绑自有域名 | 见下方「部署到 Cloudflare」 |

---

# 一、部署到 Cloudflare Workers

## 一键部署（最简单）

本仓库顶部有按钮：

1. 点 **Deploy to Cloudflare Workers**。
2. 授权 Cloudflare → 自动 clone、构建、部署（无需本地环境）。
3. 部署完在 Cloudflare 后台给 Worker **加两个 Secret**（见下方「设置密钥」）。

## 命令行部署

```bash
git clone https://github.com/Git-xian/weread-mcp-worker.git
cd weread-mcp-worker
npm install
npx wrangler login                        # 浏览器授权一次
npx wrangler secret put WEREAD_API_KEY    # 粘贴你的 wrk- key
npx wrangler secret put MCP_AUTH_TOKEN    # 自定义一串随机口令，手机端要用
npx wrangler deploy
```

部署成功会打印形如 `https://weread-mcp.<子域>.workers.dev` 的地址，MCP 端点即 `.../mcp`。

## 本地先跑通

```bash
cp .dev.vars.example .dev.vars   # 填 WEREAD_API_KEY 和 MCP_AUTH_TOKEN
npx wrangler dev                 # http://127.0.0.1:8787/mcp
```

## 设置密钥

两个 Secret（Cloudflare 后台 → Workers → 你的 Worker → Settings → Variables and Secrets，或 `wrangler secret put`）：

| Secret | 说明 |
|--------|------|
| `WEREAD_API_KEY` | 微信读书 `wrk-` 开头的 key，**只存在服务端，绝不外泄** |
| `MCP_AUTH_TOKEN` | 你自定的访问口令。**必须设置**，否则拿到地址的人都能读你的微信读书数据 |

> 未设置 `MCP_AUTH_TOKEN` 时端点不鉴权，仅适合本机调试。

## 导入原书（共读数据，可选）

「📖 共读」Tab 需要一本原书做底：打开 `https://<你的地址>/dashboard?token=<MCP_AUTH_TOKEN>` → **📖 共读** → **把 EPUB 拖进去**，搞定。（拆段在浏览器本地做，EPUB 原件不上传）

导入的只是**原文**，页面本身不会铺开它 —— 只有被批注过的段落才显示；想让 AI 读原文、写批注，见下方 [AI 怎么读原书写批注](#ai-怎么读原书写批注)。

Cloudflare 上要先绑一个 KV（只做一次，见下方[共读数据](#共读数据怎么来导入原书)）；VPS / 本机不用配。
命令行派可以用 `python tools/coread-upload.py 你的书.epub --url <地址> --token <口令>`。

## 国内访问提示

`*.workers.dev` 在**中国大陆常被墙**。两个办法：

1. **绑定自有域名**：Cloudflare 后台 → 你的 Worker → Settings → Domains & Routes → 添加自定义域（域名需已接入 Cloudflare）。
2. **改用 VPS/本机（`server/`）**：直接用你自己的域名，绕开这个墙。

---

# 二、部署到 VPS 或自己电脑

用 `server/`（Node 版）。**完整步骤见教程**：

- VPS：[docs/部署-VPS.md](docs/部署-VPS.md) —— Docker Compose + Caddy 自动 HTTPS，一条命令起服务；也含 systemd / Nginx 反代方式。
- 自己电脑：[docs/部署-自己电脑.md](docs/部署-自己电脑.md) —— 本机直跑 + 局域网访问 + 内网穿透（Cloudflare Tunnel / Tailscale / frp）拿 https 域名。

最短路径（VPS，Docker）：

```bash
git clone https://github.com/Git-xian/weread-mcp-worker.git
cd weread-mcp-worker/deploy
cp .env.example .env && vi .env     # 填 MCP_DOMAIN / WEREAD_API_KEY / MCP_AUTH_TOKEN
docker compose up -d --build
# 手机端：https://你的域名/mcp  +  Authorization: Bearer <口令>
```

最短路径（自己电脑）：

```bash
cd weread-mcp-worker/server
npm install
cp .env.example .env && vi .env     # 填 WEREAD_API_KEY / MCP_AUTH_TOKEN（HOST 设 0.0.0.0 供局域网访问）
npm run start:env
```

---

# 手机端接入（通用）

在支持「远程 MCP」的 App 里添加服务器：

- **类型**：Streamable HTTP / 远程 MCP（**不要**选 stdio）
- **URL**：`https://<你的地址>/mcp`
- **请求头**：`Authorization: Bearer <你的 MCP_AUTH_TOKEN>`

之后就能直接问，比如「看看我的书架」「我这个月读了多久」「三体有什么点评」。

---

# 提供的工具（tools）

| 工具 | 对应接口 | 说明 |
|------|----------|------|
| `weread_search` | `/store/search` | 书城搜索（可分 scope：书/作者/听书/书单…） |
| `weread_shelf` | `/shelf/sync` | 书架全量（电子书 + 专辑/有声书 + 文章收藏） |
| `weread_notebooks` | `/user/notebooks` | 笔记本概览（有笔记的书及数量） |
| `weread_book_info` | `/book/info` | 书籍详情 |
| `weread_chapters` | `/book/chapterinfo` | 章节目录 |
| `weread_progress` | `/book/getprogress` | 阅读进度 |
| `weread_readdata` | `/readdata/detail` | 阅读统计（周/月/年/总计） |
| `weread_book_notes` | `/book/bookmarklist` + `/review/list/mine` | 单本书划线 + 个人想法/点评 |
| `weread_reviews` | `/review/list` | 书籍公开点评 |
| `weread_best_bookmarks` | `/book/bestbookmarks` | 热门划线 |
| `weread_recommend` | `/book/recommend` | 个性化推荐 |
| `weread_similar` | `/book/similar` | 相似书推荐 |
| `weread_endpoints` | `/_list` | 列出网关全部可用接口（调试用） |
| `weread_call` | 任意 | 原始调用逃生口 |
| `coread_outline` | 本服务 KV/文件 | **共读**：列出原书章节目录（章节 + 起止段号） |
| `coread_read` | 本服务 KV/文件 | **共读**：按段号范围读原书正文（单次 ≤60 段，带 nextFrom） |
| `coread_search` | 本服务 KV/文件 | **共读**：在原文里搜关键词，返回命中段落全文 |
| `coread_annotate` | 本服务 KV/文件 | **共读**：写批注（🟡 你的 / 🔵 闻舟的 / 划线标记），看板立即显示 |
| `coread_sync` | 微信读书网关 → 本服务 | **共读**：想法写进 🟡 栏、划线只作标记（保留 🔵）；按书名打分匹配，认不出就回候选书单可点选绑定 |

---

# 看板（共读 + 书架）

除了 MCP 工具，服务还内置一个**看板页面**（`GET /dashboard`），结构与桌面版 `weread_dashboard.py` **完全一致**：顶部双 Tab —— **📖 共读** / **📚 书架与笔记**。

- 端点：`GET /dashboard`
- 口令：`?token=<你的 MCP_AUTH_TOKEN>`（与 MCP 同一个口令）
- 可选：`?books=<1..20>`，最多渲染多少本有笔记的书（默认 12）

```
https://<你的地址>/dashboard?token=<MCP_AUTH_TOKEN>
```

**📚 书架与笔记**（数据实时来自官方网关）
汇总行 + 搜索框 + **书脊色条书卡**；点书名展开该书的划线 🟡 / 想法 💭，每条下方预留 🔵 闻舟批注位。

**📖 共读批注**（需先导入原书，见下）
**只显示被划线/批注过的段落**：每段带段号 + 原文 + 🟡 你的思考 / 🔵 闻舟的思考。整本原文**不会**铺在页面上（存在服务器，给 AI 读）。
只被**划过线**的段落会带黄边和「🟡 你划过线」小标签 —— 那是标记，不是你的评论。

- 点段落 → 编辑器，改完点 **💾 保存** 直接写服务器（换设备同样可见）；两个框都清空再保存 = 删掉这条批注（划线标记保留）
- 编辑器**存完自动收起**；不想存只想关掉就点 **收起**，再点一次同一个段落也能开合
- **🔄 同步微信读书划线**：想法进 🟡 栏、划线只标黄边（见下节）
- **⬇ 下载批注** 在页尾，导出整份 JSON（备份 / 换服务器时回灌用）
- 页面按**章节**分组，顶部有**章节目录条**：点一章即跳到那章（自动展开），点章标题可就地折叠，右上角「全部收起 / 全部展开」。`第X部 / 第X章 / 序章 / 尾声 …` 都能认；整本正文挤在一个 xhtml、文件自带标题又是「未知」的 EPUB，保存时会按正文里的章节标记**自动重切一次**，不会全挂在一章下面
- 保存失败（断网）会暂存本机，页面**最末尾**出现「立即同步」提示条

> 共读页**没有**原文搜索框 —— 原文是给 AI 经 MCP 读的、给人在微信读书里读的，看板只当批注看板。
> 要给还没批注的段落写批注？让 AI 读原文后写，或自己点「🔄 同步微信读书划线」把划线拉进来。

### 🔄 把微信读书的划线/想法同步过来

看板顶部的 **🔄 同步微信读书划线** 按钮，会调 `POST /coread/sync`：服务端按**共读书名**在「有笔记的书」里找到对应的微信读书笔记本 → 拉该书的划线（`/book/bookmarklist`）与想法（`/review/list/mine`）→ 用**原文比对**把每条落到对应段号。

落到段上时分两种，**别混为一谈**：

| 微信读书那边 | 落到看板 |
|---|---|
| **划线**（只有线，没写字） | 该段标黄边 + 「🟡 你划过线」——**只是标记，不是评论** |
| **想法**（写了字） | 写字的那段 → 🟡「你：<你的想法>」，同时也会标为划线 |

- **只覆盖 🟡 栏与划线标记**，🔵 闻舟批注一律保留；原文段落一字不动
- 没变化就不写（省 KV 额度）；返回里给出 `highlights`（划线条数）、`thoughts`（想法条数）、`markedSegments`（标了几段）、`written`（实际写入几段）

**书名怎么对上（重点）**：你在微信读书读的常是**官方版**，交给 AI 的却是别处下的版本，两边书名往往不一样。所以匹配不靠死磕全名，而是多信号打分（0~1）：

| 信号 | 分 |
|---|---|
| 归一化后全名相等 | 1.00 |
| 某个「词」（主标题 / 括号里的作者、丛书名）与笔记本书名全等 | 0.90 |
| 最长公共子串 ≥3 字，按占比给 0.5~0.90 | — |
| 作者一致（只在天花板之上**加成 0.06**，绝不单独定案） | +0.06 |

比对前先抹掉噪声：`.epub` 后缀、`(作者)`/`(站点名)` 括号、`精装版 / 全X册 / 第X版 / z-library.sk` 之类的版本与来源词。分数 ≥ **0.7** 才自动认，否则**不硬凑**。

- 出候选时**不会乱写**：返回 `candidates`（书名 + 作者 + 分数，降序），看板顶部把它们列成按钮，**点一本即绑定**
- 绑定记在服务端（Workers 是 KV `coread-bind`，Node 是 `coread-bind.json`，都已 gitignore），下次同步直接用；绑定的书失效会自动清除并回到自动匹配
- 也可显式传 `bookId` 指定（等价于点选绑定）；返回里有 `matched`（命中方式）与 `score`，`ambiguous: true` 表示有另一本分数很接近、可能选错
- 导入 EPUB 时会读**书内元数据**的 `dc:title` / `dc:creator`（浏览器解析与 `tools/epub-split.py` 都会），文件名另存 `meta.file` —— 三个信号一起比对，比只看文件名稳得多
- 自己导入微信读书的 EPUB，那本书的笔记标题常变成**作者名**（作者字段是站点占位串），靠「文件名括号里的作者」照样兜得住

```bash
curl -X POST "https://<你的地址>/coread/sync" -H "Authorization: Bearer <MCP_AUTH_TOKEN>"
# 指定 bookId： -d '{"bookId":"24953405"}'
```

> ⚠️ 想让 🟡 栏有内容，共读的那本书得**你在微信读书里确实划过线/写过想法**。只把 EPUB 拖进来、微信读书里没笔记的书，同步会是空的。

## 共读数据怎么来（导入原书）

**最省事：不用命令行，也不用上传 EPUB 原件。**
打开看板 → 切到 **📖 共读** Tab → **把 EPUB 拖进去**。拆段在你自己的手机/电脑上完成，只有拆好的 JSON 传给服务器（Workers 存 KV，Node 存文件）。

```
https://<你的地址>/dashboard?token=<MCP_AUTH_TOKEN>
```

### 不想用浏览器？一条命令

```bash
python tools/coread-upload.py 你的书.epub --url https://<你的地址> --token <MCP_AUTH_TOKEN>
```

自动完成「拆书 → 导出 → 上传」。只想手工分步也行：

```bash
python tools/epub-split.py 你的书.epub ./weread-data/books/你的书   # ① 拆段
python tools/coread-export.py ./weread-data/books/你的书 coread.json # ② 导出
curl -X POST "https://<你的地址>/coread" -H "Authorization: Bearer <口令>" --data-binary @coread.json  # ③ 上传
```

> 整本书的 `coread.json` 通常 0.3–3 MB；KV 单值上限 25 MiB，放得下。

### 只做一次的准备

| 部署形态 | 要配什么 |
|----------|----------|
| **Cloudflare** | 绑一个 KV：`npx wrangler kv namespace create COREAD_KV` → 把 id 填进 `wrangler.toml` 的 `[[kv_namespaces]]`（有注释模板）→ `npx wrangler deploy`<br>不想用命令行：后台 → Storage & Databases → KV 建库 → Worker → Settings → Bindings 加 **KV namespace**，变量名必须叫 `COREAD_KV` |
| **VPS / 自己电脑** | 不用配。默认写到 `server/coread.json`，想换位置就设 `COREAD_FILE` |

### 核对 / 换书

```bash
curl "https://<你的地址>/coread?token=<MCP_AUTH_TOKEN>"
# → {"uploaded":true,"book":"你的书.epub","segments":1234}
```

再拖一本进去就是换书（覆盖旧的）。

### 数据存哪

| 数据 | Workers | Node | 接口 |
|------|---------|------|------|
| 原文（拆段后的书） | KV 键 `coread` | `server/coread.json` | `POST/GET /coread` |
| 批注（🟡/🔵） | KV 键 `coread-notes` | `server/coread-notes.json` | `POST/GET /coread/notes` |

两者**分开存**：AI 写一条批注不必重传整本书。

```bash
curl "https://<你的地址>/coread?token=<口令>"
# → {"bound":true,"uploaded":true,"book":"你的书.epub","segments":2463,"annotated":12}
```

### AI 怎么读原书写批注

导入原书后，AI 用这 5 个工具读写（与看板共用同一份数据）：

| 工具 | 干什么 |
|------|--------|
| `coread_outline` | 看全书章节结构 |
| `coread_read` | 按段号读原文（`from` / `to`，单次 ≤60 段） |
| `coread_search` | 在原文里搜关键词，拿到段落全文 |
| `coread_annotate` | 写批注 `{id, user?, ai?, mark?}`，看板立即显示；不传的字段保持原状 |
| `coread_sync` | 从微信读书拉你的想法（写 🟡 栏）与划线（只标记），保留 🔵 |

典型对话：**「读一下第 1200–1260 段，把你觉得要紧的地方写进批注」** —— AI 调 `coread_read`，再调 `coread_annotate`，你看板刷新就能看到 🔵 闻舟批注。

> 冷门路：`/dashboard?token=xxx&coread=<base64url>`（`coread-export.py --b64` 的输出）。
> Cloudflare 对请求 URL 限制约 16 KB，**只够几十段的演示数据**。

未提供共读数据时，看板为**单页书架模式**（共读 Tab 显示导入入口）。


> ⚠️ 看板含你的**真实划线 / 想法 / 批注**，务必带 `token` 打开，不要把带 token 的链接外发。
>
> 📌 **子请求预算**：书架页每本书要拉 2 次网关（划线 + 想法）。Cloudflare Workers **免费版单请求上限 50 个子请求** → `books` 别调太大（默认 12 约 27 个子请求，安全）；书特别多时绑付费版或加 KV 缓存。

---

# 自测

```bash
node test/smoke.mjs                # MCP 端点：tools/list（19 个）+ 未知工具兜底
node test/smoke-coread.mjs         # POST/GET /coread：鉴权、结构校验、写入、章节兜底重切（17 项）
node test/smoke-chapters.mjs       # 章节识别：标题判定/目录页跳过/退化判定/幂等（31 项）
node test/smoke-coread-notes.mjs   # 批注读写 + 原文搜索接口 + 5 个 coread 工具 + 只渲染批注段（51 项）
node test/smoke-coread-sync.mjs    # 微信读书 → 🟡 栏同步：书名打分匹配/保留AI批注/幂等/候选点选绑定（49 项）
node test/smoke-dashboard.mjs      # 看板结构断言（书卡/汇总/搜索/闻舟批注区/进度不越界）
node test/smoke-epub-parse.mjs     # 浏览器内 EPUB 解析：stored + deflate（17 项）

npm i jsdom --no-save              # 仅在要跑下面这条前端交互测试时需要
node test/smoke-dashboard-dom.mjs  # 只渲染批注段 / 划线≠评论 / 章节折叠跳转 / 保存后自动收起 / 页尾提示条（92 项，jsdom 真跑）
```

---

# 安全边界

- `WEREAD_API_KEY` 只存在于服务端（Worker Secret / 服务器 `.env`），不进代码、不进日志、不进任何回包。
- 端点鉴权靠 `MCP_AUTH_TOKEN`，**务必设置**，且不要在公开场合贴出来。
- `POST /coread`、`POST /coread/notes`（上传原文 / 写批注）同样要 `Bearer` 口令，**未设置口令时直接拒绝**；`GET /coread` 只回书名、段数和批注条数，**不回正文**。
- 微信读书的数据只做**读**类转发、不落地；但**共读原文与批注会存在你的服务器上**（KV 键 `coread` / `coread-notes`，或 Node 的本地文件），仅本服务读取，同样受 `MCP_AUTH_TOKEN` 保护。
- Node 版部署时，应用只监听 `127.0.0.1:8787`，公网仅暴露 443（见 VPS 教程「安全清单」）。
- `skill_version` 固定为 `1.0.4`；若官方网关返回 `upgrade_info`，按提示更新 `src/weread.js`（Worker）或 `server/src/weread.js` 顶部的 `SKILL_VERSION`。

---

# 参考与致谢

本项目的共读形态与看板设计，站在这些开源项目与官方服务的肩膀上：

| 来源 | 借鉴了什么 | 协议 |
|------|-----------|------|
| [Coread 共读室](https://github.com/meowmana/coread) | 核心设计：人与 AI 共享同一本书的页码、划线、批注并排显示 | MIT |
| [Tasogare 黄昏](https://github.com/EnhydrInk/tasogare) | 双色划线意象：两种笔迹留在同一页 | MIT |
| [awesome-weread](https://github.com/BENZEMA216/awesome-weread) | 官方 Skill 生态索引，接口清单据此整理 | CC0 |
| [微信读书官方 Agent Skill](https://weread.qq.com/r/weread-skills) | 数据来源：官方网关与 API Key 机制 | 官方服务 |

> 本仓库代码为原创实现，仅调用官方公开接口，未复制上述任何项目的源码。

---

# 开源协议

[MIT](LICENSE) © 2026 weread-mcp-worker contributors
