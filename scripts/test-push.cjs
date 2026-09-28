#!/usr/bin/env node
/**
 * 运维脚本：服务器直发测试推送（绕开中继，直调个推 REST v2）。
 *
 * 用途：真机验证推送链路 / 通知直达落点，无需搭真实业务场景（权限卡/runEnd）。
 * 由来：2026-09-23 tmp 会话测试推送一次性脚本，Eric 拍板留用转正（参数化去硬编码）。
 *
 * 用法（仅能在生产中继所在服务器上跑——密钥 env 优先、密钥文件兜底，现读现用不回显不落盘）：
 *   node --experimental-sqlite /opt/larkwire-relay/test-push.cjs [deviceId] [sessionId] [文案]
 *     无参        → 推给 push_tokens 最近登记设备，点击仅拉起 App（startapp，无直达）
 *     deviceId    → 指定设备（如 dev_xxx）
 *     sessionId   → 额外带直达 payload，点通知直落该会话页（同 sendPush 的 buildPushRequest 口径）
 *     文案        → 自定义通知正文（默认「🧪 测试推送」）
 *
 * 注意：
 *   - 手机**在线**时个推走透传不弹系统横幅（App 未监听 receive 事件=设计如此的在线不打扰）——
 *     要弹横幅先让手机离线（杀 App）；脚本本身的成败以输出的 PUSH_RESP code=0 为准。
 *   - 绕过中继 = 不触碰中继的 60s 限流表，中继 journal 也不会有「push 已发」记录（排查时知悉）。
 *   - db 路径同中继口径：LARKWIRE_RELAY_DB env ?? ~/.larkwire/relay.db。
 */
const { homedir } = require("node:os");
const { join } = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const [deviceIdArg, sessionId, bodyText] = process.argv.slice(2);
if (deviceIdArg === "-h" || deviceIdArg === "--help") {
  console.log("node --experimental-sqlite test-push.cjs [deviceId] [sessionId] [文案]");
  process.exit(0);
}

// 密钥口径同中继 push.ts（2026-09-23 安全收口）：env-first 逐键 + 密钥文件兜底——
// systemd Environment 值经 D-Bus 对全本地用户可读（暴露面），生产三值已挪 600 密钥文件。
const keysPath = process.env.GETUI_KEYS_FILE ?? "/etc/larkwire/getui.json";
let fileKeys = {};
try {
  fileKeys = JSON.parse(fs.readFileSync(keysPath, "utf8"));
} catch { /* 无文件/坏 JSON = 仅靠 env */ }
const APP_ID = process.env.GETUI_APP_ID ?? fileKeys.GETUI_APP_ID ?? "";
const APP_KEY = process.env.GETUI_APP_KEY ?? fileKeys.GETUI_APP_KEY ?? "";
const MS = process.env.GETUI_MASTER_SECRET ?? fileKeys.GETUI_MASTER_SECRET ?? "";
if (!APP_ID || !APP_KEY || !MS) {
  console.log(`ENV_MISSING（GETUI_APP_ID/APP_KEY/MASTER_SECRET 未配齐——环境变量与密钥文件 ${keysPath} 都没凑齐）`);
  process.exit(1);
}

const dbPath = process.env.LARKWIRE_RELAY_DB ?? join(homedir(), ".larkwire", "relay.db");
const db = new DatabaseSync(dbPath);
let deviceId = deviceIdArg;
let cid;
if (deviceId) {
  const row = db.prepare("SELECT token FROM push_tokens WHERE device_id = ?").get(deviceId);
  if (!row) {
    console.log(`NO_TOKEN（push_tokens 无 ${deviceId}）`);
    process.exit(1);
  }
  cid = row.token;
} else {
  const row = db.prepare("SELECT device_id, token FROM push_tokens ORDER BY updated_at DESC LIMIT 1").get();
  if (!row) {
    console.log("NO_TOKEN（push_tokens 表为空）");
    process.exit(1);
  }
  deviceId = row.device_id;
  cid = row.token;
}

const title = "灵鹊";
const body = bodyText ?? "🧪 测试推送";

(async () => {
  const ts = Date.now();
  const sign = crypto.createHash("sha256").update(`${APP_KEY}${ts}${MS}`).digest("hex");
  const au = await fetch(`https://restapi.getui.com/v2/${APP_ID}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sign, timestamp: ts, appkey: APP_KEY }),
  });
  const aj = await au.json();
  if (aj.code !== 0) {
    console.log("AUTH_FAIL", aj.code, aj.msg ?? "");
    process.exit(1);
  }
  const sidPayload = sessionId !== undefined ? JSON.stringify({ sessionId }) : undefined;
  const req = {
    request_id: crypto.randomUUID(),
    audience: { cid: [cid] },
    push_message: {
      notification: sidPayload
        ? { title, body, click_type: "payload", payload: sidPayload }
        : { title, body, click_type: "startapp" },
    },
    push_channel: {
      ios: {
        type: "notify",
        aps: { alert: { title, body }, sound: "default" },
        ...(sidPayload ? { payload: sidPayload } : {}),
      },
    },
  };
  const pr = await fetch(`https://restapi.getui.com/v2/${APP_ID}/push/single/cid`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: aj.data.token },
    body: JSON.stringify(req),
  });
  const pj = await pr.json();
  console.log(`PUSH_RESP ${pj.code} ${pj.msg ?? ""} → ${deviceId}${sessionId ? ` sid=${sessionId.slice(0, 8)}…` : "（startapp 无直达）"}`);
})().catch((e) => {
  console.log("ERR", e.message);
  process.exit(1);
});
