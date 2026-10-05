/**
 * 哑中继本体（架构 §5）：
 *   维持 WebSocket / challenge-response 鉴权 / 按信封头转发 / 离线队列 / 记字节数。
 *   对 body 内容零可见（pair 引导期明文例外 = 协议设计，非实现漏洞）。
 * 安全口径（评审硬伤①修订）：设备必须签名证明自己持有私钥；只转发 from == 已认证身份的信封；
 *   单信封 ≤ 64KB；每设备限速；未配对设备间不路由。
 */
import { WebSocketServer, WebSocket } from "ws";
import nacl from "tweetnacl";
import {
  T,
  MAX_ENVELOPE_BYTES,
  OFFLINE_QUEUE_MAX,
  OFFLINE_QUEUE_TTL_MS,
  PAIR_TOKEN_TTL_MS,
  QUEUEABLE_TYPES,
  deviceIdFromKey,
  makeEnvelope,
  nowTs,
  u8ToB64,
  b64ToU8,
  type Envelope,
  type HelloMsg,
  type PairAcceptBody,
  type PairOfferBody,
  type PairRevokeBody,
  type PresenceBody,
} from "@larkwire/protocol";
import { RelayDb } from "./db.js";
import { logPushStatus, sendPush } from "./push.js";

const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_PER_WINDOW = 300;
// 心跳（M3，Eric 拍板 2026-09-21）：25s 应用层 ping（uni.connectSocket JS 层收不到 ws 协议层
// ping=硬约束）；90s 无帧 terminate 踢僵尸——根治 iOS 后台 JS 冻结上行黑洞 / NAT 静默老化 /
// TCP 半开三类「假在线」（9-19/9-20 三次 zombie 事故）。90s 口径双端一致
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 90_000;

interface ClientState {
  ws: WebSocket;
  authed: boolean;
  deviceId?: string;
  publicKey?: Uint8Array;
  name?: string;
  challengeNonce?: Uint8Array;
  helloTimer?: NodeJS.Timeout;
  rateWindowStart: number;
  rateCount: number;
  lastSeenAt: number; // 任何入站帧（控制+信封）都刷新——心跳判活只看这一个口径
}

