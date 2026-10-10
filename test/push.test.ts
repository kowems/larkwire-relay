/**
 * 推送增强测试（2026-10-08）：
 *   A. 纯函数——renderPushTemplate 文案渲染 + sanitizeProject/sanitizeTool 消毒；
 *   B. 集成——真实 startRelay + tmp sqlite + 真实 ws 设备走完整握手配对 + 进程内 http
 *      服务器模拟个推网关（GETUI_BASE_URL 指本地，真实 HTTP 收包），断言出站请求体。
 * 全程不连生产、不连真实个推。
 *
 * 注意：push.ts 在模块加载时读 env（APP_ID/GETUI_BASE_URL/...），故本文件全部相关 import
 * 延迟到 before() 内 env 注入之后动态进行。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import nacl from "tweetnacl";

type Proto = typeof import("@larkwire/protocol");
const dir = mkdtempSync(join(tmpdir(), "larkwire-push-test-"));

// 动态加载产物（before() 内就绪）
let mod: typeof import("../src/push.js");
let startRelay: typeof import("../src/server.js").startRelay;
let proto: Proto;
let relay: import("../src/server.js").RelayHandle;
let url: string;

// proto 内函数的本地绑定（类通过闭包使用；before() 完成后全部就位）
let TLocal: Proto["T"];
let deviceIdFromKeyLocal: Proto["deviceIdFromKey"];
let makeEnvelopeLocal: Proto["makeEnvelope"];
let u8ToB64Local: Proto["u8ToB64"];
let b64ToU8Local: Proto["b64ToU8"];
let deriveSharedKeyLocal: Proto["deriveSharedKey"];
let encryptBodyLocal: Proto["encryptBody"];

// ---------- 模拟个推网关 ----------

interface SinkRecord {
  url: string;
  body: Record<string, unknown>;
}
let sink: Server;
let sinkRecords: SinkRecord[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

before(async () => {
  // ① env 先于一切相关模块加载注入
  process.env.GETUI_APP_ID = "dummy-app-id";
  process.env.GETUI_APP_KEY = "dummy-app-key";
  process.env.GETUI_MASTER_SECRET = "dummy-master-secret";
  process.env.GETUI_KEYS_FILE = join(dir, "no-getui.json"); // 不存在 = 文件兜底为空

  // ② 模拟个推网关：/:appid/auth 与 /:appid/push/single/cid
  await new Promise<void>((resolve) => {
    sink = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const reqUrl = req.url ?? "";
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          payload = {};
        }
        if (reqUrl.endsWith("/auth")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code: 0,
            data: { token: "fake-auth-token", expire_time: String(Date.now() + 3600_000) },
          }));
          return;
        }
        sinkRecords.push({ url: reqUrl, body: payload });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0 }));
      });
    });
    sink.listen(0, "127.0.0.1", resolve);
  });
  const sinkPort = (sink.address() as AddressInfo).port;
  process.env.GETUI_BASE_URL = `http://127.0.0.1:${sinkPort}`;

  // ③ 此刻才动态加载（env-first 口径生效）
  proto = await import("@larkwire/protocol");
  mod = await import("../src/push.js");
  ({ startRelay } = await import("../src/server.js"));
  TLocal = proto.T;
  deviceIdFromKeyLocal = proto.deviceIdFromKey;
  makeEnvelopeLocal = proto.makeEnvelope;
  u8ToB64Local = proto.u8ToB64;
  b64ToU8Local = proto.b64ToU8;
  deriveSharedKeyLocal = proto.deriveSharedKey;
  encryptBodyLocal = proto.encryptBody;

  // ④ 真实中继
  const port = await freePort();
  relay = startRelay({ host: "127.0.0.1", port, dbPath: join(dir, "relay.db") });
  url = `ws://127.0.0.1:${port}`;
  await new Promise((r) => setTimeout(r, 200));
});

after(async () => {
  await relay?.stop();
  await new Promise<void>((resolve) => sink.close(() => resolve()));
});

// ---------- 通用件（与 server.test.ts 同口径的精简真实设备） ----------

class SimDevice {
  readonly kp = nacl.box.keyPair();
  readonly deviceId: string;
  ws!: WebSocket;

  constructor(readonly name: string) {
    this.deviceId = deviceIdFromKeyLocal(u8ToB64Local(this.kp.publicKey));
  }

  connect(targetUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(targetUrl);
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({
          kind: "hello",
          v: 1,
          deviceId: this.deviceId,
          publicKey: u8ToB64Local(this.kp.publicKey),
          name: this.name,
        }));
      });
      const timer = setTimeout(() => reject(new Error(`${this.name} auth 超时`)), 10_000);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.kind === "auth.challenge") {
          const packed = b64ToU8Local(msg.cipher as string);
          const boxNonce = packed.slice(0, nacl.box.nonceLength);
          const ct = packed.slice(nacl.box.nonceLength);
          const nonce = nacl.box.open(ct, boxNonce, b64ToU8Local(msg.ephemeralPublicKey as string), this.kp.secretKey);
          assert(nonce, `${this.name} challenge 解不开`);
          this.ws.send(JSON.stringify({ kind: "auth.response", nonce: u8ToB64Local(nonce) }));
        } else if (msg.kind === "auth.ok") {
          clearTimeout(timer);
          resolve();
        } else if (msg.kind === "auth.error") {
          clearTimeout(timer);
          reject(new Error(`${this.name} auth.error`));
        }
      });
      this.ws.on("error", reject);
    });
  }

  /** 模仿 App：authed 后注册个推 cid（中继 push_tokens 真实登记路径） */
  registerPushToken(cid: string, platform: string): void {
    this.ws.send(JSON.stringify({ kind: "pushToken", token: cid, platform }));
  }

  sendPlain(to: string, type: string, body: unknown): void {
    this.ws.send(JSON.stringify(makeEnvelopeLocal(type as never, this.deviceId, to, 0, JSON.stringify(body))));
  }

  sendSecure(to: string, peerPub: string, type: string, body: unknown): void {
    const shared = deriveSharedKeyLocal(b64ToU8Local(peerPub), this.kp.secretKey);
    this.ws.send(JSON.stringify(
      makeEnvelopeLocal(type as never, this.deviceId, to, 0, encryptBodyLocal(shared, body)),
    ));
  }

  /** 发带 proj/tool 外层字段的 notify.request（body 中继不可读，占位串即可） */
  sendNotify(to: string, hint: string, sid: string, proj?: string, tool?: string): void {
    this.ws.send(JSON.stringify(
      makeEnvelopeLocal(TLocal.NotifyRequest, this.deviceId, to, 0, "sim-cipher", hint, sid, proj, tool),
    ));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.on("close", resolve);
      this.ws.close();
    });
  }
}

