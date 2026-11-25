// The service worker imports this script (public/sw.js → importScripts). Its bytes change with
// every deploy, so the browser installs the new worker, which drops the old caches and takes over;
// the page then reloads once (ServiceWorker.tsx). Inside Telegram the Mini App never sticks to an
// old shell (D30).
const VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? 'dev').slice(0, 12);

export function GET(): Response {
  return new Response(`self.SW_VERSION = ${JSON.stringify(VERSION)};\n`, {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' },
  });
}
