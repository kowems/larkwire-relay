# 灵鹊中继 · 生产部署 runbook

生产形态：阿里云 `47.102.104.159`，systemd `larkwire-relay.service` 跑**单文件 bundle**
（`/usr/bin/node --experimental-sqlite /opt/larkwire-relay/relay.bundle.mjs`，Restart=always），
nginx 反代 wss://larkwire.kowems.site/ws → 127.0.0.1:8790。同机还有 Ampiq 生产——**不动 nginx、不动 Ampiq**。

## ① 打 bundle（在 Mac 仓库根目录）

```bash
node_modules/.bin/esbuild packages/relay/src/index.ts --bundle --platform=node --format=esm --target=node22 \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile=relay.bundle.mjs
```

要点（全是踩过的坑）：

- **banner 必须**。ws 是 CJS，ESM bundle 里 dynamic require 会崩
  `Dynamic require of "events" is not supported`；createRequire banner 兜底。
- `node:*` 内置模块自动外置，不用 `--external`。
- esbuild 当前是传递依赖给的（`node_modules/.bin/esbuild` 在就行）；
  若哪天没了：`pnpm add -Dw esbuild`。
- 产物约 230KB 单文件，scp 上服务器即全部部署物。

## ② 本地冒烟（可选但推荐）

```bash
LARKWIRE_RELAY_HOST=127.0.0.1 LARKWIRE_RELAY_PORT=8799 LARKWIRE_RELAY_DB=/tmp/lw-smoke.db \
  node --experimental-sqlite relay.bundle.mjs
# 看到 listening + 推送状态行（含密钥来源）即 OK，Ctrl-C
```

注意：挑**空闲端口**（8799），别碰本机 dev 中继的 8790。

## ③ 上传 + 重启

```bash
# 备份旧 bundle（回滚用，日期戳）
ssh root@47.102.104.159 'cp /opt/larkwire-relay/relay.bundle.mjs /opt/larkwire-relay/relay.bundle.mjs.bak-$(date +%Y%m%d)'
# 上传
scp relay.bundle.mjs root@47.102.104.159:/opt/larkwire-relay/relay.bundle.mjs
# 重启 + 四重验证
ssh root@47.102.104.159 'systemctl restart larkwire-relay && sleep 1 && systemctl is-active larkwire-relay'
ssh root@47.102.104.159 'journalctl -u larkwire-relay -n 15 --no-pager -o cat'   # 启动行：listening + 推送状态（含密钥来源）
ssh root@47.102.104.159 'ss -tlnp | grep 8790'                                  # 127.0.0.1:8790 LISTEN
```

## ④ 回滚

```bash
ssh root@47.102.104.159 'cp /opt/larkwire-relay/relay.bundle.mjs.bak-YYYYMMDD /opt/larkwire-relay/relay.bundle.mjs && systemctl restart larkwire-relay'
```

## ③.5 www 静态页（/pair 落地页，2026-09-23 起）

仓库 `packages/relay/www/` ↔ 服务器 `/opt/larkwire-relay/www/`，nginx `location /pair`
直接出文件（不过中继进程，改页面不用重启中继）：

```bash
scp packages/relay/www/pair/index.html root@47.102.104.159:/opt/larkwire-relay/www/pair/index.html
```

nginx 配置在 `/etc/nginx/sites-available/larkwire`（本地副本 `.debug/nginx-larkwire.conf`，
改动先备份 `cp larkwire larkwire.bak-YYYYMMDD` → scp → `nginx -t && systemctl reload nginx`，
reload 不断 ws 长连）。落地页逻辑：微信 UA→「浏览器打开」蒙层；非微信→自动 scheme
`larkwire://pair?…` 拉起 App + 2.5s 未拉起显示未装引导（TestFlight/APK 链接=占位注释，
公测时替换点已标在 HTML 里）。

## ③.6 公测 www 资产（2026-09-27 批次④，需 Eric 当场授权）

`www/` 从「仅 pair」扩为：官网首页 `index.html` + `.well-known/apple-app-site-association`
+ `dl/`（larkwire.apk / larkwire.dmg）+ `pair/`。配套 nginx 增量配置在
`deploy/larkwire.nginx.conf`（root 提 server 级、新增 AASA/dl/location /）。

