/**
 * 中继集成测试（#83）：真实 startRelay 实例 + tmp sqlite + 真实 ws 客户端，
 * 走完整 hello/auth 挑战与 offer/accept/confirm 配对，不用 mock。
 * 覆盖：离线撤销入队、连接时 pair.status 对账、to=relay 定向撤销代发。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import nacl from "tweetnacl";
import {
  T,
  deviceIdFromKey,
  makeEnvelope,
  u8ToB64,
  b64ToU8,
  deriveSharedKey,
  encryptBody,
  type Envelope,
  type PairConfirmBody,
  type PairRevokeBody,
  type PairStatusBody,
} from "@larkwire/protocol";
import { startRelay, type RelayHandle } from "../src/server.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** 测试用真实设备：自持密钥对，走 hello→challenge→auth 完整握手，收集信封 */
class SimDevice {
  readonly kp = nacl.box.keyPair();
  readonly deviceId: string;
  readonly name: string;
  ws!: WebSocket;
  private envelopes: Envelope[] = [];
  private waiters: Array<(env: Envelope) => boolean> = [];

  constructor(name: string) {
    this.name = name;
    this.deviceId = deviceIdFromKey(u8ToB64(this.kp.publicKey));
  }

  connect(url: string): Promise<void> {
    // 重连用同一身份：历史信封与挂起等待清空（上一轮的帧不能被新一轮 waitFor 误中）
    this.envelopes = [];
    this.waiters = [];
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({
          kind: "hello",
          v: 1,
          deviceId: this.deviceId,
          publicKey: u8ToB64(this.kp.publicKey),
          name: this.name,
        }));
      });
      this.ws.on("message", (data) => this.onMessage(data.toString()));
      this.ws.on("error", reject);
      const timer = setTimeout(() => reject(new Error(`${this.name} connect/auth 超时`)), 10_000);
      this.resolveAuthOk = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private resolveAuthOk: () => void = () => {};

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { kind?: string } & Partial<Envelope>;
    if (msg.kind === "auth.challenge") {
      const packed = b64ToU8(msg.cipher as string);
      const boxNonce = packed.slice(0, nacl.box.nonceLength);
      const ct = packed.slice(nacl.box.nonceLength);
      const nonce = nacl.box.open(ct, boxNonce, b64ToU8(msg.ephemeralPublicKey as string), this.kp.secretKey);
      assert(nonce, `${this.name} challenge 解不开`);
      this.ws.send(JSON.stringify({ kind: "auth.response", nonce: u8ToB64(nonce) }));
      return;
    }
    if (msg.kind === "auth.ok") {
      this.resolveAuthOk();
      return;
    }
    if (msg.kind === "auth.error") throw new Error(`${this.name} auth.error: ${JSON.stringify(msg)}`);
    if (msg.v === 1) {
      const env = msg as unknown as Envelope;
      const pending = this.waiters;
      this.waiters = [];
      let handled = false;
      for (const pred of pending) {
        if (!handled && pred(env)) {
          handled = true;
        } else {
          this.waiters.push(pred);
        }
      }
      if (!handled) this.envelopes.push(env);
    }
  }

  /** 等一封匹配条件的信封；已收过的历史信封优先匹配 */
  waitFor(pred: (env: Envelope) => boolean, timeoutMs = 5_000): Promise<Envelope> {
    const idx = this.envelopes.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.envelopes.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 等待信封超时`)), timeoutMs);
      this.waiters.push((env) => {
        if (!pred(env)) return false;
        clearTimeout(timer);
        resolve(env);
        return true;
      });
    });
  }

  /** 忽略后续匹配的信封（如对账用的 presence 噪音） */
  drain(pred: (env: Envelope) => boolean): void {
    this.envelopes = this.envelopes.filter((env) => !pred(env));
  }

  sendPlain(to: string, type: Envelope["type"], body: unknown): void {
    this.ws.send(JSON.stringify(makeEnvelope(type, this.deviceId, to, 0, JSON.stringify(body))));
  }

  sendSecure(peerId: string, peerPub: string, type: Envelope["type"], body: unknown, seq = 0): void {
    const shared = deriveSharedKey(b64ToU8(peerPub), this.kp.secretKey);
    this.ws.send(JSON.stringify(makeEnvelope(type, this.deviceId, peerId, seq, encryptBody(shared, body))));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.on("close", resolve);
      this.ws.close();
    });
  }
}

/** 走完整 offer/accept/confirm，把配对打到 active；返回 token 等握手产物 */
async function pairUp(bridge: SimDevice, phone: SimDevice): Promise<{ token: string; bridgePub: string; phonePub: string }> {
  const token = `t_${bridge.deviceId.slice(2)}${phone.deviceId.slice(2)}`;
  const bridgePub = u8ToB64(bridge.kp.publicKey);
  const phonePub = u8ToB64(phone.kp.publicKey);

  bridge.sendPlain("relay", T.PairOffer, { token, publicKey: bridgePub, name: bridge.name });
  await bridge.waitFor((e) => e.type === T.PairOfferAck);

  phone.sendPlain("relay", T.PairAccept, { token, publicKey: phonePub, name: phone.name });
  await bridge.waitFor((e) => e.type === T.PairAccept);
  // accept.ack 会同时到手机，消费掉
  await phone.waitFor((e) => e.type === T.PairAcceptAck);

  bridge.sendSecure(phone.deviceId, phonePub, T.PairConfirm, { ok: true, bridgeName: bridge.name } satisfies PairConfirmBody);
  await phone.waitFor((e) => e.type === T.PairConfirm);
  return { token, bridgePub, phonePub };
}

/** 等对端离线 presence 到达（中继确认已摘除在线态的确定性信号） */
async function waitPeerOffline(self: SimDevice, peerId: string): Promise<void> {
  await self.waitFor((e) => e.type === T.PresenceOffline && JSON.parse(e.body).deviceId === peerId);
}

let relay: RelayHandle;
let url: string;
const dir = mkdtempSync(join(tmpdir(), "larkwire-relay-test-"));

before(async () => {
  const port = await freePort();
  relay = startRelay({ host: "127.0.0.1", port, dbPath: join(dir, "relay.db") });
  url = `ws://127.0.0.1:${port}`;
  // 等 listening（直接连一次即可，ws 会在监听后握手）
  await new Promise((r) => setTimeout(r, 200));
});

