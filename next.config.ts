import type { NextConfig } from 'next';

const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseHost = supabase ? new URL(supabase).origin : '';
const supabaseWs = supabaseHost.replace(/^http/, 'ws');

// CSP note: Next.js App Router injects inline bootstrap scripts; a nonce-based CSP would
// force every page to render dynamically (no static shell / offline cache), so we allow
// 'unsafe-inline' for scripts but lock down everything else. See docs/DECISIONS.md.
// Telegram Mini App (D30): the SDK script comes from telegram.org; Telegram Web embeds the app in
// an iframe from web.telegram.org (native clients use a webview, no iframe).
const TELEGRAM_SDK = 'https://telegram.org';
const TELEGRAM_WEB = 'https://web.telegram.org';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${TELEGRAM_SDK}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${supabaseHost}`.trim(),
  "font-src 'self'",
  `connect-src 'self' ${supabaseHost} ${supabaseWs}`.trim(),
  "media-src 'self' blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  `frame-ancestors 'self' ${TELEGRAM_WEB}`,
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
  // The coach screen became the chat; old links (reminder deep links, home-screen shortcuts) keep working.
  async redirects() {
    return [{ source: '/coach', destination: '/chat', permanent: false }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
