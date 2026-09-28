# Larkwire Relay · 灵鹊哑中继

[![npm](https://img.shields.io/badge/npm-%40larkwire%2Frelay-blue)](https://www.npmjs.com/package/@larkwire/relay)

灵鹊 Larkwire 的公网汇合点：WSS 连接管理、密文转发、配对路由、离线队列、用量计量。

**哑 = 对内容零可见**：所有消息体都是端到端加密后的密文，中继只按信封头（类型/发送方/目标/字节数）路由，不存储正文、不记录内容。

- **源码仓**：<https://github.com/kowems/larkwire-relay>（本仓，MIT）
- **npm 安装**：`@larkwire/relay`
- **单文件部署**：不想装 npm？[Releases](https://github.com/kowems/larkwire-relay/releases) 页下载 `relay.bundle.mjs`，`node relay.bundle.mjs` 直接跑
- **手机 App 下载**：iOS（TestFlight 审核中）/ Android（应用市场即将上架）——见 <https://larkwire.kowems.site#download>（App 闭源，不在任何公开仓）

> 灵鹊三仓：[`larkwire`](https://github.com/kowems/larkwire)（电脑端桥 + 协议）· **`larkwire-relay`（中继，本仓）** · [`larkwire-desktop`](https://github.com/kowems/larkwire-desktop)（电脑桌面应用）

## 为什么需要中继

手机和电脑往往不在同一网段（手机走 4G/5G、电脑在公司 NAT 内），需要一个公网可达的汇合点。灵鹊把它做成一个对内容盲的数据包中转站，因此可以开源接受审计，也可以由你自己部署、数据完全自主。

## 方式一：npm 安装

需要 Node.js ≥ 22。

```bash
npx @larkwire/relay
# 或
npm install -g @larkwire/relay
larkwire-relay
```

## 方式二：单文件 bundle

从 [Releases](https://github.com/kowems/larkwire-relay/releases) 下载 `relay.bundle.mjs`：

```bash
node relay.bundle.mjs
```

单文件已内联全部依赖，不需要 npm install。

默认监听 `127.0.0.1:8790`，数据库落在 `~/.larkwire/relay.db`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LARKWIRE_RELAY_HOST` | `127.0.0.1` | 监听地址；直接对外时设为 `0.0.0.0` |
| `LARKWIRE_RELAY_PORT` | `8790` | 监听端口 |
| `LARKWIRE_RELAY_DB` | `~/.larkwire/relay.db` | SQLite（node:sqlite）数据库路径 |

> Node 22 上 `node:sqlite` 会打印一条 ExperimentalWarning，属正常，不影响运行。

## 反代部署（推荐）

中继不直接做 TLS，前面挂 nginx（完整模板见 [`deploy/larkwire.nginx.conf`](deploy/larkwire.nginx.conf)）：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.0;
    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # 长连接不掐线（睡眠 / 离线看门狗由协议自己处理）
    proxy_read_timeout 3600s;
}
```

连接地址写完整路径：`wss://你的域名/ws`。

## systemd 自启

```ini
# /etc/systemd/system/larkwire-relay.service
[Unit]
Description=Larkwire relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/larkwire-relay/relay.bundle.mjs
Environment=LARKWIRE_RELAY_HOST=0.0.0.0
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> 注意：直接前台跑会「随终端死」——关 SSH 会带走进程。务必用 systemd / nohup / screen 脱离终端启动。

完整上线流程（打 bundle / 冒烟 / 推送密钥文件 / 回滚）见 [DEPLOY.md](DEPLOY.md)。

## 自建后怎么让桥和 App 指向你的中继

桥配对时用 `larkwire pair --relay wss://你的域名/ws` 指定中继；配对二维码也支持携带自定义中继参数。官方托管中继地址为 `wss://larkwire.kowems.site/ws`。

## License

MIT

## 相关包

- [`@larkwire/protocol`](https://www.npmjs.com/package/@larkwire/protocol) — 三端共享协议
- [`larkwire`](https://www.npmjs.com/package/larkwire) — 电脑端桥
