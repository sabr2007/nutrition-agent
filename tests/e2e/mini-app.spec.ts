import { expect, test, type Page, type Route } from '@playwright/test';

// The Mini App as Telegram opens it (D30): a stand-in Telegram.WebApp with launch data, every API
// mocked — nothing real is read or written, so this runs against any deployment
// (E2E_BASE_URL=https://… pnpm test:e2e tests/e2e/mini-app.spec.ts).

const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const MEAL_ID = '00000000-0000-4000-8000-0000000000m1'.replace('m1', 'b1');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;

const goal = { id: 'g1', name: 'Челлендж', kind: 'phase', starts_on: '2026-11-20', ends_on: null, kcal_min: 1650, kcal_max: 1800, kcal_floor: 1500, protein_min_g: 180, protein_max_g: 200, fat_min_g: 40, fat_max_g: 50, carbs_min_g: 100, carbs_max_g: 130, steps_min: 10000 };
const meal = {
  id: MEAL_ID, root_id: MEAL_ID, eaten_at: new Date().toISOString(), logged_at: new Date().toISOString(), slot: 'lunch', title: 'Обед', input_method: 'agent', template_id: null,
  confidence: 1, kcal: 560, protein_g: 62, fat_g: 9, carbs_g: 58, satfat_g: null, note: null, is_labeled: false,
  items: [
    { id: 'i1', food_id: '00000000-0000-4000-8000-0000000000f1', name: 'Куриная грудка', grams: 250, kcal: 283, protein_g: 58, fat_g: 4, carbs_g: 0, confidence: 1, source: 'agent', partial: false },
    { id: 'i2', food_id: '00000000-0000-4000-8000-0000000000f2', name: 'Рис отварной', grams: 150, kcal: 277, protein_g: 4, fat_g: 5, carbs_g: 58, confidence: 1, source: 'agent', partial: false },
  ],
};
const today = {
  summary: {
    day: new Date().toISOString().slice(0, 10), isToday: true, trainingDay: false, goal,
    totals: { kcal: 560, protein_g: 62, fat_g: 9, carbs_g: 58, meals_count: 1, macros_incomplete: 0, satfat_g: null },
    remaining: { kcal_to_min: 1090, kcal_to_max: 1240, protein_to_min: 118, fat_to_min: 31 },
    status: { kcal: 'under', protein: 'under', belowFloor: true }, meals: [meal], challengeDay: null,
    profile: { timezone: 'Asia/Almaty', day_boundary_minutes: 240, training: { days: [1, 3, 5], start: '18:00', end: '19:30' }, display_name: 'Владелец' },
  },
  templates: [], coach: null, notification: null,
};

async function asMiniApp(page: Page): Promise<{ calls: () => Promise<string[]>; saved: unknown[] }> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    const w = window as unknown as { __tg: string[]; Telegram: unknown };
    w.__tg = calls;
    w.Telegram = {
      WebApp: {
        initData: `user=${encodeURIComponent(JSON.stringify({ id: 1001 }))}&auth_date=1&hash=${'0'.repeat(64)}`, version: '8.0', platform: 'ios', colorScheme: 'light',
        isVersionAtLeast: () => true, ready: () => calls.push('ready'), expand: () => calls.push('expand'), disableVerticalSwipes: () => calls.push('no-swipes'),
        setHeaderColor: (c: string) => calls.push(`header:${c}`), setBackgroundColor: (c: string) => calls.push(`bg:${c}`), setBottomBarColor: () => undefined,
        BackButton: { show: () => calls.push('back:show'), hide: () => calls.push('back:hide'), onClick: () => undefined, offClick: () => undefined },
        HapticFeedback: { impactOccurred: () => calls.push('haptic'), notificationOccurred: (t: string) => calls.push(`haptic:${t}`), selectionChanged: () => calls.push('haptic:selection') },
        openLink: (u: string) => calls.push(`open:${u}`), onEvent: () => undefined, offEvent: () => undefined,
      },
    };
  });
  const saved: unknown[] = [];
  const json = (route: Route, body: unknown) => route.fulfill({ json: body });
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/api/telegram/auth', (r) => json(r, { access_token: jwt(), refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  await page.route('**/auth/v1/user**', (r) => json(r, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T00:00:00Z' }));
  await page.route('**/api/today**', (r) => json(r, today));
  await page.route('**/api/meals', async (r) => { saved.push(r.request().postDataJSON()); await json(r, { meal: { id: 'new', kcal: 600 } }); });
  await page.route('**/api/providers', (r) => json(r, { chatgpt: { status: 'connected', updated_at: null }, models: { agent: 'gpt-6.1-sol' }, usage_7d: {} }));
  await page.route('**/api/health/google', (r) => json(r, { configured: true, status: 'none', last_sync_at: null, last_error: null, refresh_expires_at: null, scopes: [] }));
  await page.route('**/api/health/google/start', (r) => json(r, { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' }));
  await page.route('**/rest/v1/**', (r) => {
    const url = r.request().url();
    if (url.includes('/profiles')) return json(r, { display_name: 'Владелец', day_boundary_minutes: 240, quiet_start: '23:00:00', quiet_end: '08:00:00', training: { days: [1, 3, 5], start: '18:00', end: '19:30' }, max_proactive_per_day: 6, min_minutes_between_proactive: 90, telegram_linked_at: '2026-11-26T08:00:00Z', settings: {} });
    if (url.includes('/goals')) return json(r, [goal]);
    return json(r, []);
  });
  return { calls: () => page.evaluate(() => (window as unknown as { __tg: string[] }).__tg), saved };
}

test('three tabs, no chat, no «+», no checklist; the journal edits grams in place', async ({ page }) => {
  const app = await asMiniApp(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Основная навигация' });
  await expect(nav.getByRole('link')).toHaveText(['◐Сегодня', '▤Тело', '⋯Ещё']);
  await expect(nav.getByRole('link', { name: /Чат/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Записать еду' })).toHaveCount(0);
  await expect(page.getByText(/чек-лист/i)).toHaveCount(0);
  await expect(page.getByText('по плану')).toHaveCount(0);

  await page.getByRole('button', { name: /Обед/ }).click();
  await page.getByRole('button', { name: 'Изменить граммы' }).click();
  await page.getByLabel('Граммы: Куриная грудка').fill('300');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect.poll(() => app.saved.length).toBe(1);
  expect(app.saved[0]).toMatchObject({ supersedes_id: MEAL_ID, items: [{ name: 'Куриная грудка', grams: 300, edited: true }, { name: 'Рис отварной', grams: 150, edited: false }] });
  await expect.poll(app.calls).toEqual(expect.arrayContaining(['ready', 'expand', 'no-swipes', 'header:#efede4', 'bg:#efede4', 'back:hide', 'haptic:success']));
});

test('settings inside Telegram: BackButton, Google Health opens in the external browser, limits', async ({ page }) => {
  const app = await asMiniApp(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Браслет: Google Health' })).toBeVisible();
  await expect(page.getByText(/^привязан \d/)).toBeVisible();
  await expect(page.getByLabel('агент пишет в день, до')).toHaveValue('6');
  await page.getByRole('button', { name: 'Подключить Google Health' }).click();
  await expect.poll(app.calls).toEqual(expect.arrayContaining(['back:show', 'open:https://accounts.google.com/o/oauth2/v2/auth?client_id=test']));
});

test('«Ещё» keeps the old chat and log only as a fallback entry', async ({ page }) => {
  await asMiniApp(page);
  await page.goto('/more');
  await expect(page.getByText('запасной вход', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Старый чат/ })).toBeVisible();
});
