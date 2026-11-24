// Central access to environment variables. Server-only values must never be
// imported from client components (they are not prefixed with NEXT_PUBLIC_).

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
};

export function serverEnv() {
  return {
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost',
    cronSecret: process.env.CRON_SECRET ?? '',
    encryptionKey: process.env.APP_ENCRYPTION_KEY ?? '',
    appUrl: process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000'),
    // Speech-to-text only (Whisper): the ChatGPT plan has no transcription.
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
  };
}

export function isBackendConfigured(): boolean {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabasePublishableKey);
}
