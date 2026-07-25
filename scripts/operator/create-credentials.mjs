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
const credential = (username, role, password) => {
  const salt = randomBytes(16).toString('base64');
  const hash = scryptSync(password, Buffer.from(salt, 'base64'), 64, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }).toString('base64');
  return { username, role, salt, hash };
};

const document = {
  version: 1,
  users: [
    credential(adminUsername, 'admin', adminPassword),
    credential(viewerUsername, 'viewer', viewerPassword)
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
console.log('Store these values securely. Passwords and the token cannot be recovered from the file.');
