#!/usr/bin/env node
/**
 * larkwire-relay 入口。环境变量：
 *   LARKWIRE_RELAY_HOST  默认 127.0.0.1（生产走 nginx 反代，不直接暴露）
 *   LARKWIRE_RELAY_PORT  默认 8790
 *   LARKWIRE_RELAY_DB    默认 ~/.larkwire/relay.db
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { startRelay } from "./server.js";

const host = process.env.LARKWIRE_RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.LARKWIRE_RELAY_PORT ?? 8790);
const dbPath = process.env.LARKWIRE_RELAY_DB ?? join(homedir(), ".larkwire", "relay.db");

startRelay({ host, port, dbPath });
