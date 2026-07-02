import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createConsoleLogger } from "../../logger.js";
import {
  JSONRPC_VERSION,
  ShannonError,
  type ShannonEvent,
} from "../protocol.js";
import { MobileServer, type MethodHandlers } from "../server.js";

/**
 * P1.1a acceptance: routing dispatch is covered and a real WS client handshake
 * succeeds against mock handlers. Engine bridging (query→engine) is P1.1b; here
 * the `shannon/query` handler emits a canned event stream so the *plumbing*
 * (NDJSON parse → dispatch → notifications → terminal response) is exercised.
 */
const logger = createConsoleLogger("error"); // quiet on the console during tests

function nextId(): number {
  return Math.floor(Math.random() * 1e9);
}

/** Send one JSON-RPC request over the socket and collect the reply. */
function rpc(socket: WebSocket, method: string, params?: unknown): Promise<any> {
  const id = nextId();
  const frame = JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params });
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      const msg = JSON.parse(String(data)) as { id?: number };
      if (msg.id === id) {
        socket.off("message", onMessage);
        resolve(msg);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", reject);
    socket.send(frame);
  });
}

/** Collect all shannon/event notifications + the terminal response for an id. */
async function rpcStream(
  socket: WebSocket,
  method: string,
  params: unknown,
): Promise<{ events: ShannonEvent[]; response: any }> {
  const id = nextId();
  const events: ShannonEvent[] = [];
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      const msg = JSON.parse(String(data));
      if (msg.method === "shannon/event") {
        events.push(msg.params as ShannonEvent);
        return;
      }
      if (msg.id === id) {
        socket.off("message", onMessage);
        resolve({ events, response: msg });
      }
    };
    socket.on("message", onMessage);
    socket.on("error", reject);
    socket.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params }));
  });
}

describe("MobileServer (P1.1a)", () => {
  let handle: { port: number; stop: () => Promise<void> } | null = null;

  async function start(handlers: MethodHandlers): Promise<{ port: number; stop: () => Promise<void> }> {
    const server = new MobileServer({ host: "127.0.0.1", port: 0, logger, handlers });
    handle = await server.start();
    return handle;
  }

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  it("binds a free port and accepts a client handshake", async () => {
    const { port, stop } = await start({
      "shannon/health": async () => ({ kind: "result", result: { gateway: "ok", engine: "ok", version: "test" } }),
    });
    const socket = await connect(port);
    const res = await rpc(socket, "shannon/health");
    expect(res.result).toEqual({ gateway: "ok", engine: "ok", version: "test" });
    socket.close();
    await stop();
  });

  it("routes each method to its handler (dispatch works)", async () => {
    let seen = "";
    const { port, stop } = await start({
      "shannon/health": async () => ({ kind: "result", result: { gateway: "ok", engine: "ok", version: "test" } }),
      "shannon/model.list": async () => ({ kind: "result", result: { models: [], current: null } }),
      "shannon/agent.list": async (_p, ctx) => {
        seen = ctx.sessionId ?? "<null>";
        return { kind: "result", result: { agents: [] } };
      },
    });
    const socket = await connect(port);
    const [health, models, agents] = await Promise.all([
      rpc(socket, "shannon/health"),
      rpc(socket, "shannon/model.list"),
      rpc(socket, "shannon/agent.list"),
    ]);
    expect(health.result.gateway).toBe("ok");
    expect(models.result.models).toEqual([]);
    expect(agents.result.agents).toEqual([]);
    expect(seen).toBe("<null>"); // P1.1: no pairing yet
    socket.close();
    await stop();
  });

  it("streams notifications then a terminal response for stream outcomes", async () => {
    const canned: ShannonEvent[] = [
      { type: "query.started", turn_id: "t1" },
      { type: "task.progress", content: "Hel" },
      { type: "task.progress", content: "lo" },
      { type: "query.completed", model: "test-model" },
    ];
    const { port, stop } = await start({
      "shannon/query": async () => ({
        kind: "stream",
        stream: (async function* (): AsyncGenerator<ShannonEvent> {
          for (const ev of canned) yield ev;
        })(),
        result: { ok: true },
      }),
    });
    const socket = await connect(port);
    const { events, response } = await rpcStream(socket, "shannon/query", { prompt: "hi" });
    expect(events.map((e) => e.type)).toEqual([
      "query.started",
      "task.progress",
      "task.progress",
      "query.completed",
    ]);
    expect(response.result).toEqual({ ok: true });
    socket.close();
    await stop();
  });

  it("returns method-not-found for an unknown method", async () => {
    const { port, stop } = await start({});
    const socket = await connect(port);
    const res = await rpc(socket, "shannon/nope");
    expect(res.error?.code).toBe(ShannonError.METHOD_NOT_FOUND);
    socket.close();
    await stop();
  });

  it("returns invalid-request for a frame missing jsonrpc/id/method", async () => {
    const { port, stop } = await start({});
    const socket = await connect(port);
    const res = await new Promise<any>((resolve) => {
      socket.on("message", (d) => resolve(JSON.parse(String(d))));
      socket.send(JSON.stringify({ hello: "world" }));
    });
    expect(res.error?.code).toBe(ShannonError.INVALID_REQUEST);
    socket.close();
    await stop();
  });

  it("reports a parse error for malformed JSON and survives it", async () => {
    let healthHit = false;
    const { port, stop } = await start({
      "shannon/health": async () => {
        healthHit = true;
        return { kind: "result", result: { gateway: "ok", engine: "ok", version: "test" } };
      },
    });
    const socket = await connect(port);
    const parseErr = await new Promise<any>((resolve) => {
      socket.on("message", (d) => {
        const msg = JSON.parse(String(d));
        if (msg.error?.code === ShannonError.PARSE_ERROR) resolve(msg);
      });
      socket.send("{not json");
    });
    expect(parseErr).toBeTruthy();
    // The connection is still usable.
    const health = await rpc(socket, "shannon/health");
    expect(healthHit).toBe(true);
    expect(health.result.gateway).toBe("ok");
    socket.close();
    await stop();
  });

  it("rejects the connection when the authenticator returns false", async () => {
    const server = new MobileServer({
      host: "127.0.0.1",
      port: 0,
      logger,
      handlers: { "shannon/health": async () => ({ kind: "result", result: { ok: true } }) },
      authenticator: () => false,
    });
    const h = await server.start();
    const closed = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/`);
      socket.on("close", (code) => resolve(code));
    });
    expect(closed).toBe(4001);
    await h.stop();
  });
});
