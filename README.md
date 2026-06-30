# xdash — Linux 服务器实时监控系统

轻量级服务器监控：Rust 客户端采集 → Node.js 服务端（Express + SQLite）接收 → 网页端实时查看。

```
Linux 服务器                         Node.js 服务端                        浏览器
┌──────────────┐   WebSocket ~3s    ┌──────────────────┐    HTTP 轮询    ┌──────────┐
│ Rust 客户端  │ ──────────────────▶│ Express + ws     │◀───────────────│  网页端  │
│ (单文件,musl)│   CPU/内存/磁盘/网 │ better-sqlite3   │  ~3s/次        │ Chart.js │
└──────────────┘                    │ device_latest    │                └──────────┘
                                    │ metrics_history  │
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
| 服务端 | Node.js + TypeScript（Express + ws + better-sqlite3） |
| 前端 | 原生 HTML/CSS/JS + Chart.js（无构建步骤） |

## 架构取舍

- 客户端 **采集 0.5s**，**上报 ~3s**（平衡图表平滑度与数据库写入频率）
- 服务端额外对实时表 **2s 节流**、历史表 **15s 采样**
- 网页端 **HTTP 轮询**（3s 拉取实时、15s 刷新图表）

---

## 目录结构

```
xdash/
├── client/              Rust 客户端
│   ├── Cargo.toml
│   ├── src/main.rs
│   └── xdash.service
├── server/              Node.js 服务端
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.sql       建表脚本（启动时自动建表，此文件仅参考）
│   ├── .env.example     环境变量模板
│   ├── xdash-server.service
│   ├── data/            SQLite 数据文件目录
│   └── src/
│       ├── index.ts     Express 入口
│       ├── config.ts    环境变量配置
│       ├── db.ts        better-sqlite3 数据层
│       ├── ws.ts        WebSocket 接收
│       ├── api.ts       HTTP API Router
│       ├── auth.ts      HMAC 会话签名
│       └── cleanup.ts   历史数据清理
└── web/                 网页前端（被服务端 express.static 托管）
    ├── index.html
    ├── app.js
    └── style.css
```

---

## 一、部署服务端

> 前提：已安装 Node.js 18+ 和 npm。需要一台可长期运行的服务器（VPS / 云主机 / 内网服务器）。

### 1. 安装依赖

```bash
cd server
npm install
```

> `better-sqlite3` 是原生模块，安装时会自动编译；需要系统装有 `python` 与 C++ 编译工具链（Linux 通常自带 `make`/`g++`）。

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入：
- `DEVICE_TOKEN`：客户端握手 token（随机长串，**必须与客户端 XDASH_TOKEN 一致**）
- `WEB_PASSWORD`：网页登录密码
- `JWT_SECRET`：会话签名密钥（可用 `openssl rand -hex 32` 生成）

数据库会在首次启动时自动建表，无需手动执行 `schema.sql`。

### 3. 运行

开发模式（热重载）：
```bash
npm run dev
```

生产模式：
```bash
npm run build      # 编译 TS → dist/
npm start          # node dist/index.js
```

默认监听 `http://localhost:3000`。这就是网页地址，客户端 `XDASH_URL` 指向 `ws(s)://<服务端IP>:3000/ws`。

### 4. （推荐）配置为 systemd 服务

把 `server/xdash-server.service` 拷到 `/etc/systemd/system/`，按其中注释调整路径（默认项目在 `/opt/xdash`），然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xdash-server
sudo systemctl status xdash-server      # 查看状态
sudo journalctl -u xdash-server -f      # 查看实时日志
```

### 5. （可选）Nginx 反向代理 + HTTPS

若要使用域名和 HTTPS，在前端套一层 nginx，并在 `.env` 中设 `TRUST_PROXY=true`（服务端会从 `X-Forwarded-For` 读取真实公网 IP）。WebSocket 需在 nginx 配置中开启 upgrade：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location / {
    proxy_pass http://127.0.0.1:3000;
}
```

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

### 2. 部署到目标服务器

把二进制拷到服务器：

