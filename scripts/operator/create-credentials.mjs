#!/usr/bin/env node
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) =>
  value.startsWith('--') ? [value.slice(2), all[index + 1]] : []
));
const output = resolve(args.output ?? 'operator-auth.json');
const adminUsername = args.admin ?? 'admin';
const viewerUsername = args.viewer ?? 'viewer';
if (adminUsername === viewerUsername) throw new Error('Admin and viewer usernames must differ.');

const generatePassword = () => randomBytes(18).toString('base64url');
const adminPassword = generatePassword();
const viewerPassword = generatePassword();
const automationToken = randomBytes(32).toString('base64url');
const base32 = buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    output += alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return output;
};
const credential = (username, role, password) => {
  const salt = randomBytes(16).toString('base64');
  const hash = scryptSync(password, Buffer.from(salt, 'base64'), 64, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }).toString('base64');
  const totpSecret = base32(randomBytes(20));
  const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(8).toString('hex'));
  return {
    value: {
      username,
      role,
      salt,
      hash,
      totpSecret,
      recoveryCodeHashes: recoveryCodes.map(code =>
        createHash('sha256').update(code).digest('base64')
      )
    },
    totpSecret,
    recoveryCodes
  };
};

const adminCredential = credential(adminUsername, 'admin', adminPassword);
const viewerCredential = credential(viewerUsername, 'viewer', viewerPassword);
const document = {
  version: 2,
  users: [
    adminCredential.value,
    viewerCredential.value
  ],
  automationTokenHash: createHash('sha256').update(automationToken).digest('base64')
};
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
chmodSync(output, 0o600);

console.log(`Created ${output}`);
console.log(`ADMIN_USERNAME=${adminUsername}`);
console.log(`ADMIN_PASSWORD=${adminPassword}`);
console.log(`VIEWER_USERNAME=${viewerUsername}`);
console.log(`VIEWER_PASSWORD=${viewerPassword}`);
console.log(`AUTOMATION_TOKEN=${automationToken}`);
console.log(`ADMIN_TOTP_SECRET=${adminCredential.totpSecret}`);
console.log(`ADMIN_RECOVERY_CODES=${adminCredential.recoveryCodes.join(',')}`);
console.log(`VIEWER_TOTP_SECRET=${viewerCredential.totpSecret}`);
console.log(`VIEWER_RECOVERY_CODES=${viewerCredential.recoveryCodes.join(',')}`);
console.log('Enroll each TOTP secret in the intended account holder authenticator. Store recovery codes separately; each is one-time.');
