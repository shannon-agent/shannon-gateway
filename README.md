# shannon-gateway

Node/TypeScript gateway that connects chat platforms to the
[Shannon](https://github.com/shannon-agent) engine's built-in `api_server`.

**Target platforms:** Slack · Telegram · Discord · Matrix · WhatsApp ·
WeCom (企业微信) · Feishu (飞书) · DingTalk (钉钉).

The gateway is the **inbound entry point**: platform messages flow in through
transport adapters, are normalized and routed per-conversation, and dispatched
to the engine over its existing WebSocket API. Tool calls that need human
approval are rendered as in-channel buttons; the decision is posted back to the
engine. The engine remains the single source of truth for conversation history,
memory, and compaction — the gateway only owns transport, routing, and
channel UX.

## Architecture (four layers)

1. **Transport adapters** (`src/adapters/`) — one per platform, implementing
   `ChannelAdapter`. Produce `NormalizedInbound`; consume `ReplyTarget`.
2. **Normalizer** — platform-native event → unified envelope (lives inside each
   adapter).
3. **Session router** (`src/router/`) — `sessionKey` → engine session; a
   per-session lane queue (serial within a conversation, parallel across
   conversations — F5).
4. **Engine client + approval** (`src/engine/`) — WebSocket to `/api/ws`;
   renders `approval_request` frames as in-channel buttons, POSTs the decision
   to `/api/approval/respond`.

`src/bootstrap.ts` wires the four layers from a config file;
`src/index.ts` is the runnable entry. See
`claudedocs/social-connection-architecture.md` in `shannon-desktop` for the full
design and decision record.

## Quick start

Requires Node 20+ and pnpm 10+.

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm dev         # tsx src/index.ts  (or: pnpm dev -- --config path/to/config.json)
```

### Single binary (distribution)

The gateway ships as a self-contained executable (embeds the Bun runtime +
bundled `ws`; no Node install needed on the target host).

#### Download a prebuilt binary

Every `v*` tag triggers the [Release workflow](.github/workflows/release.yml),
which cross-compiles four targets and attaches them to the corresponding
[GitHub Release](https://github.com/shannon-agent/shannon-gateway/releases):

| Asset | Target |
|---|---|
| `shannon-gateway-linux-x64` | Linux x86_64 |
| `shannon-gateway-darwin-x64` | macOS Intel |
| `shannon-gateway-darwin-arm64` | macOS Apple Silicon |
| `shannon-gateway-windows-x64.exe` | Windows x86_64 |

```bash
# Example: latest Apple Silicon macOS build
curl -L -o shannon-gateway https://github.com/shannon-agent/shannon-gateway/releases/latest/download/shannon-gateway-darwin-arm64
chmod +x shannon-gateway
./shannon-gateway --config path/to/config.json
```

The linux-x64 build is smoke-tested (boots to the `shannon-gateway up:` line)
before the release is published; the other three targets are byte-compiled
from the same source via Bun `--target` cross-compilation.

#### Build from source

```bash
pnpm build:binary          # → dist/shannon-gateway (host target)
./dist/shannon-gateway --config path/to/config.json
```

Cross-compile for another target with Bun's `--target` (triplet:
`<bun-version>-<os>-<arch>`):

```bash
bun build --compile --target=bun-darwin-arm64 --outfile=dist/shannon-gateway-darwin-arm64 src/index.ts
bun build --compile --target=bun-windows-x64  --outfile=dist/shannon-gateway-windows-x64.exe  src/index.ts
```

The config + keyring are read at runtime exactly as in `pnpm dev` — only the
runtime is embedded, never secrets. CI (`binary` job) compiles + smoke-tests
each PR so bundle regressions surface before merge.

### Configuration

Default path: `~/.shannon/gateway/config.json`. Override with
`$SHANNON_GATEWAY_CONFIG` or `pnpm dev -- --config <path>`.

```json
{
  "engine": {
    "wsUrl": "ws://127.0.0.1:33420/api/ws",
    "httpBaseUrl": "http://127.0.0.1:33420",
    "model": "claude-sonnet-4-6"
  },
  "adapters": [
    {
      "platform": "slack",
      "enabled": true,
      "options": {},
      "secrets": {
        "botToken": "slack/bot-token",
        "signingSecret": "slack/signing-secret"
      }
    }
  ],
  "logLevel": "info"
}
```

- `options` — platform-specific **non-secret** fields (app id, webhook path…).
- `secrets` — named OS-keyring entries the adapter needs (map of adapter name →
  keyring key). **Tokens are never inlined here.**

### Secrets / OS keyring (F14)

The adapter reads each secret at `start()` via `ctx.getSecret(key)`. Key format
is `<service>/<account>`; the part before the first `/` is the keyring service,
the rest is the account. With no `/`, the service defaults to `shannon-gateway`.

Store a credential once (e.g. for the key `slack/bot-token`):

```bash
# macOS (Keychain)
security add-generic-password -s slack -a bot-token -w 'xoxb-...'

# Linux (libsecret / secret-tool)
secret-tool store --label='slack bot token' service slack account bot-token
```

**Env override (dev):** any key is also readable from the environment as
`SHANNON_SECRET__` + the key uppercased with non-alphanumerics → `_`. For
`slack/bot-token` that's `SHANNON_SECRET__SLACK_BOT_TOKEN=xoxb-...`. The env
provider wins over the keyring in the default chain, so this is the easiest way
to test locally without touching the OS keyring.

A missing secret resolves to `null` (never throws); the adapter decides whether
that's fatal for its platform.

## Writing an adapter

A platform adapter is a `ChannelAdapter` (see `src/adapters/types.ts`) plus a
factory. The contract is enforced structurally at registration
(`assertAdapterContract`), so adding a platform = fill the interface + pass the
contract check, not edit a dispatch switch.

### 1. Extend the platform enum

Add the platform id to `Platform` and `PLATFORMS` in
`src/adapters/types.ts` (unless it already exists).

### 2. Implement the adapter + factory

```ts
import {
  type AdapterCapabilities, type AdapterContext, type ChannelAdapter,
  type MessageReceipt, type NormalizedInbound, type ReplyTarget,
} from "../types.js";
import { type AdapterConfig } from "../../config/types.js";

export function createExampleAdapter(cfg: AdapterConfig, ctx: AdapterContext): ChannelAdapter {
  const capabilities: AdapterCapabilities = {
    threading: true,        // platform supports threads / reply quoting
    pairing: false,         // supports DM pairing (F14 allowlist flow)
    approvalButtons: true,  // can render in-channel approval buttons
    streaming: "partial",   // "none" | "partial" | "block"
  };
  let onMessage: ((m: NormalizedInbound) => void) | null = null;

  return {
    platform: "example",
    capabilities,
    async start(ctx) {
      const token = await ctx.getSecret("example/bot-token");
      if (!token) throw new Error("example/bot-token missing from keyring");
      // ...open platform connection; on inbound, build + push NormalizedInbound
      onMessage?.({ platform: "example", chatId, senderId, senderName, text, timestamp: Date.now() });
    },
    async stop() { /* disconnect; idempotent */ },
    onMessage(handler) { onMessage = handler; },
    async send(target: ReplyTarget, text: string): Promise<MessageReceipt> {
      // ...POST to platform API; carry target.threadId for thread continuity (F4)
      return { messageId: "..." };
    },
    async requestApproval(target, req) {
      // render req as buttons; resolve with { requestId, choice: "allow" | "deny" }
    },
    resolveSessionConversation(rawId) {
      return { baseChatId: rawId /* + threadId when the platform threads */ };
    },
  };
}
```

### 3. Register the factory

In `src/index.ts`:

```ts
import { createExampleAdapter } from "./adapters/example/exampleAdapter.js";
const factories = new Map<string, AdapterFactory>([
  ["example", createExampleAdapter],
]);
```

### 4. Mock-test the transforms

Each adapter ships a vitest suite that exercises its pure transforms
(inbound normalization, outbound formatting, signature checks, thread id
round-trip) against fixtures — **no real platform connection**. Real-credential
end-to-end smoke is a separate, manual step per platform (the bot token is never
in the repo). See `src/adapters/__tests__/` and the mock-adapter pattern in
`src/__tests__/bootstrap.test.ts`.

## Status

- **Phase 0** (engine side, `shannon-code` #65–#68): approval round-trip, cancel,
  session persistence — done.
- **Phase 1** (this repo, #1–#6): WS engine client, `ChannelAdapter` contract +
  registry, per-session router + lane, default + approval turn handlers, DM
  pairing + allowlist — done, mock-tested.
- **Bootstrap** (#8): config loader, secret providers, runnable entry — done.
- **Adapters**: platform implementations + real-credential smoke in progress
  (P1-g Slack, T6 Telegram/Discord/Matrix/WhatsApp/WeCom/Feishu/DingTalk).
- **Phase 2**: streaming (edit-in-place) replies — done; single-binary
  packaging for desktop distribution — done (Release workflow cross-compiles
  linux/macOS/Windows binaries on every `v*` tag).

## Security

Platform credentials never live in this repo — they are stored in the OS
keyring (or a process env var for dev) and read at runtime through
`AdapterContext.getSecret` (F14). `.env*` is gitignored.
