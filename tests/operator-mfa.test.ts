import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  OperatorAuth,
  type OperatorCredentials
} from '../src/security/operator-auth.js';
import { SQLiteSandboxTransferStore } from '../src/storage/sandbox-transfer-store.js';

describe('operator MFA', () => {
  it('requires TOTP, rejects replay, and consumes a recovery code only once', () => {
    const store = new SQLiteSandboxTransferStore(':memory:');
    const adminSalt = randomBytes(16).toString('base64');
    const viewerSalt = randomBytes(16).toString('base64');
    const recovery = 'recovery-code-1234';
    const credentials: OperatorCredentials = {
      version: 2,
      users: [
        {
          username: 'admin',
          role: 'admin',
          salt: adminSalt,
          hash: hashPassword('admin-password', adminSalt),
          totpSecret: 'JBSWY3DPEHPK3PXP',
          recoveryCodeHashes: [createHash('sha256').update(recovery).digest('base64')]
        },
        {
          username: 'viewer',
          role: 'viewer',
          salt: viewerSalt,
          hash: hashPassword('viewer-password', viewerSalt),
          totpSecret: 'JBSWY3DPEHPK3PXQ',
          recoveryCodeHashes: []
        }
      ],
      automationTokenHash: createHash('sha256').update('automation').digest('base64')
    };
    const auth = new OperatorAuth(credentials, store);
    try {
      expect(auth.login('admin', 'admin-password', '127.0.0.1')).toBeUndefined();
      const code = totp(credentials.users[0]!.totpSecret!);
      expect(auth.login('admin', 'admin-password', '127.0.0.1', code)?.principal.role).toBe('admin');
      expect(auth.login('admin', 'admin-password', '127.0.0.2', code)).toBeUndefined();
      expect(auth.login('admin', 'admin-password', '127.0.0.3', recovery)?.principal.role).toBe('admin');
      expect(auth.login('admin', 'admin-password', '127.0.0.4', recovery)).toBeUndefined();
      expect(store.listOperatorEvents(20).map(event => event.action)).toContain('recovery_code');
    } finally {
      store.close();
    }
  });
});

function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from(Array.from(
    { length: Math.floor(bits.length / 8) },
    (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)
  ));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  const binary = (
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  );
  return String(binary % 1_000_000).padStart(6, '0');
}
