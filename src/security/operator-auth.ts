import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SandboxTransferStore } from '../storage/sandbox-transfer-store.js';

export type OperatorRole = 'admin' | 'viewer' | 'automation';

export interface PasswordCredential {
  username: string;
  role: 'admin' | 'viewer';
  salt: string;
  hash: string;
}

export interface OperatorCredentials {
  version: 1;
  users: PasswordCredential[];
  automationTokenHash: string;
}

export interface OperatorPrincipal {
  username: string;
  role: OperatorRole;
  csrfToken?: string;
}

interface Session extends OperatorPrincipal {
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

const sessionCookie = 'revolut_operator_session';
const idleTimeoutMs = 30 * 60 * 1000;
const absoluteTimeoutMs = 8 * 60 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;
const maximumLoginFailures = 5;

export function loadOperatorCredentials(path: string): OperatorCredentials {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<OperatorCredentials>;
  if (value.version !== 1 || !Array.isArray(value.users) || typeof value.automationTokenHash !== 'string') {
    throw new Error('Operator credential file is invalid.');
  }
  const roles = value.users.map(user => user.role);
  if (value.users.length !== 2 || roles.filter(role => role === 'admin').length !== 1 ||
      roles.filter(role => role === 'viewer').length !== 1) {
    throw new Error('Operator credentials must contain exactly one admin and one viewer.');
  }
  return value as OperatorCredentials;
}

export function hashPassword(password: string, saltBase64: string) {
  return scryptSync(password, Buffer.from(saltBase64, 'base64'), 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  }).toString('base64');
}

function verifyPassword(password: string, credential: PasswordCredential) {
  const expected = Buffer.from(credential.hash, 'base64');
  const actual = Buffer.from(hashPassword(password, credential.salt), 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('base64');
}

function parseCookies(value: string | undefined) {
  return Object.fromEntries((value ?? '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    return separator === -1
      ? [part, '']
      : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }));
}