interface PairOffer {
  bridgeId: string;
  publicKey: string;
  name: string;
  expiresAt: number;
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

export interface RelayHandle {
  /** 停服：断开全部连接 + 关 HTTP 监听 + 关 sqlite（集成测试用；生产入口忽略返回值） */
  stop: () => Promise<void>;
}

export function startRelay(opts: { host: string; port: number; dbPath: string }): RelayHandle {
  const db = new RelayDb(opts.dbPath);
  const wss = new WebSocketServer({ host: opts.host, port: opts.port });
  const sockets = new Set<WebSocket>();
  const online = new Map<string, ClientState>(); // deviceId → 唯一在线连接
  const offers = new Map<string, PairOffer>(); // token → offer

  setInterval(() => {
    const now = Date.now();
    for (const [token, o] of offers) if (o.expiresAt < now) offers.delete(token);
  }, 60_000).unref();

  // 心跳巡查：online Map 只装 authed 连接（auth.ok 后才 set），逐个发 ping + 揪超时僵尸。
  // terminate 触发 ws close 事件 → 走现有 close 链（清 online + broadcastPresence(false)）
  setInterval(() => {
    const now = Date.now();
    for (const client of online.values()) {
      const silentMs = now - client.lastSeenAt;
      if (silentMs > PONG_TIMEOUT_MS) {
        log(`heartbeat timeout ${client.deviceId}（${Math.round(silentMs / 1000)}s 无帧）→ terminate`);
        client.ws.terminate();
        continue;
      }
      send(client, { kind: "ping", ts: now });
    }
  }, PING_INTERVAL_MS).unref();

  function send(client: ClientState, msg: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }

  function sendEnvelope(deviceId: string, env: Envelope): boolean {
    const target = online.get(deviceId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) return false;
    target.ws.send(JSON.stringify(env));
    return true;
  }

  function pairError(to: string, stage: "offer" | "accept" | "confirm", reason: string, token?: string): void {
    const env = makeEnvelope(T.PairError, "relay", to, 0, JSON.stringify({ stage, reason, token }));
    sendEnvelope(to, env);
  }

  /** #83：中继代发撤销——在线直发，离线进队列。body.targetDeviceId=发起方 id（「谁没了」），
   *  消费方（桥 handleRevoke / 手机 applyRemoteRevoke）均按已解绑幂等处理，重复送达无害 */
  function relayRevoke(target: string, who: string): void {
    const env = makeEnvelope(T.PairRevoke, "relay", target, 0, JSON.stringify({ targetDeviceId: who } satisfies PairRevokeBody));
    if (sendEnvelope(target, env)) return;
    db.enqueueOffline(target, JSON.stringify(env), Date.now(), OFFLINE_QUEUE_MAX, OFFLINE_QUEUE_TTL_MS);
    log(`queued pair.revoke（中继代发）→ offline ${target}`);
  }

  function broadcastPresence(deviceId: string, name: string | undefined, onlineNow: boolean): void {
    const body: PresenceBody = { deviceId, name, online: onlineNow };
    const type = onlineNow ? T.PresenceOnline : T.PresenceOffline;
    for (const peer of db.peersOf(deviceId)) {
      const env = makeEnvelope(type, "relay", peer, 0, JSON.stringify(body));
      if (!sendEnvelope(peer, env) && onlineNow) {
        // 对端不在线：上线消息进队列（"谁活着"不丢）
        db.enqueueOffline(peer, JSON.stringify(env), Date.now(), OFFLINE_QUEUE_MAX, OFFLINE_QUEUE_TTL_MS);
      }
    }
  }

  function routeEnvelope(client: ClientState, raw: string): void {
    if (raw.length > MAX_ENVELOPE_BYTES) {
      log(`DROP oversize ${raw.length}B from ${client.deviceId}`);
      return;
    }
    // 限速
    const now = Date.now();
    if (now - client.rateWindowStart > RATE_WINDOW_MS) {
      client.rateWindowStart = now;
      client.rateCount = 0;
    }
    if (++client.rateCount > RATE_MAX_PER_WINDOW) {
      log(`DROP rate-limited ${client.deviceId}`);
      return;
    }

    let parsed: Envelope & { kind?: string; token?: string; platform?: string };
    try {
      parsed = JSON.parse(raw) as Envelope & { kind?: string; token?: string; platform?: string };
    } catch {
      return;
    }
    // 控制通道帧（非信封）：心跳应答 / 推送 token 上报。lastSeenAt 已在入口刷新
    if (parsed.kind === "pong") return; // 心跳应答——计入速率窗口无压力（25s 一次），静默即返
    if (parsed.kind === "pushToken") {
      if (typeof parsed.token === "string" && parsed.token.length > 0 && client.deviceId) {
        db.upsertPushToken(client.deviceId, parsed.token, parsed.platform ?? "ios", now);
        log(`pushToken 登记 ${client.deviceId}（${parsed.platform ?? "?"}）`);
      }
      return;
    }
    const env = parsed;
    if (env.v !== 1 || typeof env.type !== "string" || typeof env.to !== "string") return;
    if (env.from !== client.deviceId) {
      log(`DROP spoofed from=${env.from} authed=${client.deviceId}`);
      return; // 只转发 from == 已认证身份
    }
    db.meter(client.deviceId!, raw.length, now);

    // ---- 发给中继自己的内部消息 ----
    if (env.to === "relay") {
      handleRelayInternal(client, env);
      return;
    }

    // ---- 配对消息的设备间路由（pending 也放行） ----
    if (env.type === T.PairConfirm || env.type === T.PairError) {
      if (!db.isLinked(env.from, env.to)) {
        log(`DROP ${env.type} unlinked ${env.from} → ${env.to}`);
        return;
      }
      if (env.type === T.PairConfirm) db.upsertPairing(env.from, env.to, "active", nowTs());
      if (!sendEnvelope(env.to, env)) log(`queue-skip ${env.type} → offline ${env.to}`);
      else log(`route ${env.type} ${env.from} → ${env.to}`);
      return;
    }
    if (env.type === T.PairRevoke) {
      try {
        const body = JSON.parse(env.body) as PairRevokeBody;
        db.deletePairing(env.from, body.targetDeviceId);
        log(`pairing revoked ${env.from} ✂ ${body.targetDeviceId}`);
      } catch { /* 畸形 body 只路由不处理 */ }
      // #83：目标离线也必须送达——撤销帧入离线队列（QUEUEABLE_TYPES 已含 pair.revoke）。
      // 发起方随后那封 to=relay 的撤销还会在 handleRelayInternal 代发第二封，
      // 消费方对已解绑态幂等（双保险，不做去重——跨帧判定状态反而添复杂度）
      if (sendEnvelope(env.to, env)) return;
      db.enqueueOffline(env.to, raw, now, OFFLINE_QUEUE_MAX, OFFLINE_QUEUE_TTL_MS);
      log(`queued ${env.type} → offline ${env.to}`);
      return;
    }

    // ---- 群路由（M2，未实现） ----
    if (env.to.startsWith("grp_")) {
      log(`DROP group routing not implemented (${env.to})`);
      return;
    }

    // ---- 普通设备间路由：必须 active 配对 ----
    if (!env.to.startsWith("dev_")) return;
    if (!db.isPaired(env.from, env.to)) {
      log(`DROP unpaired ${env.from} → ${env.to} (${env.type})`);
      return;
    }
    if (sendEnvelope(env.to, env)) return;
    // 对端离线：只保通知/在场/会话注册类小消息（架构 §2.4）
    if (QUEUEABLE_TYPES.has(env.type)) {
      db.enqueueOffline(env.to, raw, now, OFFLINE_QUEUE_MAX, OFFLINE_QUEUE_TTL_MS);
      log(`queued ${env.type} → offline ${env.to}`);
    }
    // M3 推送触发：notify.request 目标离线且有 push token → 转个推 APNs（hint 明文选模板，
    // body 密文中继不可读；sid 明文=点通知直达会话）。fire-and-forget 不阻塞路由；入离线队列逻辑不变（双通道兜底）
    if (env.type === T.NotifyRequest) {
      void sendPush(db, env.to, env.hint, env.sid);
    }
  }

  function handleRelayInternal(client: ClientState, env: Envelope): void {
    if (env.type === T.PairOffer) {
      let body: PairOfferBody;
      try {
        body = JSON.parse(env.body) as PairOfferBody;
      } catch {
        pairError(client.deviceId!, "offer", "body 不是合法 JSON");
        return;
      }
      if (!body.token || !body.publicKey) {
        pairError(client.deviceId!, "offer", "缺 token / publicKey");
        return;
      }
      offers.set(body.token, {
        bridgeId: client.deviceId!,
        publicKey: body.publicKey,
        name: body.name ?? "",
        expiresAt: Date.now() + PAIR_TOKEN_TTL_MS,
      });
      // offer 登记回执——桥收到才亮二维码，任何一步失败双端可见（架构 §2.3 设计意图）
      const ack = makeEnvelope(T.PairOfferAck, "relay", client.deviceId!, 0, JSON.stringify({ token: body.token, ok: true }));
      send(client, ack);
      log(`pair.offer token=${body.token.slice(0, 6)}… from ${client.deviceId}`);
      return;
    }

    if (env.type === T.PairAccept) {
      let body: PairAcceptBody;
      try {
        body = JSON.parse(env.body) as PairAcceptBody;
      } catch {
        pairError(client.deviceId!, "accept", "body 不是合法 JSON");
        return;
      }
      const offer = offers.get(body.token);
      if (!offer || offer.expiresAt < Date.now()) {
        pairError(client.deviceId!, "accept", "token 无效或已过期（回电脑重新生成二维码）", body.token);
        return;
      }
      offers.delete(body.token); // 一次性
      db.upsertPairing(offer.bridgeId, client.deviceId!, "pending", nowTs());
      const routed: Envelope = { ...env, to: offer.bridgeId };
      if (!sendEnvelope(offer.bridgeId, routed)) {
        db.deletePairing(offer.bridgeId, client.deviceId!);
        pairError(client.deviceId!, "accept", "桥不在线（电脑上 larkwire 是否还在运行？）", body.token);
        return;
      }
      // 回执：把 offer 里的桥公钥/桥名交给手机（手机凭 QR 里的 fp 校验真伪——架构 §2.3.1「公钥本体走握手交换」）
      const ack = makeEnvelope(
        T.PairAcceptAck,
        "relay",
        client.deviceId!,
        0,
        JSON.stringify({ token: body.token, bridgeDeviceId: offer.bridgeId, bridgePublicKey: offer.publicKey, bridgeName: offer.name }),
      );
      send(client, ack);
      log(`pair.accept ${client.deviceId} → ${offer.bridgeId}`);
      return;
    }

    if (env.type === T.PairRevoke) {
      try {
        const body = JSON.parse(env.body) as PairRevokeBody;
        if (body.targetDeviceId === client.deviceId) {
          // 自解绑：删自己的所有配对，并逐个代发撤销（离线也入队——#83）
          const peers = db.peersOf(client.deviceId!);
          for (const peer of peers) {
            db.deletePairing(client.deviceId!, peer);
            relayRevoke(peer, client.deviceId!);
          }
          log(`self-revoke ${client.deviceId}`);
        } else {
          db.deletePairing(client.deviceId!, body.targetDeviceId);
          // #83：定向撤销也要通知被删的一方，否则它离线回来就是裂脑
          relayRevoke(body.targetDeviceId, client.deviceId!);
          log(`revoke ${client.deviceId} ✂ ${body.targetDeviceId}`);
        }
      } catch { /* ignore */ }
      return;
    }

    log(`DROP unknown relay-internal type ${env.type}`);
  }

  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    const client: ClientState = {
      ws,
      authed: false,
      rateWindowStart: Date.now(),
      rateCount: 0,
      lastSeenAt: Date.now(),
      helloTimer: setTimeout(() => {
        if (!client.authed) ws.close(4001, "hello timeout");
      }, HELLO_TIMEOUT_MS),
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      client.lastSeenAt = Date.now(); // 任何入站帧都是活着的证据（心跳判活唯一口径）

      if (!client.authed) {
        let msg: { kind?: string };
        try {
          msg = JSON.parse(raw) as { kind?: string };
        } catch {
          return;
        }

        if (msg.kind === "hello") {
          const hello = msg as unknown as HelloMsg;
          if (!hello.publicKey || !hello.deviceId) {
            send(client, { kind: "auth.error", reason: "hello 缺 deviceId / publicKey" });
            ws.close(4002, "bad hello");
            return;
          }
          // deviceId 必须由公钥推导——防伪冒任意设备身份
          const derived = deviceIdFromKey(hello.publicKey);
          if (derived !== hello.deviceId) {
            send(client, { kind: "auth.error", reason: `deviceId 与公钥不匹配（应为 ${derived}）` });
            ws.close(4002, "deviceId mismatch");
            return;
          }
          client.deviceId = hello.deviceId;
          client.publicKey = b64ToU8(hello.publicKey);
          client.name = hello.name;
          // challenge：临时密钥对 + box(nonce)，能解开 = 持有私钥
          const eph = nacl.box.keyPair();
          const nonce = nacl.randomBytes(32);
          const boxNonce = nacl.randomBytes(nacl.box.nonceLength);
          const cipher = nacl.box(nonce, boxNonce, client.publicKey, eph.secretKey);
          client.challengeNonce = nonce;
          const packed = new Uint8Array(boxNonce.length + cipher.length);
          packed.set(boxNonce, 0);
          packed.set(cipher, boxNonce.length);
          send(client, { kind: "auth.challenge", ephemeralPublicKey: u8ToB64(eph.publicKey), cipher: u8ToB64(packed) });
          return;
        }

        if (msg.kind === "auth.response") {
          const resp = msg as { nonce?: string };
          const ok =
            client.challengeNonce !== undefined &&
            typeof resp.nonce === "string" &&
            Buffer.from(resp.nonce, "base64").equals(Buffer.from(client.challengeNonce));
          if (!ok || !client.deviceId || !client.publicKey) {
            send(client, { kind: "auth.error", reason: "challenge 校验失败" });
            ws.close(4003, "auth failed");
            log(`auth FAIL ${client.deviceId ?? "?"}`);
            return;
          }
          clearTimeout(client.helloTimer);
          client.authed = true;
          db.upsertDevice(client.deviceId, u8ToB64(client.publicKey), client.name ?? null, nowTs());
          // 单设备单连接：新连接踢掉旧的
          const prev = online.get(client.deviceId);
          if (prev && prev.ws !== ws) prev.ws.close(4000, "replaced by new connection");
          online.set(client.deviceId, client);
          send(client, { kind: "auth.ok", deviceId: client.deviceId });
          log(`auth OK ${client.deviceId} (${client.name ?? "unnamed"})`);
          // 离线队列冲刷
          for (const queued of db.drainOffline(client.deviceId, Date.now(), OFFLINE_QUEUE_TTL_MS)) {
            ws.send(queued);
          }
          // #83 连接即对账：把当前全部 active 对端下发给本设备。设备侧把本地配对与此比对，
          // 不在列表的清掉——队列 TTL（10 分钟）之外的离线撤销也能被发现，与离线时长无关
          const status = makeEnvelope(
            T.PairStatus,
            "relay",
            client.deviceId,
            0,
            JSON.stringify({ peers: db.peersOf(client.deviceId) }),
          );
          send(client, status);
          broadcastPresence(client.deviceId, client.name, true);
          // 在线状态回同步：只广播"我上线了"不够——重连方（手机被 Safari 挂起断线重连后）
          // 永远不知道对端此刻在线，直到对端下次上下线才补。把当前在线的对端逐个回告。
          for (const peerId of db.peersOf(client.deviceId)) {
            const peer = online.get(peerId);
            if (!peer || peer.ws.readyState !== WebSocket.OPEN) continue;
            const body: PresenceBody = { deviceId: peerId, name: peer.name, online: true };
            sendEnvelope(client.deviceId, makeEnvelope(T.PresenceOnline, "relay", client.deviceId, 0, JSON.stringify(body)));
          }
          return;
        }
        return; // 未认证的其他消息一律丢弃
      }

      routeEnvelope(client, raw);
    });

    ws.on("close", () => {
      clearTimeout(client.helloTimer);
      if (client.authed && client.deviceId && online.get(client.deviceId)?.ws === ws) {
        online.delete(client.deviceId);
        broadcastPresence(client.deviceId, client.name, false);
        log(`offline ${client.deviceId}`);
      }
    });

    ws.on("error", () => ws.close());
  });

  wss.on("listening", () => {
    log(`larkwire-relay listening on ws://${opts.host}:${opts.port} (db: ${opts.dbPath})`);
    logPushStatus(); // 推送开关启动即明示（env 缺一=禁用，别等排查时才发现）
  });

  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        for (const ws of sockets) {
          ws.removeAllListeners("close");
          ws.close();
        }
        wss.close((err) => {
          if (err) reject(err);
          else {
            db.close();
            resolve();
          }
        });
      }),
  };
}
