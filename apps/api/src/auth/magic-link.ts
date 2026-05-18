// Magic-link token generation + hashing for passwordless auth.
//
// The plaintext token is base64url-encoded random bytes; only the sha256 hash
// is ever persisted. Plaintext is delivered exactly once via email.

import { createHash, randomBytes } from 'node:crypto';

export const MAGIC_LINK_TTL_MIN = 15;

export interface MagicLinkToken {
  plain: string;
  hash: string;
  expiresAt: Date;
}

export const hashMagicLinkToken = (plain: string): string => {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
};

export const generateMagicLinkToken = (now: Date = new Date()): MagicLinkToken => {
  const plain = randomBytes(32).toString('base64url');
  const hash = hashMagicLinkToken(plain);
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MIN * 60 * 1000);
  return { plain, hash, expiresAt };
};
