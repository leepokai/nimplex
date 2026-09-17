// Envelope encryption for the BYOK vault.
//
// Plaintext exists in memory while accepting a key or calling its provider.
// Persist only AES-256-GCM ciphertext; never expose provider keys to sandboxes.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

let warned = false;

function masterKey(): Buffer {
  const raw = process.env.NIMPLEX_MASTER_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error("NIMPLEX_MASTER_KEY 必須是 base64 編碼的 32 bytes");
    }
    return key;
  }
  if (!warned) {
    warned = true;
    console.warn(
      "[nimplex] NIMPLEX_MASTER_KEY 未設定，改用開發用固定金鑰。正式環境務必設定（openssl rand -base64 32）。",
    );
  }
  return createHash("sha256").update("nimplex-insecure-dev-key").digest();
}

export function seal(plaintext: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open(sealed: SealedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, masterKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function last4(value: string): string {
  return value.slice(-4).padStart(4, "*");
}

/** Tokens are stored hashed only; a leaked DB yields nothing usable. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** org API key: plaintext is returned once at creation, only the hash lands in the DB. */
export function generateApiKey(): string {
  return `nmx_live_${randomBytes(24).toString("base64url")}`;
}
