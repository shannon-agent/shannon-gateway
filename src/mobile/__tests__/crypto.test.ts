import { describe, expect, it } from "vitest";

import {
  approvalMessage,
  deviceIdFromPublicKey,
  generateEd25519KeyPair,
  pairPopMessage,
  resumeMessage,
  signMessage,
  verifyMessage,
} from "../crypto.js";

describe("Ed25519 crypto helpers (P1.2)", () => {
  it("verifies a signature it signed (round-trip)", () => {
    const kp = generateEd25519KeyPair();
    const sig = signMessage(kp.privateKey, "hello");
    expect(verifyMessage(kp.publicKeyB64Url, "hello", sig)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const kp = generateEd25519KeyPair();
    const sig = signMessage(kp.privateKey, "hello");
    expect(verifyMessage(kp.publicKeyB64Url, "goodbye", sig)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    const sig = signMessage(a.privateKey, "hello");
    expect(verifyMessage(b.publicKeyB64Url, "hello", sig)).toBe(false);
  });

  it("returns false (never throws) on malformed key or signature", () => {
    expect(verifyMessage("not-a-valid-key", "hello", "sig")).toBe(false);
    const kp = generateEd25519KeyPair();
    expect(verifyMessage(kp.publicKeyB64Url, "hello", "not-a-valid-sig")).toBe(false);
  });

  it("deviceIdFromPublicKey is deterministic, 32-hex, and key-distinct", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    const idA = deviceIdFromPublicKey(a.publicKeyB64Url);
    expect(idA).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceIdFromPublicKey(a.publicKeyB64Url)).toBe(idA);
    expect(deviceIdFromPublicKey(b.publicKeyB64Url)).not.toBe(idA);
  });

  it("canonical message builders are stable (wire format)", () => {
    expect(pairPopMessage("tok", "pk")).toBe("tok:pk");
    expect(resumeMessage("dev1", 123_000)).toBe("dev1:123000");
    expect(approvalMessage("r1", "allow")).toBe("r1:allow");
    expect(approvalMessage("r1", "deny")).toBe("r1:deny");
  });
});