/** 完整 offer/accept/confirm 配对（与 server.test.ts 同流程），返回手机公钥 b64 */
async function pairUp(bridge: SimDevice, phone: SimDevice): Promise<string> {
  const token = `t_${bridge.deviceId.slice(2)}${phone.deviceId.slice(2)}`;
  const bridgePub = u8ToB64Local(bridge.kp.publicKey);
  const phonePub = u8ToB64Local(phone.kp.publicKey);

  bridge.sendPlain("relay", TLocal.PairOffer, { token, publicKey: bridgePub, name: bridge.name });
  phone.sendPlain("relay", TLocal.PairAccept, { token, publicKey: phonePub, name: phone.name });

  // 中继撮合是异步的：发送 confirm 前留一拍让 offer/accept 落库配对
  await new Promise((r) => setTimeout(r, 100));
  bridge.sendSecure(phone.deviceId, phonePub, TLocal.PairConfirm, { ok: true, bridgeName: bridge.name });
  await new Promise((r) => setTimeout(r, 100));
  return phonePub;
}

/** 按目标 cid 过滤模拟网关实收的 push 请求体 */
function pushesForCid(cid: string): Record<string, unknown>[] {
  return sinkRecords
    .filter((r) => r.url.includes("/push/single/cid"))
    .map((r) => r.body)
    .filter((b) => {
      const aud = b.audience as { cid?: string[] } | undefined;
      return Array.isArray(aud?.cid) && aud.cid.includes(cid);
    });
}

