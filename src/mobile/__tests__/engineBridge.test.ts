import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createConsoleLogger } from "../../logger.js";
import type { EngineEvent } from "../../engine/types.js";
import { ShannonError, type ShannonEvent } from "../protocol.js";
import { MobileServer, type MethodHandlers } from "../server.js";
import { createEngineHandlers, mapEngineEvent, type EngineClient } from "../engineBridge.js";

/**
 * P1.1b acceptance: the engine bridge wires `shannon/*` to a mock engine through
 * a real MobileServer + real WS client. `mapEngineEvent` (the engine→mobile
 * semantics) is covered as a pure table; the rest exercise the full
 * NDJSON → dispatch → handler → engine → notification → response path.
 */
const logger = createConsoleLogger("error");

let servers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
  servers = [];
});

async function start(handlers: MethodHandlers): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = new MobileServer({ host: "127.0.0.1", port: 0, logger, handlers });
  const handle = await server.start();
  servers.push(handle);
  return handle;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

let rpcId = 0;
function rpc(socket: WebSocket, method: string, params?: unknown): Promise<any> {
  const id = ++rpcId;
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
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

/** Send a request and collect every `shannon/event` notification + the terminal response. */
function rpcStream(socket: WebSocket, method: string, params: unknown): {
  events: ShannonEvent[];
  response: Promise<any>;
} {
  const id = ++rpcId;
  const events: ShannonEvent[] = [];
  const response = new Promise<any>((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      const msg = JSON.parse(String(data));
      if (msg.method === "shannon/event") {
        events.push(msg.params as ShannonEvent);
        return;
      }
      if (msg.id === id) {
        socket.off("message", onMessage);
        resolve(msg);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", reject);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  return { events, response };
}

// ── mock engine ─────────────────────────────────────────────────────────────

interface FakeEngineOpts {
  script: EngineEvent[];
  /** Block inside runQuery until `cancel()` fires, then emit `cancelled`. */
  awaitCancel?: boolean;
  /** Force connect() to throw (engine down). */
  connectFails?: boolean;
}

class FakeEngine implements EngineClient {
  private readonly opts: FakeEngineOpts;
  cancelled = false;
  private cancelResolver: (() => void) | null = null;
  lastPrompt: string | null = null;
  lastModel: string | null = null;
  lastSessionId: string | null = null;

  constructor(opts: FakeEngineOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.opts.connectFails) throw new Error("engine socket refused");
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelResolver?.();
  }

  async close(): Promise<void> {}

  async *runQuery(
    prompt: string,
    o?: { model?: string | null; sessionId?: string | null },
  ): AsyncGenerator<EngineEvent> {
    this.lastPrompt = prompt;
    this.lastModel = o?.model ?? null;
    this.lastSessionId = o?.sessionId ?? null;
    for (const ev of this.opts.script) yield ev;
    if (this.opts.awaitCancel) {
      if (!this.cancelled) {
        await new Promise<void>((r) => {
          this.cancelResolver = r;
        });
      }
      yield { type: "cancelled" };
    }
  }
}

/** A factory that records the most-recent engine so a test can drive/cancel it. */
function fakeFactory(holder: { current: FakeEngine | null }, opts: FakeEngineOpts) {
  return () => {
    const f = new FakeEngine(opts);
    holder.current = f;
    return f;
  };
}

function mockResponse(status: number, body = ""): Response {
  return { status, ok: status >= 200 && status < 300, text: async () => body } as unknown as Response;
}

// ── mapEngineEvent (pure unit) ──────────────────────────────────────────────

describe("mapEngineEvent", () => {
  it("maps text → task.progress(content)", () => {
    expect(mapEngineEvent({ type: "text", content: "hi" })).toEqual({
      type: "task.progress",
      content: "hi",
    });
  });

  it("maps tool_use / tool_result → task.progress(tool)", () => {
    expect(mapEngineEvent({ type: "tool_use", name: "bash", input: { cmd: "ls" } })).toEqual({
      type: "task.progress",
      tool: { kind: "use", name: "bash", input: { cmd: "ls" } },
    });
    expect(mapEngineEvent({ type: "tool_result", name: "bash", output: "ok" })).toEqual({
      type: "task.progress",
      tool: { kind: "result", name: "bash", output: "ok" } as never,
    });
  });

  it("maps usage → task.progress(usage)", () => {
    expect(
      mapEngineEvent({ type: "usage", input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }),
    ).toEqual({
      type: "task.progress",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
    });
  });

  it("maps terminal events", () => {
    expect(mapEngineEvent({ type: "completed", model: "gpt-x" })).toEqual({
      type: "query.completed",
      model: "gpt-x",
    });
    expect(mapEngineEvent({ type: "failed", error: "boom" })).toEqual({
      type: "query.failed",
      error: "boom",
    });
    expect(mapEngineEvent({ type: "cancelled" })).toEqual({ type: "query.cancelled" });
    expect(mapEngineEvent({ type: "error", message: "oops" })).toEqual({
      type: "query.failed",
      error: "oops",
    });
  });

  it("maps approval_request → approval.request with all fields", () => {
    const ev = {
      type: "approval_request",
      request_id: "r1",
      tool_name: "write_file",
      tool_input: { path: "/x" },
      description: "write /x",
      is_destructive: true,
      diff_preview: "--- a\n+++ b\n",
    } as const;
    expect(mapEngineEvent(ev)).toEqual({ ...ev, type: "approval.request" });
  });

  it("drops session_info (metadata-only) → null", () => {
    expect(mapEngineEvent({ type: "session_info", message_count: 3, model: "gpt-x" })).toBeNull();
  });
});

// ── bridge through a real MobileServer ──────────────────────────────────────

describe("createEngineHandlers (P1.1b)", () => {
  it("streams query.started + mapped events + terminal {ok:true}", async () => {
    const holder = { current: null as FakeEngine | null };
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://127.0.0.1:9",
      version: "test",
      logger,
      engineClientFactory: fakeFactory(holder, {
        script: [
          { type: "text", content: "Hel" },
          { type: "text", content: "lo" },
          { type: "usage", input_tokens: 1, output_tokens: 2, cost_usd: 0 },
          { type: "completed", model: "gpt-x" },
        ],
      }),
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const { events, response } = rpcStream(socket, "shannon/query", { prompt: "hi", model: "gpt-x" });
    const res = await response;
    expect(res.result).toEqual({ ok: true });
    expect(events.map((e) => e.type)).toEqual([
      "query.started",
      "task.progress",
      "task.progress",
      "task.progress",
      "query.completed",
    ]);
    expect((events[0] as { turn_id: string }).turn_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((events[1] as { content: string }).content).toBe("Hel");
    expect(holder.current?.lastPrompt).toBe("hi");
    expect(holder.current?.lastModel).toBe("gpt-x");
    socket.close();
  });

  it("rejects query without a prompt with BAD_PARAMS", async () => {
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://127.0.0.1:9",
      version: "test",
      logger,
      engineClientFactory: fakeFactory({ current: null }, { script: [] }),
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const res = await rpc(socket, "shannon/query", {});
    expect(res.error?.code).toBe(ShannonError.BAD_PARAMS);
    socket.close();
  });

  it("cancel interrupts the in-flight query and emits query.cancelled", async () => {
    const holder = { current: null as FakeEngine | null };
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://127.0.0.1:9",
      version: "test",
      logger,
      engineClientFactory: fakeFactory(holder, {
        script: [{ type: "text", content: "partial" }],
        awaitCancel: true,
      }),
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const { events, response } = rpcStream(socket, "shannon/query", { prompt: "x" });

    // Wait until the turn has started (client is registered), then cancel.
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    const cancelRes = await rpc(socket, "shannon/cancel", {});
    const res = await response;

    expect(cancelRes.result).toEqual({ ok: true });
    expect(holder.current?.cancelled).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["query.started", "task.progress", "query.cancelled"]);
    expect(res.result).toEqual({ ok: true });
    socket.close();
  });

  it("approval/decide POSTs allow→allow_once and returns ok", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => mockResponse(200, ""));
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://engine:33420",
      version: "test",
      logger,
      engineClientFactory: fakeFactory({ current: null }, { script: [] }),
      fetchImpl: fetchMock,
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const res = await rpc(socket, "shannon/approval/decide", {
      request_id: "r1",
      choice: "allow",
      signature: "sig",
    });
    expect(res.result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://engine:33420/api/approval/respond");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      request_id: "r1",
      choice: "allow_once",
    });
    socket.close();
  });

  it("health reports engine up on 2xx and down on connection failure", async () => {
    const up = vi.fn<typeof fetch>(async () => mockResponse(200, ""));
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://engine:33420",
      version: "test",
      logger,
      engineClientFactory: fakeFactory({ current: null }, { script: [] }),
      fetchImpl: up,
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const okRes = await rpc(socket, "shannon/health");
    expect(okRes.result).toEqual({ gateway: "ok", engine: "ok", version: "test" });

    // Switch the fetch to a refusing one and re-probe.
    up.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const downRes = await rpc(socket, "shannon/health");
    expect(downRes.result.engine).toBe("down");
    expect(downRes.result.gateway).toBe("ok");
    socket.close();
  });

  it("model.switch overrides model.list", async () => {
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://engine:33420",
      defaultModel: "default-m",
      version: "test",
      logger,
      engineClientFactory: fakeFactory({ current: null }, { script: [] }),
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const before = await rpc(socket, "shannon/model.list");
    expect(before.result).toEqual({ models: [{ id: "default-m" }], current: "default-m" });

    const sw = await rpc(socket, "shannon/model.switch", { model: "big-m" });
    expect(sw.result).toEqual({ ok: true });

    const after = await rpc(socket, "shannon/model.list");
    expect(after.result).toEqual({ models: [{ id: "big-m" }], current: "big-m" });
    socket.close();
  });

  it("pair / agent.detail return NOT_IMPLEMENTED", async () => {
    const handlers = createEngineHandlers({
      engineWsUrl: "ws://127.0.0.1:9",
      engineHttpBaseUrl: "http://engine:33420",
      version: "test",
      logger,
      engineClientFactory: fakeFactory({ current: null }, { script: [] }),
    });
    const { port } = await start(handlers);
    const socket = await connect(port);
    const pair = await rpc(socket, "shannon/pair");
    expect(pair.error?.code).toBe(ShannonError.NOT_IMPLEMENTED);
    const detail = await rpc(socket, "shannon/agent.detail", { session_id: "s1" });
    expect(detail.error?.code).toBe(ShannonError.NOT_IMPLEMENTED);
    socket.close();
  });
});