```bash
scp target/x86_64-unknown-linux-musl/release/xdash user@server:/usr/local/bin/xdash
ssh user@server "chmod +x /usr/local/bin/xdash"
```

### 3. 配置为 systemd 服务

把 `client/xdash.service` 拷到服务器 `/etc/systemd/system/xdash.service`，编辑其中的 `XDASH_URL` 与 `XDASH_TOKEN`：

```ini
Environment="XDASH_URL=ws://<服务端IP>:3000/ws"
Environment="XDASH_TOKEN=与服务端 .env 中 DEVICE_TOKEN 一致"
```

> ⚠️ **客户端必须以 root 运行**。进程内存按 PSS（Proportional Set Size）统计，需读取 `/proc/[pid]/smaps_rollup`，而 Linux 默认普通用户无法读取其他用户的进程 smaps。`xdash.service` 默认未设置 `User=`（即以 root 运行），请保持不变，否则 memory_top 中其他用户进程的内存会读不到（归零失真）。

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

1. 浏览器打开服务端地址 `http://<服务端IP>:3000`
2. 输入 `.env` 中设置的 `WEB_PASSWORD` 登录
3. 首页为设备列表卡片（在线状态、CPU/内存、最后更新时间）
4. 点击卡片进入详情：系统信息、实时指标环、Top 进程、磁盘/网络表格、历史趋势图

---

## 本地开发调试

### 服务端

```bash
cd server
cp .env.example .env        # 填入开发用值
npm install
npm run dev                 # 启动并热重载
```

### 客户端

```bash
cd client
XDASH_URL=ws://localhost:3000/ws XDASH_TOKEN=你的token cargo run
```

---

## 常见问题

**Q: 网页看不到设备？**
检查：① 客户端 `XDASH_TOKEN` 与服务端 `.env` 的 `DEVICE_TOKEN` 是否一致；② 客户端 `XDASH_URL` 是否以 `/ws` 结尾；③ `journalctl -u xdash` 是否报连接失败；④ 客户端时间是否正确（影响在线判断）；⑤ 服务端防火墙是否放行端口。

**Q: 客户端报 status=203/EXEC？**
说明 systemd 找不到或无法执行二进制。检查：① 二进制路径与权限（`chmod +x /usr/local/bin/xdash`）；② 二进制架构是否匹配服务器（须是 x86_64 Linux 的 musl 产物）；③ 用 `file /usr/local/bin/xdash` 确认不是 Windows/DOS 可执行文件。

**Q: better-sqlite3 安装失败？**
需要 Python 3 和 C++ 编译器（Linux 装 `build-essential`，Alpine 装 `build-base python3`）。或换用预编译二进制：`npm install better-sqlite3 --build-from-source=false`。

**Q: CPU 占用率一直是 0？**
sysinfo 的进程 CPU% 依赖两次刷新的差值，客户端首次启动后需要 0.5s 建立基准，几秒后即正常。

**Q: 想要更低的实时延迟？**
可调小客户端 `XDASH_INTERVAL`（如 1~2s），并把网页轮询间隔调小。实时延迟即可降到 2~3s。

---

## 安全说明

- 客户端→服务端：生产环境建议用 nginx 套 HTTPS（`wss://`），token 作为 WebSocket 握手查询参数。
- 网页：登录密码经 HMAC-SHA256 签名会话，token 存 localStorage。
- 本系统为**单用户**模型，不区分多账号；多查看者共用同一密码。
- 客户端以 **root** 身份运行（读取全部进程的 PSS 所必需），并开启了 systemd 安全加固（`NoNewPrivileges`/`ProtectSystem` 等），尽量收敛 root 的实际风险。
- 进程内存口径为 **PSS（Proportional Set Size）**：共享内存按使用进程数均分，所有进程 PSS 之和≈整机真实进程内存占用；相比 `top`/桌面监视器默认的 RSS（会重复计入共享库），PSS 更接近实际占用。
- `.env` 含敏感信息，已被 `.gitignore` 忽略，不会提交到仓库。

---

## 许可

MIT