async function waitPushes(cid: string, count: number, timeoutMs = 5_000): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = pushesForCid(cid);
    if (got.length >= count) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pushesForCid(cid);
}

/** 从个推请求体取通知正文（android notification + ios aps 双口径） */
function pushBodies(req: Record<string, unknown>): { android: string; ios: string } {
  const pm = req.push_message as { notification?: { body?: string } };
  const pc = req.push_channel as { ios?: { aps?: { alert?: { body?: string } } } };
  return {
    android: pm.notification?.body ?? "",
    ios: pc.ios?.aps?.alert?.body ?? "",
  };
}

// ========== A. 纯函数：渲染 + 消毒 ==========

test("A1 permission：目录+工具 → 🔐 {proj} · {tool} 等你授权", () => {
  const tpl = mod.renderPushTemplate("permission", "larkwire", "Bash");
  assert.equal(tpl.title, "灵鹊");
  assert.equal(tpl.body, "🔐 larkwire · Bash 等你授权");
});

test("A2 permission：只有目录 → 省略工具名，通用后缀保留", () => {
  assert.equal(mod.renderPushTemplate("permission", "larkwire").body, "🔐 larkwire · 有操作等你授权");
});

test("A3 runDone：✅ {proj} · 会话回合完成（tool 对 runDone 无意义，被忽略）", () => {
  assert.equal(mod.renderPushTemplate("runDone", "larkwire", "Bash").body, "✅ larkwire · 会话回合完成");
});

test("A4 无 proj：逐字回退现有通用模板（引用同一常量对象）", () => {
  assert.equal(mod.renderPushTemplate("permission"), mod.TEMPLATES.permission);
  assert.equal(mod.renderPushTemplate("permission", undefined, "Bash"), mod.TEMPLATES.permission);
  assert.equal(mod.renderPushTemplate("runDone"), mod.TEMPLATES.runDone);
  assert.equal(mod.renderPushTemplate(undefined), mod.FALLBACK_TEMPLATE);
});

test("A5 未知 hint：有 proj 也不增强，走 fallback", () => {
  assert.equal(mod.renderPushTemplate("weird", "larkwire", "Bash"), mod.FALLBACK_TEMPLATE);
  assert.equal(mod.renderPushTemplate("weird"), mod.FALLBACK_TEMPLATE);
});

test("A6 sanitizeProject：换行/制表等控制字符直接剔除（防伪造文案注入）", () => {
  assert.equal(mod.sanitizeProject("evil\nproject"), "evilproject");
  assert.equal(mod.sanitizeProject("a\tbc"), "abc");
});

test("A7 sanitizeProject：连续空白折叠+trim，全空白 → undefined", () => {
  assert.equal(mod.sanitizeProject("  my   project  "), "my project");
  assert.equal(mod.sanitizeProject("   \n\t  "), undefined);
});

test("A8 sanitizeProject：按码点截 24（不切坏代理对）", () => {
  assert.equal(mod.sanitizeProject("x".repeat(60)), "x".repeat(24));
  const emoji = "😀".repeat(24);
  assert.equal(mod.sanitizeProject(emoji + "tail"), emoji);
});

test("A9 sanitizeTool：只留 [A-Za-z0-9_-]，非法字符剔除", () => {
  assert.equal(mod.sanitizeTool("Bash"), "Bash");
  assert.equal(mod.sanitizeTool("a b;c$(x)"), "abcx");
});

test("A10 sanitizeTool：截 24；全被剔光 → undefined（渲染时省略工具名）", () => {
  assert.equal(mod.sanitizeTool("Z".repeat(40)), "Z".repeat(24));
  assert.equal(mod.sanitizeTool("😈😈"), undefined);
  assert.equal(mod.renderPushTemplate("permission", "larkwire", "😈😈").body, "🔐 larkwire · 有操作等你授权");
});

// ========== B. 集成：真实中继 → 模拟个推网关 ==========

