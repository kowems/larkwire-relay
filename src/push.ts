/**
 * 推送网关（M3，Facade）：notify.request 目标离线时转个推 REST v2（iOS 走 APNs，个推代发）。
 *
 * 设计口径（Eric 拍板 2026-09-21；推送增强修订 2026-10-08）：
 *   - 触发判断在中继（presence 最权威）；桥只管广播 notify.request，不感知推送通道；
 *   - 文案由 hint 标签 + 信封外层 proj/tool 字段渲染。2026-09-21 原口径「文案通用化，
 *     工具名/命令不出端」于 2026-10-08 经 Eric 拍板修订：**项目目录 basename + 权限工具名
 *     可出端**（如「🔐 larkwire · Bash 等你授权」）；完整路径/命令/输入/会话标题永不出端，
 *     中继渲染前再过一遍消毒；缺字段时逐字回退通用模板（老桥兼容）；
 *   - 每设备每会话每类事件 60s 限流防权限风暴轰炸（⚠️ 修订 2026-09-23：限流键加 hint 维度；
 *     再修订 2026-10-08：加 sid 维度——不同会话各自完成不再互相吞通知）；
 *   - env 缺一 = 功能禁用（启动日志明示，其余功能不受影响）；
 *   - 失败只 log 不吞错、不阻塞路由（入离线队列逻辑不变，双通道兜底）。
 *
 * 密钥来源（2026-09-23 安全收口）：**env-first 逐键 + 密钥文件兜底**。
 * 背景：systemd `Environment=` 值经 D-Bus 对所有本地用户可读（drop-in 文件 600 是假象）——
 * 个推三值生产形态挪到 /etc/larkwire/getui.json（chmod 600 root:root）；env 仍优先
 * （本地开发/冒烟覆盖用）；`GETUI_KEYS_FILE` env 可覆盖文件路径（测试用）。
 * 文件不存在/坏 JSON = 当无文件（env 仍可独立生效），启动日志明示实际来源。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { RelayDb } from "./db.js";

// 个推 REST 基址；GETUI_BASE_URL 仅供测试把出站请求指到本地模拟网关。
// ⚠️ 生产环境勿设此变量——会把真实推送打到错误主机（默认值即官方地址）
const GETUI_BASE = process.env.GETUI_BASE_URL ?? "https://restapi.getui.com/v2";
const RATE_LIMIT_MS = 60_000; // 每设备每会话每类事件 60s 最多 1 条推送（同会话同类连发才限，跨会话/跨类型不互相吞）
const TOKEN_REFRESH_MS = 23 * 3600_000; // 个推 auth token 官方 24h 有效，提前 1h 换

interface GetuiKeysFile {
  GETUI_APP_ID?: string;
  GETUI_APP_KEY?: string;
  GETUI_MASTER_SECRET?: string;
}

function loadKeysFile(): { keys: GetuiKeysFile; path: string; permWarning: string | null } {
  const path = process.env.GETUI_KEYS_FILE ?? "/etc/larkwire/getui.json";
  try {
    const keys = JSON.parse(readFileSync(path, "utf8")) as GetuiKeysFile;
    let permWarning: string | null = null;
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) permWarning = `密钥文件 ${path} 权限 ${mode.toString(8)} 过宽（建议 600）`;
    } catch { /* stat 失败不挡路 */ }
    return { keys, path, permWarning };
  } catch {
    return { keys: {}, path, permWarning: null };
  }
}

const keysFile = loadKeysFile();
const APP_ID = process.env.GETUI_APP_ID ?? keysFile.keys.GETUI_APP_ID ?? "";
const APP_KEY = process.env.GETUI_APP_KEY ?? keysFile.keys.GETUI_APP_KEY ?? "";
const MASTER_SECRET = process.env.GETUI_MASTER_SECRET ?? keysFile.keys.GETUI_MASTER_SECRET ?? "";
const ENABLED = Boolean(APP_ID && APP_KEY && MASTER_SECRET);

/** 三键各自的实际来源（只记 env/file/none，绝不记值——日志安全口径） */
const KEY_SOURCES = (
  [
    [process.env.GETUI_APP_ID, keysFile.keys.GETUI_APP_ID],
    [process.env.GETUI_APP_KEY, keysFile.keys.GETUI_APP_KEY],
    [process.env.GETUI_MASTER_SECRET, keysFile.keys.GETUI_MASTER_SECRET],
  ] as const
).map(([envVal, fileVal]) => (envVal ? "env" : fileVal ? "file" : "none"));
const SOURCE_DESC = KEY_SOURCES.every((s) => s === "env")
  ? "环境变量"
  : KEY_SOURCES.every((s) => s === "file")
    ? `密钥文件 ${keysFile.path}`
    : "混合（环境变量+密钥文件）";

