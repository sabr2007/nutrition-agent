import { expect, test } from '@playwright/test';
import { email, login, password } from './chat-helpers';

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not set');

// Chromium's fake microphone plays a beep, enough for MediaRecorder and the level meter.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

test('mic → recording bar with ×, waveform, ■ and ↑ → transcript lands in the field', async ({ page }) => {
  await page.route('**/api/transcribe', (route) => route.fulfill({ json: { text: 'съел 200 г творога' } }));
  await login(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Сказать голосом' }).click();
  const bar = page.getByRole('group', { name: 'Идёт запись голоса' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Отменить запись' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Отправить голосом' })).toBeVisible();
  await page.waitForTimeout(1500);
  await bar.getByRole('button', { name: 'Остановить и вставить текст' }).click();
  await expect(page.getByLabel('Сообщение')).toHaveValue('съел 200 г творога');
});

test('× cancels the recording without transcribing', async ({ page }) => {
  let transcribed = false;
  await page.route('**/api/transcribe', (route) => { transcribed = true; return route.fulfill({ json: { text: 'x' } }); });
  await login(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Сказать голосом' }).click();
  await page.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(page.getByLabel('Сообщение')).toHaveValue('');
  expect(transcribed).toBe(false);
});
