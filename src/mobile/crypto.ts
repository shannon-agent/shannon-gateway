/**
 * Ed25519 device-key crypto for mobile pairing (P1.2), using Node's built-in
 * `node:crypto` — no external dependency to add to the gateway bundle.
 *
 * Wire format: the device public key travels as the JWK `x` coordinate, i.e.
 * base64url(raw 32 bytes). Signatures are base64url(raw 64 bytes). These match
 * what a Flutter `cryptography` Ed25519 client produces once its raw bytes are
 * base64url-encoded, so the phone and gateway agree without a custom container.
 *
 * The phone generates and holds its own keypair (P1.4); the gateway only ever
 * sees the public key and verifies signatures — it stores no private key per
 * device. (`signMessage` / `generateEd25519KeyPair` exist for tests to produce
 * valid signatures; production gateway code only verifies.)
 */

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface Ed25519KeyPair {
  /** JWK `x` — base64url of the 32-byte raw public key. This is the wire form. */
  publicKeyB64Url: string;
  privateKey: KeyObject;
}

/** Generate a keypair (tests / phone-side stand-in). Gateway never calls this. */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { publicKeyB64Url: jwk.x, privateKey };
}

/** Reconstruct a verify-only KeyObject from the wire public-key form. */
export function publicKeyFromB64Url(b64Url: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: b64Url },
    format: "jwk",
  });
}

/** Sign a UTF-8 message with an Ed25519 private key → base64url signature. */
export function signMessage(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

/**
 * Verify a base64url Ed25519 signature against the device's base64url public key.
 * Returns false (never throws) for any malformed input, unknown key, or bad
 * signature — callers treat all alike as "authentication failed".
 */
export function verifyMessage(
  publicKeyB64Url: string,
  message: string,
  signatureB64Url: string,
): boolean {
  try {
    const pub = publicKeyFromB64Url(publicKeyB64Url);
    const sig = Buffer.from(signatureB64Url, "base64url");
    return verify(null, Buffer.from(message, "utf8"), pub, sig);
  } catch {
    return false;
  }
}

/**
 * Deterministic device id from a public key (sha256, first 32 hex / 128 bits).
 * Deterministic so re-pairing the same device key maps to the same id (no
 * duplicate entries; revoke + re-pair is idempotent) without the gateway
 * minting or storing a separate id.
 */
export function deviceIdFromPublicKey(publicKeyB64Url: string): string {
  return createHash("sha256").update(publicKeyB64Url).digest("hex").slice(0, 32);
}

/** Generate a one-time pairing token (32 random bytes, base64url ≈ 192 bits). */
export function generatePairToken(): string {
  return randomBytes(32).toString("base64url");
}

// ── canonical signed-message formats ──────────────────────────────────────
// Centralized so the phone (P1.4) and gateway sign/verify the exact same bytes.

/** Proof-of-possession signed during `shannon/pair` (proves the phone holds the
 *  private key for the public key it's registering). */
export function pairPopMessage(pairToken: string, devicePublicKeyB64Url: string): string {
  return `${pairToken}:${devicePublicKeyB64Url}`;
}

/** `shannon/device.resume` anti-replay: signs deviceId + timestamp. */
export function resumeMessage(deviceId: string, timestampMs: number): string {
  return `${deviceId}:${timestampMs}`;
}

/** `shannon/approval/decide`: mandatory per-decision device signature. */
export function approvalMessage(requestId: string, choice: "allow" | "deny"): string {
  return `${requestId}:${choice}`;
}