/** hint → 通用推送模板（无 proj 时逐字回退；与桥侧 notify.request body 文案同源，细节打开 App 看） */
export const TEMPLATES: Record<string, { title: string; body: string }> = {
  permission: { title: "灵鹊", body: "🔐 有操作等你授权" },
  runDone: { title: "灵鹊", body: "✅ 会话回合完成" },
};
export const FALLBACK_TEMPLATE = { title: "灵鹊", body: "有新消息" };

const MAX_LABEL_CHARS = 24; // 目录名/工具名展示上限（APNs 通知栏长度与隐私双重考虑）

/**
 * 项目目录名消毒（中继侧第二道关，桥侧已只传 basename）：
 * 去控制字符（含换行/制表——防注入伪造通知文案）、连续空白折叠为单空格、trim、按码点截 24。
 * 结果为空 → undefined（调用方按「无目录」回退通用文案）。
 */
export function sanitizeProject(raw: string): string | undefined {
  const cleaned = Array.from(
    raw.replace(/[\x00-\x1f\x7f]/g, ""),
  )
    .slice(0, MAX_LABEL_CHARS)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

/** 工具名消毒：只留 [A-Za-z0-9_-]（CC 工具名本就长这样），截 24；全被剔光 → undefined（省略工具名） */
export function sanitizeTool(raw: string): string | undefined {
  const cleaned = Array.from(raw.replace(/[^A-Za-z0-9_-]/g, "")).slice(0, MAX_LABEL_CHARS).join("");
  return cleaned || undefined;
}

/**
 * 推送文案渲染（纯函数）：
 *   permission + proj + tool → 🔐 {proj} · {tool} 等你授权
 *   permission + proj        → 🔐 {proj} · 有操作等你授权
 *   runDone + proj           → ✅ {proj} · 会话回合完成
 * proj 缺失/消毒空 / hint 未知 → 对应通用模板（逐字，老桥兼容）。
 */
export function renderPushTemplate(
  hint: string | undefined,
  proj?: string,
  tool?: string,
): { title: string; body: string } {
  const project = proj !== undefined ? sanitizeProject(proj) : undefined;
  if (project === undefined) {
    return (hint !== undefined ? TEMPLATES[hint] : undefined) ?? FALLBACK_TEMPLATE;
  }
  if (hint === "permission") {
    const toolName = tool !== undefined ? sanitizeTool(tool) : undefined;
    return {
      title: "灵鹊",
      body: toolName
        ? `🔐 ${project} · ${toolName} 等你授权`
        : `🔐 ${project} · 有操作等你授权`,
    };
  }
  if (hint === "runDone") {
    return { title: "灵鹊", body: `✅ ${project} · 会话回合完成` };
  }
  return FALLBACK_TEMPLATE;
}

const lastSentAt = new Map<string, number>(); // "deviceId:hint:sid" → 上次推送时间（限流，内存态重启即清零，可接受）
let authToken: { token: string; expiresAt: number } | null = null;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** 启动日志明示推送功能开关+密钥来源（缺一即禁用——部署后第一次起服务必须能看到这行） */
export function logPushStatus(): void {
  if (ENABLED) {
    log(`uni-push 推送已启用（密钥来源：${SOURCE_DESC}）`);
  } else {
    log(`uni-push 推送禁用：GETUI_APP_ID/APP_KEY/MASTER_SECRET 未配齐（环境变量或密钥文件 ${keysFile.path}，任一来源逐键补齐即启用）——notify 离线转推送不生效（心跳等其余功能不受影响）`);
  }
  if (keysFile.permWarning) log(`⚠ ${keysFile.permWarning}`);
}

/** 个推 auth：sign = sha256(appkey + timestamp + masterSecret)，token 缓存到期前复用 */
async function getAuthToken(): Promise<string> {
  if (authToken && authToken.expiresAt > Date.now()) return authToken.token;
  const timestamp = Date.now();
  const sign = createHash("sha256").update(`${APP_KEY}${timestamp}${MASTER_SECRET}`).digest("hex");
  const res = await fetch(`${GETUI_BASE}/${APP_ID}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sign, timestamp, appkey: APP_KEY }),
  });
  const data = (await res.json()) as { code?: number; msg?: string; data?: { token?: string; expire_time?: string } };
  if (data.code !== 0 || !data.data?.token) {
    throw new Error(`个推 auth 失败：code=${data.code} ${data.msg ?? ""}`);
  }
  const expireMs = Number(data.data.expire_time);
  authToken = {
    token: data.data.token,
    expiresAt: Number.isFinite(expireMs) && expireMs > 0 ? Math.min(expireMs, Date.now() + TOKEN_REFRESH_MS) : Date.now() + TOKEN_REFRESH_MS,
  };
  return authToken.token;
}

/**
 * 构造个推 push/single/cid 请求体（导出纯函数便于单测断言——验完即删的临时脚本用）。
 *
 * 通知直达（第一刀补洞 C，2026-09-22）：有 sessionId 时——
 *   - click_type="payload" + payload=JSON{sessionId}（⚠️ 文档纠偏：payload_custom 语义是
 *     「自定义消息且**不启动** App」，与需求相反，禁用）；
 *   - iOS 走 push_channel.ios.payload=APNs 顶层自定义键，点击后 uni-push 1.0 的
 *     plus.push click 事件 msg.payload 取到；App 冷启兜底读 plus.runtime.arguments。
 * 无 sessionId（旧端桥）维持 click_type="startapp" 原行为。
 */
export function buildPushRequest(
  cid: string,
  tpl: { title: string; body: string },
  sessionId?: string,
): Record<string, unknown> {
  const sidPayload = sessionId !== undefined ? JSON.stringify({ sessionId }) : undefined;
  return {
    request_id: randomUUID(),
    audience: { cid: [cid] },
    push_message: {
      notification: sidPayload
        ? { title: tpl.title, body: tpl.body, click_type: "payload", payload: sidPayload }
        : // click_type=startapp：点击拉起 App 进首页，权限卡由 permission.list 拉取自然补上（无直达目标时）
          { title: tpl.title, body: tpl.body, click_type: "startapp" },
    },
    push_channel: {
      ios: {
        type: "notify",
        aps: { alert: { title: tpl.title, body: tpl.body }, sound: "default" },
        ...(sidPayload ? { payload: sidPayload } : {}),
      },
    },
  };
}

/**
 * notify.request 目标离线时调用（路由处 fire-and-forget）。
 * 没登记过 token（旧版 App / 未开推送）静默跳过——离线队列仍是兜底通道。
 */
export async function sendPush(
  db: RelayDb,
  deviceId: string,
  hint: string | undefined,
  sessionId?: string,
  proj?: string,
  tool?: string,
): Promise<void> {
  if (!ENABLED) return;
  const rec = db.getPushToken(deviceId);
  if (!rec) return;

  const now = Date.now();
  // 限流键含 sid：不同会话的完成/请示各算各的；同会话同类事件 60s 仍只发一条
  const rateKey = `${deviceId}:${hint ?? "?"}:${sessionId ?? "-"}`;
  const prevAt = lastSentAt.get(rateKey) ?? 0;
  if (now - prevAt < RATE_LIMIT_MS) {
    log(`push 限流 ${deviceId}（60s 内已发过同会话同类，hint=${hint ?? "?"}）`);
    return;
  }
  // 进入即占坑（而非成功后才记）：同一 tick 两条同键 fire-and-forget 不能都通过检查
  // （路由处是 void sendPush，权限风暴时可能同步连发）；发送失败再回滚，允许后续重试
  lastSentAt.set(rateKey, now);

  const tpl = renderPushTemplate(hint, proj, tool);
  try {
    const token = await getAuthToken();
    const res = await fetch(`${GETUI_BASE}/${APP_ID}/push/single/cid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token },
      body: JSON.stringify(buildPushRequest(rec.token, tpl, sessionId)),
    });
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code === 0) {
      log(`push 已发 ${deviceId} hint=${hint ?? "?"}${sessionId ? ` sid=${sessionId.slice(0, 8)}…` : ""}（${tpl.body}）`);
    } else if (data.code === 10001) {
      // token 失效：清缓存，下一条推送重新 auth（本条丢弃可接受——离线队列兜底）
      authToken = null;
      lastSentAt.set(rateKey, prevAt);
      log(`push auth token 失效（code=10001），已清缓存待下条重新 auth`);
    } else {
      lastSentAt.set(rateKey, prevAt);
      log(`push 失败 ${deviceId}：code=${data.code} ${data.msg ?? ""}`);
    }
  } catch (err) {
    lastSentAt.set(rateKey, prevAt);
    log(`push 异常 ${deviceId}：${err instanceof Error ? err.message : String(err)}`);
  }
}
