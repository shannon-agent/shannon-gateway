import { describe, expect, it, vi } from "vitest";

import {
  type ApprovalDecision,
  type ApprovalReq,
  type ChannelAdapter,
  type Logger,
  type NormalizedInbound,
  type ReplyTarget,
} from "../../adapters/types.js";
import { type EngineEvent } from "../../engine/types.js";
import { type EngineWsClient } from "../../engine/wsClient.js";
import { createApprovalTurnHandler } from "../approvalTurnHandler.js";
import { type TurnContext } from "../types.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function mockClient(events: EngineEvent[]): EngineWsClient {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runQuery: vi.fn(async function* (): AsyncGenerator<EngineEvent> {
      for (const e of events) yield e;
    }),
  } as unknown as EngineWsClient;
}

interface ApprovalAdapter extends ChannelAdapter {
  sends: Array<{ target: ReplyTarget; text: string }>;
  requestApproval: ReturnType<typeof vi.fn>;
}

function adapterReturning(decision: ApprovalDecision): ApprovalAdapter {
  const sends: ApprovalAdapter["sends"] = [];
  return {
    platform: "slack",
    capabilities: { threading: false, pairing: false, approvalButtons: true, streaming: "none" },
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async (target: ReplyTarget, text: string) => {
      sends.push({ target, text });
      return { messageId: "m" };
    },
    requestApproval: vi.fn(async (_t: ReplyTarget, _req: ApprovalReq): Promise<ApprovalDecision> => decision),
    resolveSessionConversation: (id: string) => ({ baseChatId: id }),
    sends,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as ApprovalAdapter;
}

function ctxFor(adapter: ApprovalAdapter, client: EngineWsClient): TurnContext {
  const inbound: NormalizedInbound = {
    platform: "slack",
    chatId: "C1",
    senderId: "U1",
    senderName: "ed",
    text: "do the thing",
    timestamp: 0,
  };
  return {
    inbound,
    client,
    adapter,
    replyTarget: { platform: "slack", chatId: "C1" },
    logger: noopLogger,
  };
}

const approvalEvent: EngineEvent = {
  type: "approval_request",
  request_id: "req-9",
  tool_name: "shell",
  tool_input: { cmd: "ls" },
  description: "run ls",
  is_destructive: false,
  diff_preview: null,
};

describe("createApprovalTurnHandler", () => {
  it("renders the request, posts allow_once, and sends the reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const adapter = adapterReturning({ requestId: "req-9", choice: "allow" });
    const handler = createApprovalTurnHandler({
      engineBaseUrl: "http://e",
      fetchImpl,
    });

    await handler.handle(
      ctxFor(adapter, mockClient([approvalEvent, { type: "text", content: "done" }, { type: "completed", model: "gpt" }])),
    );

    // Adapter saw the camelCase-mapped ApprovalReq.
    const passedReq = adapter.requestApproval.mock.calls[0]![1] as ApprovalReq;
    expect(passedReq).toEqual({
      requestId: "req-9",
      toolName: "shell",
      toolInput: { cmd: "ls" },
      description: "run ls",
      isDestructive: false,
      diffPreview: null,
    });

    // Engine posted allow_once for the allow decision.
    const posted = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(posted).toEqual({ request_id: "req-9", choice: "allow_once" });

    // Turn continued after the approval and delivered the text reply.
    expect(adapter.sends[0]?.text).toBe("done");
  });

  it("posts deny when the user denies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const adapter = adapterReturning({ requestId: "req-9", choice: "deny" });
    const handler = createApprovalTurnHandler({ engineBaseUrl: "http://e", fetchImpl });

    await handler.handle(
      ctxFor(adapter, mockClient([approvalEvent, { type: "text", content: "ok" }, { type: "completed", model: "gpt" }])),
    );
    const posted = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(posted).toEqual({ request_id: "req-9", choice: "deny" });
  });

  it("survives a failed approval POST (logs, still sends reply)", async () => {
    const warnings: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));
    const adapter = adapterReturning({ requestId: "req-9", choice: "allow" });
    const handler = createApprovalTurnHandler({ engineBaseUrl: "http://e", fetchImpl });

    const ctx = ctxFor(adapter, mockClient([approvalEvent, { type: "text", content: "after" }, { type: "completed", model: "gpt" }]));
    ctx.logger = { ...noopLogger, warn: (m: string) => warnings.push(m) };

    await handler.handle(ctx);

    expect(warnings.some((w) => w.includes("approval respond failed"))).toBe(true);
    expect(adapter.sends[0]?.text).toBe("after");
  });
});
