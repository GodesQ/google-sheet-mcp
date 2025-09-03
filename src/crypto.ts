import crypto from "node:crypto";

function getKey(): Buffer {
  const b64 = process.env.TOKEN_ENC_KEY;
  if (!b64) throw new Error("Missing TOKEN_ENC_KEY env var (base64 32 bytes)");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENC_KEY must decode to 32 bytes");
  return key;
}

export function decryptToken(params: { enc: string; iv: string; tag: string }): string {
  const key = getKey();
  const iv = Buffer.from(params.iv, "base64");
  const tag = Buffer.from(params.tag, "base64");
  const cipherText = Buffer.from(params.enc, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return plain.toString("utf8");
}
