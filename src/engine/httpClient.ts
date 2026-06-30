/**
 * HTTP helpers for the engine's non-streaming endpoints.
 *
 * The query stream lives on the WebSocket (src/engine/wsClient.ts), but the
 * approval round-trip is a plain POST (P0-b deliberately used HTTP so the
 * response need not share the query socket): `POST /api/approval/respond`
 * with body `{ request_id, choice }`.
 *
 * Uses the global `fetch` (Node 20+) — no extra dependency.
 *
 * Choice mapping: the gateway adapter exposes `allow | deny`; the engine's
 * wire enum is `allow_once | always_allow | deny`. We map `allow → allow_once`
 * (the safe one-shot). "always_allow" is a future platform-UX option.
 */

export type GatewayApprovalChoice = "allow" | "deny";

export interface RespondToApprovalOptions {
  /** Engine HTTP base URL, e.g. `http://127.0.0.1:33420`. */
  engineBaseUrl: string;
  requestId: string;
  choice: GatewayApprovalChoice;
  /** Override for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export async function respondToApproval(
  opts: RespondToApprovalOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wireChoice = opts.choice === "allow" ? "allow_once" : "deny";
  const url = `${opts.engineBaseUrl.replace(/\/+$/, "")}/api/approval/respond`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: opts.requestId, choice: wireChoice }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(
      `approval respond failed: HTTP ${res.status} from ${url}: ${body}`,
    );
  }
}
