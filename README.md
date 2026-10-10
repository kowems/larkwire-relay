# @larkwire/relay

灵鹊 Larkwire 的哑中继：WSS 连接管理、密文转发、配对路由、离线队列、用量计量。

**哑 = 对内容零可见**：所有会话帧的 body 都是端到端加密后的密文，中继只按连接映射转发，不存储、不记录正文。
推送所需的少量标签走信封**外层明文字段**，边界见下文[「推送与隐私边界」](#推送与隐私边界)。

MIT 开源。你可以直接用官方托管中继（默认指向），也可以完全自建。

## 为什么需要中继

手机和电脑往往不在同一网段（手机走 4G/5G、电脑在公司 NAT 内），需要一个公网可达的汇合点。灵鹊把它做成一个对内容盲的数据包中转站，因此可以开源接受审计，也可以由你自己部署、数据完全自主。

## 安装与启动

需要 Node.js ≥ 22。

```bash
npx @larkwire/relay
# 或
npm install -g @larkwire/relay
larkwire-relay
```

默认监听 `127.0.0.1:8790`，数据库落在 `~/.larkwire/relay.db`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LARKWIRE_RELAY_HOST` | `127.0.0.1` | 监听地址；直接对外时设为 `0.0.0.0` |
| `LARKWIRE_RELAY_PORT` | `8790` | 监听端口 |
| `LARKWIRE_RELAY_DB` | `~/.larkwire/relay.db` | SQLite（node:sqlite）数据库路径 |

## 反代部署（推荐）

中继不直接做 TLS，前面挂 nginx：

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

[Service]
ExecStart=/usr/local/bin/larkwire-relay
Environment=LARKWIRE_RELAY_HOST=0.0.0.0
Restart=always

[Install]
WantedBy=multi-user.target
```

> 注意：直接前台跑会「随终端死」——关 SSH 会带走进程。务必用 systemd / nohup / screen 脱离终端启动。

## 自建后怎么让桥和 App 指向你的中继

桥的配置中可指定中继地址；配对二维码也支持携带自定义中继参数。官方托管中继地址为 `wss://larkwire.kowems.site/ws`。

## 推送与隐私边界

手机离线时，桥会让中继把通知转成 APNs/厂商推送。notify 消息的 **body 全程端到端加密，中继读不到**；
为了让中继选模板、渲染文案，信封上另有几个**外层明文字段**（旧端忽略未知字段，向后兼容）：

| 外层字段 | 含义 | 可见性 |
|---|---|---|
| `hint` | 模板标签：`permission` / `runDone` | 中继明文可读 |
| `sid` | 会话 id，点击通知直达该会话 | 中继明文可读 |
| `proj` | 项目**目录名最后一段**（如 `larkwire`），2026-10-08 起 | 中继明文可读 |
| `tool` | 权限工具名（如 `Bash`），仅权限类，2026-10-08 起 | 中继明文可读 |

中继渲染前会再消毒：剔除控制字符、折叠空白、截断 24 字符；工具名只留 `[A-Za-z0-9_-]`。
缺字段时逐字回退通用模板（`🔐 有操作等你授权` / `✅ 会话回合完成`）。

**永不出端（红线）**：完整路径、命令内容、输入内容、会话标题与用户消息。

推送限流：每设备 × 每会话 × 每类事件 60 秒最多一条，防止权限风暴轰炸。

## License

MIT

## 相关包

- [`@larkwire/protocol`](https://www.npmjs.com/package/@larkwire/protocol) — 三端共享协议
- [`@larkwire/core`](https://www.npmjs.com/package/@larkwire/core) — 电脑端桥
