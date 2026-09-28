/**
 * SQLite 存储（node:sqlite 内置，零原生依赖——架构 §1 原定 better-sqlite3，
 * 改内置模块的理由：自托管 npm i 不触发 node-gyp 编译，安装门槛更低，同为嵌入式免运维）。
 * 五张表：devices / pairings / offline_queue / meter_daily / push_tokens（M3 推送）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DeviceRow {
  device_id: string;
  public_key: string;
  name: string | null;
  created_at: number;
  last_seen: number;
}

export class RelayDb {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        name TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        bridge_id TEXT NOT NULL,
        phone_id TEXT NOT NULL,
        status TEXT NOT NULL,           -- pending | active
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bridge_id, phone_id)
      );
      CREATE TABLE IF NOT EXISTS offline_queue (
        device_id TEXT NOT NULL,        -- 收件人
        envelope TEXT NOT NULL,         -- 信封 JSON 原文
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queue_device ON offline_queue(device_id, created_at);
      CREATE TABLE IF NOT EXISTS meter_daily (
        day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
        device_id TEXT NOT NULL,        -- 发送方
        bytes_out INTEGER NOT NULL DEFAULT 0,
        msgs_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, device_id)
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        device_id TEXT PRIMARY KEY,     -- App 设备（个推 cid 会过期重发，upsert 覆盖）
        token TEXT NOT NULL,            -- 个推 cid
        platform TEXT NOT NULL,         -- ios | android
        updated_at INTEGER NOT NULL
      );
    `);
  }

  upsertDevice(deviceId: string, publicKey: string, name: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO devices (device_id, public_key, name, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET public_key=excluded.public_key,
           name=COALESCE(excluded.name, devices.name), last_seen=excluded.last_seen`,
      )
      .run(deviceId, publicKey, name, now, now);
  }

  getDevice(deviceId: string): DeviceRow | undefined {
    return this.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(deviceId) as
      | DeviceRow
      | undefined;
  }

  deleteDevice(deviceId: string): void {
    this.db.prepare(`DELETE FROM devices WHERE device_id = ?`).run(deviceId);
    this.db.prepare(`DELETE FROM pairings WHERE bridge_id = ? OR phone_id = ?`).run(deviceId, deviceId);
    this.db.prepare(`DELETE FROM offline_queue WHERE device_id = ?`).run(deviceId);
    this.db.prepare(`DELETE FROM push_tokens WHERE device_id = ?`).run(deviceId);
  }

  /** 推送 token 登记（M3）：App 拿到个推 cid 后随时上报，覆盖旧值（cid 会过期轮换） */
  upsertPushToken(deviceId: string, token: string, platform: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO push_tokens (device_id, token, platform, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET token=excluded.token,
           platform=excluded.platform, updated_at=excluded.updated_at`,
      )
      .run(deviceId, token, platform, now);
  }

  getPushToken(deviceId: string): { token: string; platform: string } | undefined {
    return this.db.prepare(`SELECT token, platform FROM push_tokens WHERE device_id = ?`).get(deviceId) as
      | { token: string; platform: string }
      | undefined;
  }

  /** 配对建立（pair.accept 时 pending，pair.confirm 时 active） */
  upsertPairing(bridgeId: string, phoneId: string, status: "pending" | "active", now: number): void {
    this.db
      .prepare(
        `INSERT INTO pairings (bridge_id, phone_id, status, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(bridge_id, phone_id) DO UPDATE SET status=excluded.status`,
      )
      .run(bridgeId, phoneId, status, now);
  }

  deletePairing(a: string, b: string): void {
    this.db
      .prepare(`DELETE FROM pairings WHERE (bridge_id = ? AND phone_id = ?) OR (bridge_id = ? AND phone_id = ?)`)
      .run(a, b, b, a);
  }

  /** 两设备间是否有 active 配对（双向可查） */
  isPaired(a: string, b: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM pairings
         WHERE status = 'active' AND ((bridge_id = ? AND phone_id = ?) OR (bridge_id = ? AND phone_id = ?)) LIMIT 1`,
      )
      .get(a, b, b, a);
    return row !== undefined;
  }

  /** 两设备间是否存在配对链路（pending 或 active——pair.confirm/error 路由放行用） */
  isLinked(a: string, b: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM pairings
         WHERE ((bridge_id = ? AND phone_id = ?) OR (bridge_id = ? AND phone_id = ?)) LIMIT 1`,
      )
      .get(a, b, b, a);
    return row !== undefined;
  }

  /** 某设备的所有 active 对端（presence 广播用） */
  peersOf(deviceId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT bridge_id, phone_id FROM pairings
         WHERE status = 'active' AND (bridge_id = ? OR phone_id = ?)`,
      )
      .all(deviceId, deviceId) as unknown as { bridge_id: string; phone_id: string }[];
    return rows.map((r) => (r.bridge_id === deviceId ? r.phone_id : r.bridge_id));
  }

  enqueueOffline(deviceId: string, envelopeJson: string, now: number, max: number, ttlMs: number): void {
    // 先清过期，再卡上限（先到先丢老的）
    this.db.prepare(`DELETE FROM offline_queue WHERE created_at < ?`).run(now - ttlMs);
    this.db
      .prepare(
        `DELETE FROM offline_queue WHERE device_id = ? AND rowid NOT IN
           (SELECT rowid FROM offline_queue WHERE device_id = ? ORDER BY rowid DESC LIMIT ?)`,
      )
      .run(deviceId, deviceId, max - 1);
    this.db.prepare(`INSERT INTO offline_queue (device_id, envelope, created_at) VALUES (?, ?, ?)`).run(deviceId, envelopeJson, now);
  }

  drainOffline(deviceId: string, now: number, ttlMs: number): string[] {
    this.db.prepare(`DELETE FROM offline_queue WHERE created_at < ?`).run(now - ttlMs);
    const rows = this.db
      .prepare(`SELECT rowid, envelope FROM offline_queue WHERE device_id = ? ORDER BY rowid ASC`)
      .all(deviceId) as unknown as { rowid: number; envelope: string }[];
    if (rows.length > 0) this.db.prepare(`DELETE FROM offline_queue WHERE device_id = ?`).run(deviceId);
    return rows.map((r) => r.envelope);
  }

  meter(deviceId: string, bytes: number, now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO meter_daily (day, device_id, bytes_out, msgs_out) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, device_id) DO UPDATE SET bytes_out = bytes_out + excluded.bytes_out,
           msgs_out = msgs_out + 1`,
      )
      .run(day, deviceId, bytes);
  }

  meterOf(deviceId: string, day: string): { bytes_out: number; msgs_out: number } {
    const row = this.db
      .prepare(`SELECT bytes_out, msgs_out FROM meter_daily WHERE day = ? AND device_id = ?`)
      .get(day, deviceId) as { bytes_out: number; msgs_out: number } | undefined;
    return row ?? { bytes_out: 0, msgs_out: 0 };
  }

  close(): void {
    this.db.close();
  }
}
