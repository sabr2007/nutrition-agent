import { describe, expect, it } from 'vitest';
import { ConnectBody, hasPlanScope, invalidFields, toIsoTimestamp } from '@/lib/llm/chatgpt-connect';
import { argValue, DEFAULT_APP_URL, envValue, resolveAppUrl } from '../../scripts/lib/login-config';

const SECONDS = 1_790_000_000;
const AS_ISO = new Date(SECONDS * 1000).toISOString();

const validBody = {
  access_token: 'a'.repeat(40),
  refresh_token: 'r'.repeat(40),
  expires_in: 3600,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  client_id: 'oaiapp_AbC123-_x',
  earliest_refresh_at: null,
};

describe('chatgpt-login config', () => {
  it('treats vercel env pull placeholders and blanks as unset', () => {
    expect(envValue('[SENSITIVE]')).toBeUndefined();
    expect(envValue('  ')).toBeUndefined();
    expect(envValue(undefined)).toBeUndefined();
    expect(envValue(' https://example.test ')).toBe('https://example.test');
  });

  it('falls back to the production URL when APP_URL is a placeholder', () => {
    expect(resolveAppUrl(undefined, '[SENSITIVE]')).toBe(DEFAULT_APP_URL);
    expect(resolveAppUrl(undefined, undefined)).toBe(DEFAULT_APP_URL);
  });

  it('prefers --app-url over APP_URL and drops the trailing slash', () => {
    expect(resolveAppUrl('https://example.test/', 'https://other.test')).toBe('https://example.test');
    expect(resolveAppUrl(undefined, 'https://other.test/')).toBe('https://other.test');
  });

  it('allows plain http only for loopback addresses', () => {
    expect(resolveAppUrl('http://localhost:3000', undefined)).toBe('http://localhost:3000');
    expect(resolveAppUrl('http://127.0.0.1:3000', undefined)).toBe('http://127.0.0.1:3000');
    expect(() => resolveAppUrl('http://example.test', undefined)).toThrow(/https/);
  });

  it('rejects an APP_URL that is not a URL instead of silently using production', () => {
    expect(() => resolveAppUrl(undefined, 'ryadom.example')).toThrow(/URL/);
  });

  it('reads --name value flags', () => {
    expect(argValue(['node', 's.ts', '--email', 'a@b.c'], '--email')).toBe('a@b.c');
    expect(argValue(['node', 's.ts'], '--email')).toBeUndefined();
  });
});

describe('ChatGPT connect payload', () => {
  it('accepts the documented token response', () => {
    const parsed = ConnectBody.safeParse(validBody);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.earliest_refresh_at).toBeNull();
  });

  it('normalizes earliest_refresh_at given as epoch seconds, milliseconds or a date string', () => {
    expect(toIsoTimestamp(SECONDS)).toBe(AS_ISO);
    expect(toIsoTimestamp(SECONDS * 1000)).toBe(AS_ISO);
    expect(toIsoTimestamp(String(SECONDS))).toBe(AS_ISO);
    expect(toIsoTimestamp('2026-11-24T12:00:00Z')).toBe('2026-11-24T12:00:00.000Z');
    expect(toIsoTimestamp('soon')).toBeNull();
    expect(toIsoTimestamp(1e300)).toBeNull();
    expect(toIsoTimestamp(null)).toBeNull();
  });

  it('accepts a numeric earliest_refresh_at and a string expires_in', () => {
    const parsed = ConnectBody.safeParse({ ...validBody, earliest_refresh_at: SECONDS, expires_in: '3600' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ earliest_refresh_at: AS_ISO, expires_in: 3600 });
  });

  it('names the invalid fields without echoing token values', () => {
    const parsed = ConnectBody.safeParse({ ...validBody, client_id: 'dynamic_agent_client', access_token: 'short' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const fields = invalidFields(parsed.error);
    expect([...fields].sort()).toEqual(['access_token', 'client_id']);
    expect(fields.join(' ')).not.toContain('short');
  });

  it('requires the plan scope among the granted scopes', () => {
    expect(hasPlanScope(validBody.scope)).toBe(true);
    expect(hasPlanScope('openid profile email offline_access')).toBe(false);
  });
});
