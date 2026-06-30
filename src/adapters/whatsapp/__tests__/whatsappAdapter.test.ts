import { describe, expect, it } from "vitest";

import { type Logger } from "../../types.js";
import { type AdapterConfig } from "../../../config/types.js";
import { assertAdapterContract } from "../../contract.js";
import {
  buildApprovalInteractive,
  buildSendRequest,
  createWhatsAppAdapter,
  extractInbound,
  formatApprovalPrompt,
  parseApprovalButton,
  verifyHubSignature,
  verifySubscription,
} from "../whatsappAdapter.js";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function webhookBody(over: Record<string, unknown> = {}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PNID" },
              contacts: [{ wa_id: "16315551000", profile: { name: "Ed" } }],
              messages: [
                {
                  from: "16315551000",
                  id: "wamid.1",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "hello" },
                },
              ],
            },
          },
        ],
      },
    ],
    ...over,
  };
}

describe("extractInbound", () => {
  it("normalizes a text message with contact name", () => {
    const { messages, buttonReplies } = extractInbound(webhookBody());
    expect(buttonReplies).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      platform: "whatsapp",
      chatId: "16315551000",
      senderId: "16315551000",
      senderName: "Ed",
      text: "hello",
      isDirect: true,
      threadId: "wamid.1",
    });
    expect(messages[0]?.timestamp).toBe(1700000000 * 1000);
  });

  it("extracts button replies separately from text messages", () => {
    const body = webhookBody({});
    (body as { entry: unknown[] }).entry[0] = {
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            contacts: [{ wa_id: "1", profile: { name: "X" } }],
            messages: [
              {
                from: "1",
                id: "wamid.b",
                type: "interactive",
                interactive: { type: "button_reply", button_reply: { id: "allow:r9", title: "Allow" } },
              },
            ],
          },
        },
      ],
    };
    const { messages, buttonReplies } = extractInbound(body);
    expect(messages).toHaveLength(0);
    expect(buttonReplies).toEqual([{ buttonId: "allow:r9", from: "1" }]);
  });

  it("falls back to phone number when no contact name", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "555", id: "m1", timestamp: "1", type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    };
    const { messages } = extractInbound(body);
    expect(messages[0]?.senderName).toBe("555");
  });

  it("returns empty for malformed input", () => {
    expect(extractInbound(null)).toEqual({ messages: [], buttonReplies: [] });
    expect(extractInbound({})).toEqual({ messages: [], buttonReplies: [] });
  });
});

describe("buildSendRequest", () => {
  const base = {
    apiBase: "https://graph.facebook.com",
    version: "v20.0",
    phoneNumberId: "PNID",
    accessToken: "TOK",
    to: "16315551000",
    body: "hi",
  };

  it("builds a text message POST", () => {
    const req = buildSendRequest(base);
    expect(req.url).toBe("https://graph.facebook.com/v20.0/PNID/messages");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer TOK");
    expect(JSON.parse(req.body)).toEqual({
      messaging_product: "whatsapp",
      to: "16315551000",
      type: "text",
      text: { body: "hi" },
    });
  });

  it("switches to interactive payload when provided", () => {
    const req = buildSendRequest({ ...base, interactive: { type: "button" } });
    expect(JSON.parse(req.body)).toMatchObject({ type: "interactive", interactive: { type: "button" } });
  });
});

describe("approval helpers", () => {
  it("formatApprovalPrompt tags destructive", () => {
    const p = formatApprovalPrompt({
      requestId: "r1",
      toolName: "shell",
      toolInput: {},
      description: "rm -rf",
      isDestructive: true,
      diffPreview: null,
    });
    expect(p).toContain("DESTRUCTIVE");
    expect(p).toContain("shell");
  });

  it("buildApprovalInteractive encodes choice + id in button reply ids", () => {
    const ix = buildApprovalInteractive("req-9", "prompt");
    const buttons = (ix.action.buttons as Array<{ reply: { id: string } }>);
    expect(buttons.map((b) => b.reply.id).sort()).toEqual(["allow:req-9", "deny:req-9"]);
    expect(ix.type).toBe("button");
    expect(ix.body.text).toBe("prompt");
  });

  it("parseApprovalButton round-trips and rejects junk", () => {
    expect(parseApprovalButton("allow:req-9")).toEqual({ choice: "allow", requestId: "req-9" });
    expect(parseApprovalButton("deny:req-9")).toEqual({ choice: "deny", requestId: "req-9" });
    expect(parseApprovalButton("bogus")).toBeNull();
    expect(parseApprovalButton("allow:")).toBeNull();
  });
});

describe("verifyHubSignature", () => {
  it("accepts a correct HMAC and rejects a bad one", () => {
    const secret = "appsecret";
    const body = JSON.stringify({ hello: "world" });
    // compute a real hmac to compare against
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHubSignature(body, good, secret)).toBe(true);
    expect(verifyHubSignature(body, "sha256=deadbeef", secret)).toBe(false);
    expect(verifyHubSignature(body, "notprefixed", secret)).toBe(false);
  });
});

describe("verifySubscription", () => {
  it("returns the challenge on a matching subscribe", () => {
    expect(
      verifySubscription(
        { "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "CH-123" },
        "tok",
      ),
    ).toBe("CH-123");
  });

  it("returns null on a token mismatch", () => {
    expect(
      verifySubscription(
        { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "CH" },
        "tok",
      ),
    ).toBeNull();
  });
});

describe("createWhatsAppAdapter contract", () => {
  it("passes assertAdapterContract", () => {
    const cfg: AdapterConfig = {
      platform: "whatsapp",
      enabled: true,
      options: { phoneNumberId: "PNID", verifyToken: "tok" },
    };
    const adapter = createWhatsAppAdapter(cfg, { logger: noopLogger, getSecret: async () => null });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    expect(adapter.platform).toBe("whatsapp");
    expect(adapter.capabilities.threading).toBe(false);
    expect(adapter.capabilities.approvalButtons).toBe(true);
    expect(adapter.capabilities.streaming).toBe("none");
  });

  it("fails fast when phoneNumberId is missing", () => {
    expect(() =>
      createWhatsAppAdapter(
        { platform: "whatsapp", enabled: true, options: { verifyToken: "tok" } },
        { logger: noopLogger, getSecret: async () => null },
      ),
    ).toThrow(/phoneNumberId/);
  });

  it("fails fast when verifyToken is missing", () => {
    expect(() =>
      createWhatsAppAdapter(
        { platform: "whatsapp", enabled: true, options: { phoneNumberId: "PNID" } },
        { logger: noopLogger, getSecret: async () => null },
      ),
    ).toThrow(/verifyToken/);
  });
});
