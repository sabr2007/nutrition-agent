import path from 'node:path';
import { expect, test } from '@playwright/test';
import { email, fakeAgent, login, password } from './chat-helpers';

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not set');

const photo = path.join(process.cwd(), 'eval', 'fixtures', 'labels', 'table-100g.jpg');

test('tab bar says «Чат» and hides itself inside the chat', async ({ page }) => {
  await login(page);
  const nav = page.getByRole('navigation', { name: 'Основная навигация' });
  await expect(nav.getByRole('link', { name: /Чат/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Коуч/ })).toHaveCount(0);
  const plus = await page.getByRole('link', { name: 'Записать еду' }).boundingBox();
  expect(plus!.height).toBeLessThanOrEqual(48);
  await nav.getByRole('link', { name: /Чат/ }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toHaveCount(0);
  await expect(page.getByLabel('Сообщение')).toBeVisible();
});

test('photo + caption → thumbnail with ×, streamed reply, meal card in the day', async ({ page }) => {
  const agent = await fakeAgent(page, () => ({
    events: [{ t: 'tool', name: 'log_meal', label: 'Записываю приём' }, { t: 'text', d: 'Записал обед: ' }, { t: 'text', d: '**каша** ~350 ккал.' }],
    text: 'Записал обед: **каша** ~350 ккал.',
    meta: { logged_meals: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Каша овсяная', kcal: 350, protein_g: 12 }], actions: [{ kind: 'checklist', text: '✓ Обед' }] },
  }));
  await login(page);
  await page.goto('/chat');

  // "+" opens the ChatGPT-style menu; "Фото" opens the same picker as this input.
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByRole('menuitem', { name: 'Камера' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Фото' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('input[aria-label="Выбрать фото"]').setInputFiles([photo, photo]);
  const strip = page.getByRole('list', { name: 'Вложения' });
  await expect(strip.getByRole('img')).toHaveCount(2);
  await strip.getByRole('button', { name: 'Убрать фото' }).last().click();
  await expect(strip.getByRole('img')).toHaveCount(1);

  await page.getByLabel('Сообщение').fill('это мой обед');
  const send = page.getByRole('button', { name: 'Отправить' });
  await expect(send).toBeEnabled(); // upload to the private bucket finished
  await send.click();

  await expect(page.getByText('это мой обед')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Фото' })).toBeVisible();
  await expect(page.getByText('Каша овсяная')).toBeVisible();
  await expect(page.getByText('✓ Обед')).toBeVisible();
  expect(agent.requests[0].media_ids).toHaveLength(1);
  expect(agent.requests[0].text).toBe('это мой обед');
});

test('«Думать дольше» is a toggle with a chip, sent with the message', async ({ page }) => {
  const agent = await fakeAgent(page, () => ({ events: [{ t: 'text', d: 'План готов.' }], text: 'План готов.' }));
  await login(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Думать дольше' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Думать дольше' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Выключить «Думать дольше»' })).toBeVisible();
  await page.getByLabel('Сообщение').fill('составь план на завтра');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('План готов.')).toBeVisible();
  expect(agent.requests[0].deep).toBe(true);
  await page.getByRole('button', { name: 'Выключить «Думать дольше»' }).click();
  await expect(page.getByRole('button', { name: 'Выключить «Думать дольше»' })).toHaveCount(0);
});

test('a failed answer keeps the message with «Повторить»', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { messages: [] } });
    calls++;
    const body = calls === 1
      ? '{"t":"error","message":"Лимит подписки ChatGPT сейчас исчерпан."}\n'
      : `{"t":"done","message":{"id":"a1","role":"assistant","kind":"chat","text":"Теперь получилось.","created_at":"${new Date().toISOString()}"},"user":null}\n`;
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
  });
  await login(page);
  await page.goto('/chat');
  await page.getByLabel('Сообщение').fill('что съесть?');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('Лимит подписки ChatGPT сейчас исчерпан.')).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByText('Теперь получилось.')).toBeVisible();
});