```bash
# ① 推静态资产（Mac 仓库根目录；dmg 直接从 desktop release 推，不入库）
scp -r packages/relay/www/index.html packages/relay/www/.well-known \
    root@47.102.104.159:/opt/larkwire-relay/www/
scp packages/relay/www/pair/index.html \
    root@47.102.104.159:/opt/larkwire-relay/www/pair/index.html
scp packages/desktop/release/灵鹊-0.1.0-arm64.dmg \
    root@47.102.104.159:/opt/larkwire-relay/www/dl/larkwire.dmg
# APK 云打包到手后：scp .../larkwire.apk root@host:/opt/larkwire-relay/www/dl/larkwire.apk

# ② nginx：备份 → 替换 → 校验 → reload（不断 ws）
ssh root@47.102.104.159 'cp /etc/nginx/sites-available/larkwire \
    /etc/nginx/sites-available/larkwire.bak-$(date +%Y%m%d-%H%M%S)'
scp packages/relay/deploy/larkwire.nginx.conf \
    root@47.102.104.159:/etc/nginx/sites-available/larkwire
ssh root@47.102.104.159 'nginx -t && systemctl reload nginx'

# ③ 验收
curl -sI https://larkwire.kowems.site/ | head -1            # 200
curl -s https://larkwire.kowems.site/.well-known/apple-app-site-association \
    | python3 -m json.tool >/dev/null && echo AASA-OK
curl -sI https://larkwire.kowems.site/dl/larkwire.dmg | head -1
```

TestFlight join 链接到手后：更新首页与 pair 页（替换点 HTML 注释已标），重 scp 两 HTML 即可。

## 环境变量（systemd，均不入代码/不入 git）

基础值在 unit 本体 `Environment=`；**密钥级走 600 密钥文件** `/etc/larkwire/getui.json`（`{"GETUI_APP_ID":"…","GETUI_APP_KEY":"…","GETUI_MASTER_SECRET":"…"}`，chmod 600 root:root，改后 `systemctl restart larkwire-relay` 即生效，无需 daemon-reload）。
⚠️ **不再用 systemd `Environment=`/drop-in 放个推三值**——2026-09-23 安全收口：systemd Environment 值经 D-Bus 对**所有本地用户**可读（drop-in 文件 600 是假象）。env 仍**优先**于文件（本地开发/冒烟覆盖用）；`GETUI_KEYS_FILE` env 可覆盖文件路径（测试用）。

| 变量 | 值/说明 |
|---|---|
| `LARKWIRE_RELAY_HOST` | `127.0.0.1`（只给 nginx 反代） |
| `PORT` | `8790` |
| `LARKWIRE_RELAY_DB` | 缺省 `/root/.larkwire/relay.db`（配对/push token 持久化，重启不丢） |
| `GETUI_APP_ID` / `GETUI_APP_KEY` / `GETUI_MASTER_SECRET` | 个推 **uni-push 1.0** 三值（DCloud 开发者中心 → uni-push → 1.0（老版本）→ 消息推送 → 应用配置；2.0 无 MasterSecret 不能直连 REST）。**生产形态放 `/etc/larkwire/getui.json`（600）**，env 优先级更高（同名 env 存在即覆盖文件对应键）。**缺任一=推送自动禁用**（启动日志明示来源），其余功能不受影响；配齐后 `systemctl restart` 即开推送。注意不配 AppSecret（客户端级） |
| `GETUI_BASE_URL` | 个推 REST 基址覆盖。⚠️ **生产严禁设置**——设错会把真实推送打到错误主机；默认值即官方 `https://restapi.getui.com/v2`。仅供测试把出站请求指到本地模拟网关 |

## 运维小工具：test-push.cjs（服务器直发测试推送）

`/opt/larkwire-relay/test-push.cjs`（源码 `packages/relay/scripts/test-push.cjs`，改过要同步 scp）——绕开中继直调个推 REST v2，真机验证推送链路/通知直达落点用，无需搭真实业务场景：

```bash
ssh root@47.102.104.159
node --experimental-sqlite /opt/larkwire-relay/test-push.cjs [deviceId] [sessionId] [文案]
```

无参=推给最近登记设备且点击仅拉起 App；带 sessionId=点通知直达该会话页（payload 口径同 sendPush）。密钥口径同中继：env 优先、`/etc/larkwire/getui.json` 兜底，现读现用不回显。**手机在线时走透传不弹横幅**（要弹横幅先杀 App 让手机离线），脚本成败以输出 `PUSH_RESP 0` 为准；绕开中继故不触 60s 限流表、journal 无「push 已发」记录。

## 部署后检查清单

- [ ] `systemctl is-active` = active
- [ ] journal 启动行含 listening + 推送状态行（启用时明示密钥来源：环境变量/密钥文件/混合）
- [ ] 8790 LISTEN
- [ ] Mac 桥重连（`auth OK dev_XurwCHfchkDI`）
- [ ] 手机 App 打开能 auth + 收会话列表

## 相关纪律

- 生产 db 与 Mac 本地 dev db **各自独立**——往生产切流时手机必须**重新扫码配对**（生产库里没有 dev 时期的配对记录）。
- 中继进程必须脱离终端（systemd 已保证）；Mac 本地 dev 中继一律 `nohup` + 起前 `lsof -nP -iTCP:8790 -sTCP:LISTEN` 数实例防 SO_REUSEADDR 双实例分流（2026-09-19 事故）。
