/**
 * Creates (or finds) the owner account via the Supabase Admin API and seeds per-user
 * defaults (bootstrap_user). Public sign-up stays disabled.
 *
 *   node --env-file=.env.local --import tsx scripts/create-user.ts --email you@example.com [--seed path.json]
 *
 * Everything personal (body stats, schedule, goals, templates, reminders,
 * memories) is read from scripts/personal-seed.json (gitignored). Plan sections missing
 * there fall back to the generic scripts/personal-seed.example.json; profile fields and
 * memories never do. The generated password is printed ONCE to stdout and never written
 * to disk or logs.
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Seed = Record<string, unknown>;

const PLAN_SECTIONS = ['goals', 'templates', 'reminders'] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readSeed(file: string): Seed {
  return JSON.parse(readFileSync(file, 'utf8')) as Seed;
}

/** Personal seed (or --seed) with generic plan sections filled in from the example. */
function loadSeed(): { seed: Seed; source: string; fallback: string[] } {
  const dir = path.join(process.cwd(), 'scripts');
  const explicit = arg('seed');
  const personalPath = explicit ? path.resolve(explicit) : path.join(dir, 'personal-seed.json');
  const personal = existsSync(personalPath) ? readSeed(personalPath) : {};
  const example = readSeed(path.join(dir, 'personal-seed.example.json'));
  const fallback = PLAN_SECTIONS.filter((k) => !Array.isArray(personal[k]));
  const seed = fallback.reduce<Seed>((acc, k) => ({ ...acc, [k]: example[k] }), personal);
  return { seed, source: existsSync(personalPath) ? path.relative(process.cwd(), personalPath) : '(none)', fallback };
}

function strongPassword(): string {
  // 24 chars from an unambiguous alphabet (~140 bits).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  const bytes = randomBytes(24);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = arg('email');
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required');
  if (!email) throw new Error('--email is required');
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { seed: personal, source, fallback } = loadSeed();
  if (fallback.length) console.error(`seed: ${source}; generic example used for: ${fallback.join(', ')}`);

  let userId: string | undefined;
  let password: string | undefined;
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    userId = existing.id;
    if (process.argv.includes('--reset-password')) {
      password = arg('password') ?? strongPassword();
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) throw error;
    }
  } else {
    password = arg('password') ?? strongPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    userId = data.user.id;
  }

  const { error: bootErr } = await admin.rpc('bootstrap_user', { uid: userId, p: personal });
  if (bootErr) throw bootErr;
  const { error: extraErr } = await admin.rpc('ensure_extra_rules', { uid: userId });
  if (extraErr) throw extraErr;

  console.log(JSON.stringify({ ok: true, userId, email, created: !existing, password: password ?? '(unchanged)' }));
}

main().catch((e) => {
  console.error('create-user failed:', (e as Error).message);
  process.exit(1);
});