after(async () => {
  await relay.stop();
});

test("第一层：手机离线时桥发撤销，重连 drain 收到 pair.revoke（≤10 分钟，旧 App 同口径生效）", async () => {
  const bridge = new SimDevice("桥-MacBook");
  const phone = new SimDevice("手机-iPhone");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);
  // presence 噪音清掉（上线互告）
  bridge.drain((e) => e.type === T.PresenceOnline);
  phone.drain((e) => e.type === T.PresenceOnline);

  await phone.close();
  await waitPeerOffline(bridge, phone.deviceId);

  // 桥直接发往手机的撤销（设备路由分支）：手机离线也必须入队
  bridge.sendPlain(phone.deviceId, T.PairRevoke, { targetDeviceId: phone.deviceId } satisfies PairRevokeBody);

  // 手机重连：drain 离线队列
  await phone.connect(url);
  const revoke = await phone.waitFor((e) => e.type === T.PairRevoke);
  const body = JSON.parse(revoke.body) as PairRevokeBody;
  assert.equal(body.targetDeviceId, phone.deviceId);

  await bridge.close();
  await phone.close();
});

test("第二层：pair.status 连接即对账——撤销前列表含对端，撤销后重连列表不含（与离线时长无关）", async () => {
  const bridge = new SimDevice("桥-MacBook2");
  const phone = new SimDevice("手机-iPhone2");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);
  bridge.drain((e) => e.type === T.PresenceOnline);
  phone.drain((e) => e.type === T.PresenceOnline);

  // 撤销前重连手机：pair.status 的 peers 必须含桥
  await phone.close();
  await waitPeerOffline(bridge, phone.deviceId);
  await phone.connect(url);
  const before = await phone.waitFor((e) => e.type === T.PairStatus);
  const beforeBody = JSON.parse(before.body) as PairStatusBody;
  assert.ok(beforeBody.peers.includes(bridge.deviceId), `撤销前 peers 应含桥，实际 ${JSON.stringify(beforeBody.peers)}`);

  // 桌面经 to=relay 的定向撤销（与实际 UI 同路径）。手机此刻在线，撤销帧会立即送达
  bridge.sendPlain("relay", T.PairRevoke, { targetDeviceId: phone.deviceId } satisfies PairRevokeBody);
  // 手机重连 auth.ok 后桥仍在线，中继会先回同步一帧 presence.online（桥的在线态），
  // 再送达撤销；谓词同时限定帧类型与「谁没了」，语义钉死
  const liveRevoke = await phone.waitFor(
    (e) => e.type === T.PairRevoke && e.from === "relay" &&
      (JSON.parse(e.body) as Partial<PairRevokeBody>).targetDeviceId === bridge.deviceId,
  );
  assert.equal((JSON.parse(liveRevoke.body) as PairRevokeBody).targetDeviceId, bridge.deviceId);
  // 配对已删，中继不会再广播 presence.offline（无配对不路由——设计如此）；
  // close 握手完成时服务端关闭事件已处理完，可直接重连，无需 presence 同步
  await phone.close();

  // 模拟超过队列 TTL 后的重连：撤销时手机在线，没有任何入队帧——
  // pair.status 独立于离线队列，是此时唯一（也足够）的对账手段
  await phone.connect(url);
  const after = await phone.waitFor((e) => e.type === T.PairStatus);
  const afterBody = JSON.parse(after.body) as PairStatusBody;
  assert.ok(!afterBody.peers.includes(bridge.deviceId), `撤销后 peers 不应含桥，实际 ${JSON.stringify(afterBody.peers)}`);

  await bridge.close();
  await phone.close();
});

test("反向：手机解绑时桥离线，中继代发撤销入队，桥重连收到 from=relay 的 pair.revoke", async () => {
  const bridge = new SimDevice("桥-MacBook3");
  const phone = new SimDevice("手机-iPhone3");
  await bridge.connect(url);
  await phone.connect(url);
  await pairUp(bridge, phone);
  bridge.drain((e) => e.type === T.PresenceOnline);
  phone.drain((e) => e.type === T.PresenceOnline);

  await bridge.close();
  await waitPeerOffline(phone, bridge.deviceId);

  // 手机解绑只发 to=relay 一封
  phone.sendPlain("relay", T.PairRevoke, { targetDeviceId: bridge.deviceId } satisfies PairRevokeBody);

  await bridge.connect(url);
  const revoke = await bridge.waitFor((e) => e.type === T.PairRevoke && e.from === "relay");
  const body = JSON.parse(revoke.body) as PairRevokeBody;
  assert.equal(body.targetDeviceId, phone.deviceId); // 「谁没了」= 发起解绑的手机
  const status = await bridge.waitFor((e) => e.type === T.PairStatus);
  const statusBody = JSON.parse(status.body) as PairStatusBody;
  assert.ok(!statusBody.peers.includes(phone.deviceId));

  await phone.close();
  await bridge.close();
});
