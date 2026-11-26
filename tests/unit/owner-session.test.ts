import { beforeEach, describe, expect, it, vi } from 'vitest';

// mintOwnerSession (D32): one account has one live magic link, so concurrent mints must not
// replace each other's link before it is verified.

const auth = vi.hoisted(() => ({
  events: [] as string[],
  links: 0,
  /** hashed tokens the server will refuse as replaced (otp_expired) */
  expired: new Set<string>(),
}));

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, email: 'owner@example.test' } }, error: null }),
        generateLink: async () => {
          // like Supabase Auth: a new link replaces the account's previous one
          if (auth.links > 0) auth.expired.add(`h${auth.links}`);
          const hashed = `h${++auth.links}`;
          auth.events.push(`link:${hashed}`);
          await new Promise((r) => setTimeout(r, 5));
          return { data: { properties: { hashed_token: hashed } }, error: null };
        },
      },
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      verifyOtp: async ({ token_hash }: { token_hash: string }) => {
        auth.events.push(`verify:${token_hash}`);
        await new Promise((r) => setTimeout(r, 5));
        if (auth.expired.has(token_hash)) return { data: { session: null }, error: { status: 403, code: 'otp_expired', message: 'One-time token not found' } };
        return { data: { session: { access_token: `at-${token_hash}`, refresh_token: 'r', expires_at: 2_000_000_000, expires_in: 3600, token_type: 'bearer', user: { id: 'owner' } } }, error: null };
      },
    },
  }),
}));

const { mintOwnerSession } = await import('@/lib/auth/owner-session');

beforeEach(() => {
  auth.events.length = 0;
  auth.links = 0;
  auth.expired.clear();
});

describe('mintOwnerSession', () => {
  it('runs mints for one user one at a time, each verifying its own link', async () => {
    const [a, b] = await Promise.all([mintOwnerSession('owner'), mintOwnerSession('owner')]);
    expect(auth.events).toEqual(['link:h1', 'verify:h1', 'link:h2', 'verify:h2']);
    expect([a.access_token, b.access_token]).toEqual(['at-h1', 'at-h2']);
  });

  it('mints again when another instance replaced the link before verify', async () => {
    auth.expired.add('h1');
    const s = await mintOwnerSession('owner');
    expect(s.access_token).toBe('at-h2');
    expect(auth.events).toEqual(['link:h1', 'verify:h1', 'link:h2', 'verify:h2']);
  });

  it('gives up after three replaced links, and the next mint is not blocked by the failure', async () => {
    for (const h of ['h1', 'h2', 'h3']) auth.expired.add(h);
    await expect(mintOwnerSession('owner')).rejects.toThrow('verifyOtp failed: 403');
    expect(auth.links).toBe(3);
    await expect(mintOwnerSession('owner')).resolves.toMatchObject({ access_token: 'at-h4' });
  });
});