test("B1 permission 全链路：网关实收请求体含目录+工具，payload 仍是 JSON{sessionId}", async () => {
  const bridge = new SimDevice("桥-push1");
  const phone = new SimDevice("手机-push1");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);

  const cid = "cid-push-b1";
  phone.registerPushToken(cid, "ios");
  await new Promise((r) => setTimeout(r, 100));
  await phone.close();
  await new Promise((r) => setTimeout(r, 200)); // 等中继摘除手机在线态

  const sid = "11111111-2222-3333-4444-555555555555";
  bridge.sendNotify(phone.deviceId, "permission", sid, "larkwire", "Bash");

  const got = await waitPushes(cid, 1);
  assert.equal(got.length, 1, "应实收 1 条 push");
  const bodies = pushBodies(got[0]);
  assert.equal(bodies.android, "🔐 larkwire · Bash 等你授权");
  assert.equal(bodies.ios, "🔐 larkwire · Bash 等你授权");

  // 点击直达：android notification.payload + ios payload 均为 JSON{sessionId}
  const notif = (got[0].push_message as { notification: Record<string, unknown> }).notification;
  assert.equal(notif.click_type, "payload");
  assert.equal(notif.payload, JSON.stringify({ sessionId: sid }));
  const ios = (got[0].push_channel as { ios: Record<string, string> }).ios;
  assert.equal(ios.payload, JSON.stringify({ sessionId: sid }));

  await bridge.close();
});

test("B2 runDone 全链路：网关实收 ✅ {proj} · 会话回合完成", async () => {
  const bridge = new SimDevice("桥-push2");
  const phone = new SimDevice("手机-push2");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);

  const cid = "cid-push-b2";
  phone.registerPushToken(cid, "ios");
  await new Promise((r) => setTimeout(r, 100));
  await phone.close();
  await new Promise((r) => setTimeout(r, 200));

  const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  bridge.sendNotify(phone.deviceId, "runDone", sid, "larkwire");

  const got = await waitPushes(cid, 1);
  assert.equal(got.length, 1);
  const bodies = pushBodies(got[0]);
  assert.equal(bodies.android, "✅ larkwire · 会话回合完成");
  assert.equal(bodies.ios, "✅ larkwire · 会话回合完成");

  await bridge.close();
});

test("B3 限流：同 sid 两条只收 1；不同 sid 各算各的，补收 2 条", async () => {
  const bridge = new SimDevice("桥-push3");
  const phone = new SimDevice("手机-push3");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);

  const cid = "cid-push-b3";
  phone.registerPushToken(cid, "ios");
  await new Promise((r) => setTimeout(r, 100));
  await phone.close();
  await new Promise((r) => setTimeout(r, 200));

  bridge.sendNotify(phone.deviceId, "runDone", "sid-0001", "larkwire");
  bridge.sendNotify(phone.deviceId, "runDone", "sid-0001", "larkwire"); // 同 sid：应被吞
  const first = await waitPushes(cid, 1);
  assert.equal(first.length, 1);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(pushesForCid(cid).length, 1, "同 sid 第二条必须被 60s 限流吞掉");

  // 不同 sid：限流键不同，各放一条
  bridge.sendNotify(phone.deviceId, "runDone", "sid-0002", "larkwire");
  bridge.sendNotify(phone.deviceId, "runDone", "sid-0003", "larkwire");
  const all = await waitPushes(cid, 3);
  assert.equal(all.length, 3, "不同 sid 不应互相吞通知");

  await bridge.close();
});

test("B4 老桥兼容：无 proj/tool 时网关实收通用文案", async () => {
  const bridge = new SimDevice("桥-push4");
  const phone = new SimDevice("手机-push4");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);

  const cid = "cid-push-b4";
  phone.registerPushToken(cid, "ios");
  await new Promise((r) => setTimeout(r, 100));
  await phone.close();
  await new Promise((r) => setTimeout(r, 200));

  // 不传 proj/tool（老路径口径）
  bridge.sendNotify(phone.deviceId, "permission", "sid-old");

  const got = await waitPushes(cid, 1);
  assert.equal(got.length, 1);
  const bodies = pushBodies(got[0]);
  assert.equal(bodies.android, "🔐 有操作等你授权");
  assert.equal(bodies.ios, "🔐 有操作等你授权");

  await bridge.close();
});
