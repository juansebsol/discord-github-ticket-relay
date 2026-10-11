import { createPublicKey, verify, type KeyObject } from 'node:crypto';

const keyCache = new Map<string, KeyObject>();

function publicKey(hex: string): KeyObject {
  let key = keyCache.get(hex);
  if (!key) {
    key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
      format: 'jwk',
    });
    keyCache.set(hex, key);
  }
  return key;
}

/**
 * Verifies a Discord interaction request: Ed25519 signature over timestamp + raw body.
 * Also rejects stale timestamps to limit replay of captured requests.
 */
export function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = 300,
): boolean {
  if (!signatureHex || !timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > maxSkewSeconds) return false;
  try {
    return verify(null, Buffer.from(timestamp + rawBody), publicKey(publicKeyHex), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
