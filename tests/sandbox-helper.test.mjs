import { describe, expect, it } from 'vitest';
import {
  SANDBOX_API_BASE_URL,
  SANDBOX_SETTINGS_URL,
  extractAuthorizationCode,
  issuerFromRedirectUri,
  validateClientId
} from '../scripts/sandbox/shared.mjs';

describe('Sandbox setup helper', () => {
  it('is pinned to Sandbox hosts', () => {
    expect(SANDBOX_API_BASE_URL).toBe('https://sandbox-b2b.revolut.com/api/1.0');
    expect(SANDBOX_SETTINGS_URL).toContain('sandbox-business.revolut.com');
  });

  it('derives the JWT issuer from the redirect URI domain', () => {
    expect(issuerFromRedirectUri('https://example.com/oauth/callback')).toBe('example.com');
    expect(() => issuerFromRedirectUri('http://example.com')).toThrow(/HTTPS/);
  });

  it('extracts an authorization code from a copied redirect URL', () => {
    expect(extractAuthorizationCode('https://example.com?code=oa_test_123')).toBe('oa_test_123');
    expect(extractAuthorizationCode('oa_test_456')).toBe('oa_test_456');
    expect(() => extractAuthorizationCode('https://example.com?state=missing')).toThrow(/code=/);
  });

  it('rejects blank or whitespace-containing ClientIDs', () => {
    expect(validateClientId('client_123')).toBe('client_123');
    expect(() => validateClientId('')).toThrow(/blank/);
    expect(() => validateClientId('bad client')).toThrow(/spaces/);
  });
});
