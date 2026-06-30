import { afterEach, describe, expect, it } from "vitest";
import { type AddressInfo, WebSocketServer, type WebSocket } from "ws";

import { EngineWsClient } from "../wsClient.js";
import { type EngineEvent } from "../types.js";

/**
 * The client is exercised against a real `ws` server speaking the engine's
 * `{ "type": "..." }` protocol — the same wire shape `api_server.rs` emits.
 * No LLM, no network egress.
 */

interface MockServer {
  url: string;
  close: () => Promise<void>;
}

const openServers: MockServer[] = [];

async function startMockServer(
  handler: (ws: WebSocket) => void,
): Promise<MockServer> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  server.on("connection", handler);
  const addr = server.address() as AddressInfo;
  const mock: MockServer = {
    url: `ws://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
  openServers.push(mock);
  return mock;
}

afterEach(async () => {
  while (openServers.length > 0) {
    const s = openServers.pop();
    if (s) await s.close();
  }
});

function send(ws: WebSocket, frame: object): void {
  ws.send(JSON.stringify(frame));
}

function onQuery(ws: WebSocket, cb: () => void): void {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString("utf8"));
    if (msg?.type === "query") cb();
  });
}

describe("EngineWsClient", () => {
  it("yields text → usage → completed then ends", async () => {
    const server = await startMockServer((ws) => {
      onQuery(ws, () => {
        send(ws, { type: "text", content: "Hello" });
        send(ws, {
          type: "usage",
          input_tokens: 5,
          output_tokens: 3,
          cost_usd: 0.0001,
        });
        send(ws, { type: "completed", model: "gpt-test" });
      });
    });

    const client = new EngineWsClient({ url: server.url });
    await client.connect();
    const events: EngineEvent[] = [];
    for await (const ev of client.runQuery("hi")) events.push(ev);

    expect(events.map((e) => e.type)).toEqual([
      "text",
      "usage",
      "completed",
    ]);
    const last = events[2];
    expect(last && last.type === "completed" && last.model).toBe("gpt-test");

    await client.close();
  });

  it("yields failed and ends", async () => {
    const server = await startMockServer((ws) => {
      onQuery(ws, () => send(ws, { type: "failed", error: "boom" }));
    });

    const client = new EngineWsClient({ url: server.url });
    await client.connect();
    const types: string[] = [];
    for await (const ev of client.runQuery("hi")) types.push(ev.type);

    expect(types).toEqual(["failed"]);
    await client.close();
  });

  it("cancel() sends a cancel frame and yields cancelled", async () => {
    const server = await startMockServer((ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "query") {
          send(ws, { type: "text", content: "partial" });
        } else if (msg?.type === "cancel") {
          send(ws, { type: "cancelled" });
        }
      });
    });

    const client = new EngineWsClient({ url: server.url });
    await client.connect();
    const types: string[] = [];
    for await (const ev of client.runQuery("hi")) {
      types.push(ev.type);
      if (ev.type === "text") client.cancel();
    }

    expect(types).toEqual(["text", "cancelled"]);
    await client.close();
  });

  it("runQuery throws if not connected", async () => {
    const client = new EngineWsClient({ url: "ws://127.0.0.1:1" });
    await expect(async () => {
      for await (const _ of client.runQuery("hi")) {
        void _;
      }
    }).rejects.toThrow(/not connected/);
  });

  it("rejects a second concurrent query on the same client", async () => {
    const server = await startMockServer(() => {
      // Never reply — keeps the first query pending.
    });

    const client = new EngineWsClient({ url: server.url });
    await client.connect();
    const firstIter = client.runQuery("first");
    // Starts the generator body: sends the query frame, then awaits a frame.
    const firstNext = firstIter.next().catch(() => {});
    await new Promise((r) => setImmediate(r));

    const secondIter = client.runQuery("second");
    await expect(secondIter.next()).rejects.toThrow(/already in flight/);

    await client.close();
    await firstNext;
  });

  it("connect() is idempotent", async () => {
    const server = await startMockServer(() => {
      /* unused */
    });
    const client = new EngineWsClient({ url: server.url });
    await client.connect();
    await client.connect();
    expect(client.isConnected).toBe(true);
    await client.close();
  });
});
