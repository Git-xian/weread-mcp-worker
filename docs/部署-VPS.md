# 部署到 VPS（跑 Node 版）

> 适用：你有一台公网 VPS + 一个域名。
> 目标：把微信读书远程 MCP 跑在 VPS 上，手机访问 `https://你的域名/mcp`。
> 用的是仓库里的 **`server/`（Node 版）**，不是根目录的 Cloudflare Workers 版——**两份代码不通用**。

---

## 0. 前置

| 项 | 要求 |
|----|------|
| VPS | 任意 Linux（Debian/Ubuntu 最省事），1 核 512M 就够 |
| 域名 | 一个 A 记录指向 VPS 公网 IP，例如 `mcp.你的域名.com` |
| 端口 | 放行 **80、443**（申请证书 + HTTPS 必须），**不要**对公网开 8787 |
| 密钥 | 微信读书 `wrk-` 开头的 key |

> 为什么这本 MCP 适合放 VPS：它**无状态、不落库**，只把你的请求转发到微信读书官方网关。所以不占资源、不需要数据库。

---

## 方式一：Docker Compose + Caddy 自动 HTTPS（推荐，最省心）

自带一个 Caddy，自动申请/续期 Let's Encrypt 证书，不用自己配 Nginx。

```bash
# 1) 把仓库拉下来（或只 scp server/ 和 deploy/ 两个目录上去）
git clone https://github.com/Git-xian/weread-mcp-worker.git
cd weread-mcp-worker/deploy

# 2) 配好环境变量
cp .env.example .env
vi .env          # 填 MCP_DOMAIN / WEREAD_API_KEY / MCP_AUTH_TOKEN

# 3) 起服务
docker compose up -d --build

# 4) 看日志确认没问题
docker compose logs -f caddy
```

`MCP_AUTH_TOKEN` 建议用随机串生成：

```bash
openssl rand -hex 24
```

起来后直接访问 `https://你填的域名/healthz`，返回 `{"ok":true,...}` 就成了。
MCP 端点是：

```
https://你填的域名/mcp
```

> 注意：Caddy 申请证书要求域名**已经**解析到这台 VPS，且 80/443 能通。DNS 刚改完可能要等几分钟。

---

## 方式二：不用 Docker（Node + systemd + Caddy）

更轻，适合不想装 Docker 的机器。

### 1. 装 Node 20+

```bash
# 以 Debian/Ubuntu 为例
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 2. 放代码 + 装依赖

```bash
sudo mkdir -p /opt/weread-mcp
sudo cp -r server /opt/weread-mcp/server
cd /opt/weread-mcp/server
sudo npm install --omit=dev
```

### 3. 写环境变量

```bash
sudo tee /opt/weread-mcp/server/.env >/dev/null <<'EOF'
WEREAD_API_KEY=wrk-你的key
MCP_AUTH_TOKEN=你的随机口令
HOST=127.0.0.1
PORT=8787
EOF
sudo chmod 600 /opt/weread-mcp/server/.env
```

### 4. 用 systemd 常驻

仓库里已经备好 `deploy/systemd/weread-mcp.service`：

```bash
sudo cp deploy/systemd/weread-mcp.service /etc/systemd/system/
# 改两处：User=（当前用户或 www-data）、ExecStart= 的 node 绝对路径（which node）
sudo vi /etc/systemd/system/weread-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now weread-mcp
systemctl status weread-mcp --no-pager
```

### 5. 反代 + HTTPS

用 Caddy 最省事（同样自动证书）：

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
mcp.你的域名.com {
    reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy
```

或者你机器上已有 Nginx / 宝塔，就加一条反代到 `http://127.0.0.1:8787` 即可（记得配好 HTTPS 证书）。

---

## 方式三：只反代、复用现有 Web 服务

如果这台 VPS 已经跑了 Nginx/宝塔/1Panel 管着域名：

1. 按「方式二」的 1–4 步让服务在本机 `127.0.0.1:8787` 跑起来。
2. 在你现有的面板里加一个站点/站点目录，反代到 `http://127.0.0.1:8787`。
3. 给这个站点配好 HTTPS 证书。

> 关键：**应用只监听 127.0.0.1**，公网只暴露 443。别把 8787 开到公网。

---

## 验证

```bash
# 健康检查
curl -sS https://你的域名/healthz

# 未带 token 应 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://你的域名/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 带正确 token 应 200，并返回 14 个工具
curl -sS -X POST https://你的域名/mcp \
  -H 'Authorization: Bearer 你的MCP_AUTH_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 看板与共读（可选）

服务自带一个看板：`https://你的域名/dashboard?token=你的MCP_AUTH_TOKEN`，双 Tab（**📖 共读** / **📚 书架与笔记**）。
书架 Tab 开箱即用。

共读 Tab 需要导入一本原书（网关不提供正文，所以正文得来自 EPUB）：

> 打开看板 → **📖 共读** → **把 EPUB 拖进去**。拆段在你的浏览器里本地完成，只把结果存到服务器，
> 默认落在 `server/coread.json`（Docker 版是 `deploy/data/coread.json`，已挂卷、重建不丢）。

不想用浏览器，就在有 EPUB 的那台机器上跑一条命令：

```bash
python tools/coread-upload.py 你的书.epub --url https://你的域名 --token 你的MCP_AUTH_TOKEN
```

> 想换落点：`.env` 里设 `COREAD_FILE=/你的/路径.json`（Docker 版要在 `deploy/.env` 里设，并确保该目录已挂进容器）。
> 批注存在浏览器本地，页尾「⬇ 下载批注」导出 `coread-notes.json`；放进书目录重跑 `tools/coread-export.py` 再上传一次即可跨设备可见。

---

---

## 手机端接入

在支持「远程 MCP」的 App 里添加服务器：

- **类型**：Streamable HTTP / 远程 MCP（**不要**选 stdio）
- **URL**：`https://你的域名/mcp`
- **请求头**：`Authorization: Bearer 你的MCP_AUTH_TOKEN`

---

## 更新 / 维护

```bash
# Docker 方式
git pull && cd deploy && docker compose up -d --build

# systemd 方式
git pull && sudo cp -r server/src/* /opt/weread-mcp/server/src/ && sudo systemctl restart weread-mcp
```

改 key 或口令：改 `.env` 后 `docker compose up -d`（Docker）或 `systemctl restart weread-mcp`（systemd）。

---

## 排错

| 现象 | 原因 / 处理 |
|------|-------------|
| Caddy 起不来、证书申请失败 | 域名 A 记录没指到本机，或 80/443 没放行 |
| `/mcp` 一直 401 | 请求头没带 `Authorization: Bearer <口令>`，或口令和 `.env` 不一致 |
| 返回 500 / `未配置 WEREAD_API_KEY` | `.env` 没读到；systemd 方式要确认 `EnvironmentFile` 路径对 |
| 工具调用报 `errcode` | 网关侧问题（key 失效 / skill_version 需升级），看返回的 errmsg |
| 国内手机连不上 | 这条路径**不经过 `workers.dev`**，只要域名解析正常即可；若仍不通，检查 VPS 是否被墙或端口是否被封 |

---

## 安全清单

- [ ] `MCP_AUTH_TOKEN` **必须**设，且足够随机（不设等于公网裸奔）
- [ ] `WEREAD_API_KEY` 只放在服务端 `.env` / Docker Secret，绝不进代码、不进仓库
- [ ] 8787 只监听 `127.0.0.1`（或 Docker 内部网络），不映射到公网
- [ ] `.env` 权限 `600`
- [ ] 全站强制 HTTPS
