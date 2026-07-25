import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './canonical.js';

const envelopeVersion = 1;

export class EncryptedEvidenceStore {
  constructor(
    private readonly root: string,
    private readonly key: Buffer
  ) {
    if (key.length !== 32) throw new Error('Case evidence encryption key must contain exactly 32 bytes.');
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  put(plaintext: Buffer) {
    const plaintextSha256 = sha256(plaintext);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`case-evidence:${plaintextSha256}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([
      Buffer.from([envelopeVersion]),
      nonce,
      tag,
      ciphertext
    ]);
    const encryptedObjectSha256 = sha256(envelope);
    const directory = join(this.root, plaintextSha256.slice(0, 2));
    const path = join(directory, `${plaintextSha256}.enc`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, envelope, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = readFileSync(path);
      if (sha256(existing) !== encryptedObjectSha256) {
        throw new Error('Content-addressed evidence object conflicts with existing encrypted content.');
      }
    }
    return { plaintextSha256, encryptedObjectSha256 };
  }

  get(plaintextSha256: string) {
    if (!/^[a-f0-9]{64}$/.test(plaintextSha256)) throw new Error('Invalid evidence digest.');
    const envelope = readFileSync(join(this.root, plaintextSha256.slice(0, 2), `${plaintextSha256}.enc`));
    if (envelope[0] !== envelopeVersion || envelope.length < 30) {
      throw new Error('Evidence encryption envelope is invalid.');
    }
    const nonce = envelope.subarray(1, 13);
    const tag = envelope.subarray(13, 29);
    const ciphertext = envelope.subarray(29);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(`case-evidence:${plaintextSha256}`));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (sha256(plaintext) !== plaintextSha256) throw new Error('Evidence plaintext hash verification failed.');
    return plaintext;
  }
}
