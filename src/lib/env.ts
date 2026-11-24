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
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    gatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
    chatgptClientId: process.env.CHATGPT_OAUTH_CLIENT_ID ?? '',
    chatgptClientSecret: process.env.CHATGPT_OAUTH_CLIENT_SECRET ?? '',
    providerOrder: (process.env.LLM_PROVIDER_ORDER || 'chatgpt,gateway,openai,workers-ai')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export function isBackendConfigured(): boolean {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabasePublishableKey);
}