export class OperatorAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly credentials: OperatorCredentials,
    private readonly store: SandboxTransferStore,
    private readonly cookieSecure = false
  ) {}

  login(username: string, password: string, remoteAddress: string) {
    const normalized = username.trim().toLowerCase().slice(0, 80);
    const failureKey = `${remoteAddress}:${normalized}`;
    const now = Date.now();
    const recentFailures = (this.failures.get(failureKey) ?? []).filter(time => now - time < loginWindowMs);
    if (recentFailures.length >= maximumLoginFailures) {
      this.audit(normalized || 'unknown', 'viewer', 'login', 'rate_limited');
      return undefined;
    }
    const credential = this.credentials.users.find(user => user.username.toLowerCase() === normalized);
    if (!credential || !verifyPassword(password, credential)) {
      recentFailures.push(now);
      this.failures.set(failureKey, recentFailures);
      this.audit(normalized || 'unknown', credential?.role ?? 'viewer', 'login', 'denied');
      return undefined;
    }
    this.failures.delete(failureKey);
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const session: Session = {
      username: credential.username,
      role: credential.role,
      csrfToken,
      tokenHash: tokenHash(rawToken),
      createdAt: now,
      lastSeenAt: now
    };
    this.sessions.set(session.tokenHash, session);
    this.audit(session.username, session.role, 'login', 'success');
    return { rawToken, principal: this.publicPrincipal(session) };
  }

  logout(request: FastifyRequest) {
    const rawToken = parseCookies(request.headers.cookie)[sessionCookie];
    if (!rawToken) return;
    const hash = tokenHash(rawToken);
    const session = this.sessions.get(hash);
    if (session) this.audit(session.username, session.role, 'logout', 'success');
    this.sessions.delete(hash);
  }

  authenticate(request: FastifyRequest): OperatorPrincipal | undefined {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const supplied = Buffer.from(tokenHash(authorization.slice(7)));
      const expected = Buffer.from(this.credentials.automationTokenHash);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        return { username: 'sandbox-automation', role: 'automation' };
      }
      return undefined;
    }
    const rawToken = parseCookies(request.headers.cookie)[sessionCookie];
    if (!rawToken) return undefined;
    const hash = tokenHash(rawToken);
    const session = this.sessions.get(hash);
    if (!session) return undefined;
    const now = Date.now();
    if (now - session.lastSeenAt > idleTimeoutMs || now - session.createdAt > absoluteTimeoutMs) {
      this.sessions.delete(hash);
      return undefined;
    }
    session.lastSeenAt = now;
    return this.publicPrincipal(session);
  }

  require(
    request: FastifyRequest,
    reply: FastifyReply,
    roles: OperatorRole[],
    requireCsrf = false
  ) {
    const principal = this.authenticate(request);
    if (!principal) {
      void reply.code(401).send({ error: 'Authentication required.' });
      return undefined;
    }
    if (!roles.includes(principal.role)) {
      this.audit(principal.username, principal.role, 'authorization', 'denied');
      void reply.code(403).send({ error: 'This account does not have permission.' });
      return undefined;
    }
    if (requireCsrf && principal.role !== 'automation' &&
        request.headers['x-csrf-token'] !== principal.csrfToken) {
      this.audit(principal.username, principal.role, 'csrf', 'denied');
      void reply.code(403).send({ error: 'Security token is missing or expired.' });
      return undefined;
    }
    if (requireCsrf && principal.role !== 'automation') {
      const origin = request.headers.origin;
      const expectedOrigin = `http${this.cookieSecure ? 's' : ''}://${request.headers.host}`;
      if (!origin || origin !== expectedOrigin) {
        this.audit(principal.username, principal.role, 'origin', 'denied');
        void reply.code(403).send({ error: 'Request origin is not authorized.' });
        return undefined;
      }
    }
    return principal;
  }

  verifyAdminPassword(username: string, password: string, remoteAddress: string) {
    const key = `${remoteAddress}:reauth:${username}`;
    const now = Date.now();
    const recentFailures = (this.failures.get(key) ?? []).filter(time => now - time < loginWindowMs);
    if (recentFailures.length >= maximumLoginFailures) return false;
    const credential = this.credentials.users.find(user => user.username === username && user.role === 'admin');
    const valid = credential ? verifyPassword(password, credential) : false;
    if (valid) this.failures.delete(key);
    else {
      recentFailures.push(now);
      this.failures.set(key, recentFailures);
    }
    return valid;
  }

  setSessionCookie(reply: FastifyReply, rawToken: string) {
    const secure = this.cookieSecure ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `${sessionCookie}=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`
    );
  }

  clearSessionCookie(reply: FastifyReply) {
    reply.header(
      'set-cookie',
      `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.cookieSecure ? '; Secure' : ''}`
    );
  }

  audit(
    actor: string,
    role: OperatorRole,
    action: string,
    outcome: string,
    transferId?: string,
    details: Record<string, unknown> = {}
  ) {
    this.store.recordOperatorEvent({
      actor,
      role,
      action,
      outcome,
      ...(transferId ? { transferId } : {}),
      details
    });
  }

  private publicPrincipal(session: Session): OperatorPrincipal {
    return {
      username: session.username,
      role: session.role,
      ...(session.csrfToken ? { csrfToken: session.csrfToken } : {})
    };
  }
}

export function createTestCredentials(): OperatorCredentials {
  const adminSalt = randomBytes(16).toString('base64');
  const viewerSalt = randomBytes(16).toString('base64');
  return {
    version: 1,
    users: [
      { username: 'admin', role: 'admin', salt: adminSalt, hash: hashPassword('admin-test-password', adminSalt) },
      { username: 'viewer', role: 'viewer', salt: viewerSalt, hash: hashPassword('viewer-test-password', viewerSalt) }
    ],
    automationTokenHash: tokenHash('automation-test-token')
  };
}
