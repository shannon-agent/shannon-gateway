import { describe, expect, it, vi } from "vitest";

import { createChainedSecretProvider } from "../chain.js";
import { createCliKeyringProvider } from "../cliKeyring.js";
import { createEnvSecretProvider, envNameForKey } from "../envProvider.js";

describe("envNameForKey", () => {
  it("maps slashes/dashes to an uppercased underscored env name", () => {
    expect(envNameForKey("slack/bot-token")).toBe("SHANNON_SECRET__SLACK_BOT_TOKEN");
  });
});

describe("createEnvSecretProvider", () => {
  it("returns the env value when present", async () => {
    const p = createEnvSecretProvider({ SHANNON_SECRET__SLACK_BOT_TOKEN: "xoxb-123" });
    expect(await p.get("slack/bot-token")).toBe("xoxb-123");
  });

  it("returns null when absent", async () => {
    const p = createEnvSecretProvider({});
    expect(await p.get("slack/bot-token")).toBeNull();
  });
});

describe("createChainedSecretProvider", () => {
  it("returns the first non-empty value", async () => {
    const p = createChainedSecretProvider([
      { get: async () => null },
      { get: async () => "second" },
      { get: async () => "third" },
    ]);
    expect(await p.get("k")).toBe("second");
  });

  it("returns null when every provider is empty", async () => {
    const p = createChainedSecretProvider([
      { get: async () => null },
      { get: async () => null },
    ]);
    expect(await p.get("k")).toBeNull();
  });
});

describe("createCliKeyringProvider", () => {
  it("trims stdout from the injected exec", async () => {
    const exec = vi.fn(async () => ({ stdout: "  secret-value\n", stderr: "" }));
    const p = createCliKeyringProvider({ exec });
    expect(await p.get("slack/bot-token")).toBe("secret-value");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("splits service/account and passes the account through", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: "v", stderr: "" }));
    const p = createCliKeyringProvider({ service: "shannon-gateway", exec });
    await p.get("slack/bot-token");
    const args = exec.mock.calls[0]![1];
    expect(args).toContain("slack");
    expect(args).toContain("bot-token");
  });

  it("uses the default service when the key has no slash", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: "v", stderr: "" }));
    const p = createCliKeyringProvider({ service: "shannon-gateway", exec });
    await p.get("standalone-key");
    const args = exec.mock.calls[0]![1];
    expect(args).toContain("standalone-key");
    expect(args).toContain("shannon-gateway");
  });

  it("returns null (does not throw) when exec fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("not found");
    });
    const p = createCliKeyringProvider({ exec });
    expect(await p.get("anything/x")).toBeNull();
  });
});
