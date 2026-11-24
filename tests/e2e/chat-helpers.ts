import { expect, type Page } from '@playwright/test';
import { encodeEvent, type ChatEvent, type ChatMessage } from '../../src/lib/chat/protocol';

export const email = process.env.E2E_EMAIL ?? '';
export const password = process.env.E2E_PASSWORD ?? '';

/** `next dev` draws its issues badge over the bottom-left corner (the "+" button); production has none. */
export async function hideDevOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = 'nextjs-portal { display: none !important; }';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });
}

export async function login(page: Page): Promise<void> {
  await hideDevOverlay(page);
  await page.goto('/login');
  await page.getByLabel('почта').fill(email);
  await page.getByLabel('пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('ккал', { exact: true }).first()).toBeVisible();
}

type ChatBody = { text: string; media_ids: string[]; deep?: boolean; skill?: string };

/**
 * Stands in for the agent: the real one runs on the owner's ChatGPT plan, which a local stack
 * does not have. GET returns what was "saved", POST streams NDJSON like /api/chat does.
 */
export async function fakeAgent(page: Page, reply: (body: ChatBody) => { events: ChatEvent[]; text: string; meta?: ChatMessage['meta'] }) {
  const saved: ChatMessage[] = [];
  const requests: ChatBody[] = [];
  await page.route('**/api/chat', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ json: { messages: saved } });
      return;
    }
    const body = req.postDataJSON() as ChatBody;
    requests.push(body);
    const now = Date.now();
    const user: ChatMessage = {
      id: `u-${now}`, role: 'user', kind: 'chat', text: body.text, created_at: new Date(now).toISOString(),
      parts: [...body.media_ids.map((id) => ({ type: 'image' as const, media_id: id, path: '' })), ...(body.text ? [{ type: 'text' as const, text: body.text }] : [])],
    };
    const r = reply(body);
    const message: ChatMessage = { id: `a-${now}`, role: 'assistant', kind: 'chat', text: r.text, created_at: new Date(now + 1).toISOString(), meta: r.meta ?? {} };
    saved.push(user, message);
    const events: ChatEvent[] = [...r.events, { t: 'done', message, user }];
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: events.map(encodeEvent).join('') });
  });
  return { requests };
}
