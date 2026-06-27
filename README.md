# xdash — Linux 服务器实时监控系统

轻量级服务器监控：Rust 客户端采集 → Cloudflare Workers（D1）接收 → 网页端实时查看。

```
Linux 服务器                         Cloudflare                          浏览器
┌──────────────┐   WebSocket ~3s    ┌──────────────────┐    HTTP 轮询   ┌──────────┐
│ Rust 客户端  │ ──────────────────▶│ Workers + D1     │◀──────────────│  网页端  │
│ (单文件,musl)│   CPU/内存/磁盘/网 │ device_latest    │  ~3s/次       │ Chart.js │
└──────────────┘                    │ metrics_history  │               └──────────┘
                                    └──────────────────┘
```

## 功能

- **CPU**：总占用率 + 占用比例前 5 的进程
- **内存**：占用率 + 占用比例前 5 的进程
- **硬盘**：各挂载点容量/使用率
- **网络**：各网卡实时上下行速率
- **系统信息**：OS、内核、架构、运行时长、CPU 型号、总内存、本地/公网 IP
- **历史趋势**：CPU/内存/网络曲线（1h / 6h / 24h）

## 技术栈

| 组件 | 技术 |
|------|------|
| 客户端 | Rust + sysinfo + tokio-tungstenite，musl 静态单文件 |
| 服务端 | Cloudflare Workers（TypeScript） + D1 数据库 |
| 前端 | 原生 HTML/CSS/JS + Chart.js（无构建步骤） |

## 架构取舍（免费方案）

- 客户端 **采集 0.5s**，**上报 ~3s**（平衡图表平滑度与 D1 免费额度）
- 服务端额外对实时表 **2s 节流**、历史表 **15s 采样**
- 网页端 **HTTP 轮询**（3s 拉取实时、15s 刷新图表）
- 单设备约每天 3 万行写入，在 D1 免费 10 万/天内

---

## 目录结构

```
xdash/
├── client/          Rust 客户端
│   ├── Cargo.toml
│   ├── src/main.rs
│   └── xdash.service
├── server/          Cloudflare Workers 服务端
│   ├── wrangler.toml
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.sql
│   └── src/
└── web/             网页前端（被 Worker 以静态资源托管）
    ├── index.html
    ├── app.js
    └── style.css
```

---

## 一、部署服务端

> 前提：已安装 Node.js 18+ 和 npm。需要一个 Cloudflare 账号。

### 1. 安装依赖

```bash
cd server
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建 D1 数据库并初始化表结构

```bash
# 创建数据库（记下返回的 database_id）
npx wrangler d1 create xdash
```

把返回的 `database_id` 填入 `wrangler.toml` 的 `database_id` 字段：

```toml
[[d1_databases]]
binding = "DB"
database_name = "xdash"
database_id = "粘贴上一步返回的 id"
```

初始化表结构：

```bash
# 远程（生产）库
npx wrangler d1 execute xdash --remote --file=schema.sql
# 本地（开发）库，可选
npx wrangler d1 execute xdash --local --file=schema.sql
```

### 4. 设置 Secrets

```bash
# 客户端握手 token（客户端与服务端必须一致，建议随机长串）
npx wrangler secret put DEVICE_TOKEN

# 网页登录密码
npx wrangler secret put WEB_PASSWORD

# 会话签名密钥（建议随机长串）
npx wrangler secret put JWT_SECRET
```

每条命令会提示输入对应值。

### 5. 部署

```bash
npx wrangler deploy
```

部署成功后会输出访问地址，如 `https://xdash.<子域>.workers.dev`，这就是网页地址，也是客户端的 `XDASH_URL` 基础（需加 `/ws`）。

---

## 二、部署 Rust 客户端

> 在任意装了 Rust 的机器上交叉编译，然后把单文件二进制拷到目标 Linux 服务器。

### 1. 编译（静态 musl 单文件）

在 **x86_64 Linux** 上（或在 Windows 用 WSL / Docker）：

