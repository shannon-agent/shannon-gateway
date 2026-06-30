import { describe, expect, it, vi } from "vitest";

import { respondToApproval } from "../httpClient.js";

function ok(): Response {
  return new Response("{}", { status: 200 });
}

describe("respondToApproval", () => {
  it("posts allow mapped to allow_once with the right body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await respondToApproval({
      engineBaseUrl: "http://127.0.0.1:33420",
      requestId: "req-1",
      choice: "allow",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:33420/api/approval/respond");
    const init = call[1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      request_id: "req-1",
      choice: "allow_once",
    });
  });

  it("posts deny unchanged", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await respondToApproval({
      engineBaseUrl: "http://e",
      requestId: "r2",
      choice: "deny",
      fetchImpl,
    });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      request_id: "r2",
      choice: "deny",
    });
  });

  it("strips trailing slashes from the base url", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await respondToApproval({
      engineBaseUrl: "http://e///",
      requestId: "r",
      choice: "allow",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://e/api/approval/respond");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 404 }));
    await expect(
      respondToApproval({
        engineBaseUrl: "http://e",
        requestId: "r",
        choice: "deny",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
