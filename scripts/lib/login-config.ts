// Config helpers for scripts/chatgpt-login.ts, kept apart so they can be unit-tested.

export const DEFAULT_APP_URL = 'https://ryadom-coach.vercel.app';
/** `vercel env pull` writes sensitive values as a literal "[SENSITIVE]". */
const PLACEHOLDER = /^\[[A-Z_ ]+\]$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The value, or undefined when it is empty or an env-pull placeholder. */
export function envValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && !PLACEHOLDER.test(value) ? value : undefined;
}

/** Value of a `--name value` command-line flag. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Origin of the deployed app: --app-url, then APP_URL, then the production default. */
export function resolveAppUrl(flag: string | undefined, env: string | undefined): string {
  const candidate = envValue(flag) ?? envValue(env) ?? DEFAULT_APP_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Адрес «Рядом» не похож на URL: ${candidate}. Передай --app-url https://…`);
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) {
    throw new Error(`Адрес «Рядом» должен быть https (http только для localhost): ${candidate}`);
  }
  return url.origin;
}