```bash
rustup target add x86_64-unknown-linux-musl
cd client
cargo build --release --target x86_64-unknown-linux-musl
```

产物：`target/x86_64-unknown-linux-musl/release/xdash`（单文件，无依赖）。

> 没有原生 Linux 环境时，推荐用 Docker 交叉编译：
> ```bash
> docker run --rm -it -v "$PWD":/work -w /work \
>   messense/rust-musl-cross:x86_64-musl \
>   cargo build --release
> ```
> 产物在 `target/x86_64-unknown-linux-musl/release/xdash`。

### 2. 部署到目标服务器

把二进制拷到服务器：

```bash
scp target/x86_64-unknown-linux-musl/release/xdash user@server:/usr/local/bin/xdash
ssh user@server "chmod +x /usr/local/bin/xdash"
```

### 3. 配置为 systemd 服务

把 `client/xdash.service` 拷到服务器 `/etc/systemd/system/xdash.service`，编辑其中的 `XDASH_URL` 与 `XDASH_TOKEN`：

```ini
Environment="XDASH_URL=wss://xdash.<子域>.workers.dev/ws"
Environment="XDASH_TOKEN=第一步设置的 DEVICE_TOKEN"
```

> ⚠️ `nobody` 用户读取进程列表等需要适当权限。如遇权限不足导致数据缺失，可临时改用有权限的专用用户，或调整 service 的安全限制。

启动并设为开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xdash
sudo systemctl status xdash          # 查看状态
sudo journalctl -u xdash -f          # 查看实时日志
```

启动后约 3 秒内，网页端即可看到该设备。

---

## 三、使用网页端

1. 浏览器打开服务端地址 `https://xdash.<子域>.workers.dev`
2. 输入部署时设置的 `WEB_PASSWORD` 登录
3. 首页为设备列表卡片（在线状态、CPU/内存、最后更新时间）
4. 点击卡片进入详情：系统信息、实时指标环、Top 进程、磁盘/网络表格、历史趋势图

---

## 本地开发调试

### 服务端

```bash
cd server
npm run db:init:local          # 初始化本地 D1
npm run dev                    # 启动 wrangler dev（默认 http://localhost:8787）
```

本地 dev 模式下需用 `.dev.vars` 文件提供 secrets：

```ini
DEVICE_TOKEN=dev-token
WEB_PASSWORD=dev-password
JWT_SECRET=dev-secret
```

### 客户端

```bash
cd client
XDASH_URL=ws://localhost:8787/ws XDASH_TOKEN=dev-token cargo run
```

---

## 常见问题

**Q: 网页看不到设备？**
检查：① 客户端 `XDASH_TOKEN` 与服务端 `DEVICE_TOKEN` 是否一致；② 客户端 `XDASH_URL` 是否以 `/ws` 结尾；③ `journalctl -u xdash` 是否报连接失败；④ 客户端时间是否正确（影响在线判断）。

**Q: CPU 占用率一直是 0？**
sysinfo 的进程 CPU% 依赖两次刷新的差值，客户端首次启动后需要 0.5s 建立基准，几秒后即正常。

**Q: D1 免费额度告急？**
单设备默认在免费额度内。如设备多，可调大客户端 `XDASH_INTERVAL`（如 5~10s），或升级到 D1 付费层（$0.75/月起）。

**Q: 想要更低的实时延迟？**
升级到 Workers Paid（$5/月）启用 Durable Objects，可改为真正的 WebSocket 推送，网页端延迟降到亚秒级。本项目结构已为此预留扩展空间。

---

## 安全说明

- 客户端→服务端：推荐用 `wss://`（TLS），token 仅作为查询参数。生产环境建议为 Worker 绑定自定义域名。
- 网页：登录密码经 HMAC-SHA256 签名会话，token 存 localStorage。
- 本系统为**单用户**模型，不区分多账号；多查看者共用同一密码。
- 客户端以 `nobody` 身份运行并开启了 systemd 安全加固；读取系统指标所需的最小权限已保留。

---

## 许可

MIT
