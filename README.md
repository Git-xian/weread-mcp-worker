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
- **看板**：内置 `GET /dashboard`，实时把你的划线 / 想法 / 阅读热力图渲染成一个自包含网页，手机浏览器直接打开
- 存储：MCP 端点**不需要数据库**，只有你的 `wrk-` key 放在服务端
- 工具：14 个，覆盖搜索 / 书架 / 笔记 / 阅读统计 / 点评 / 推荐

---

## 仓库结构

```
├── LICENSE         # MIT
├── src/            # Cloudflare Workers 版（wrangler 入口）
│   ├── index.js    #   MCP 服务 + /dashboard 路由
│   └── dashboard.js #  看板渲染（两种形态共用同一份）
├── wrangler.toml   #   └ Workers 配置
├── server/         # Node 版（Express + Streamable HTTP）—— VPS / 本机用
│   ├── src/        #   服务 + 网关客户端 + dashboard.js
│   ├── Dockerfile
│   └── .env.example
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

---

# 看板（共读书架）

除了 MCP 工具，服务还内置一个**看板页面**：把书架、划线、想法、阅读热力图实时渲染成一个自包含 HTML，**浏览器直接打开**，无需 App。

- 端点：`GET /dashboard`
- 口令：`?token=<你的 MCP_AUTH_TOKEN>`（与 MCP 同一个口令）
- 可选：`?books=<1..20>`，最多渲染多少本有笔记的书（默认 12）

```
https://<你的地址>/dashboard?token=<MCP_AUTH_TOKEN>
```

页面内容：KPI 总览（藏书 / 有笔记的书 / 划线数 / 想法数 / 累计阅读）· 阅读热力图 · 最常读的书 · 按书展开的划线 🟡 与想法 💭 · 顶部搜索框（书名 / 作者 / 正文，输入即过滤）· 每条下方预留 🔵 AI 批注位。

> ⚠️ 看板含你的**真实划线与想法**，务必带 `token` 打开，不要把带 token 的链接外发。
>
> 📌 **子请求预算**：看板每本书要拉 2 次网关（划线 + 想法）。Cloudflare Workers **免费版单请求上限 50 个子请求** → `books` 别调太大（默认 12 约 27 个子请求，安全）；书特别多时绑付费版或加 KV 缓存。

---

# 安全边界

- `WEREAD_API_KEY` 只存在于服务端（Worker Secret / 服务器 `.env`），不进代码、不进日志、不进任何回包。
- 端点鉴权靠 `MCP_AUTH_TOKEN`，**务必设置**，且不要在公开场合贴出来。
- 本服务只做**读**类转发，不落地任何数据；共读批注等私有数据仍留在你本机。
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
