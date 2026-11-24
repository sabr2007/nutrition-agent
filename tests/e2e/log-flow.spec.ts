import { expect, test } from '@playwright/test';

const email = process.env.E2E_EMAIL ?? '';
const password = process.env.E2E_PASSWORD ?? '';

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not set');

test('login → log a template in one tap → it appears on Today', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('почта').fill(email);
  await page.getByLabel('пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('ккал', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Записать еду' }).click();
  await expect(page.getByRole('heading', { name: 'Шаблоны' })).toBeVisible();
  const started = Date.now();
  await page.getByRole('button', { name: /Протеин/ }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/Протеин[^·]* · \d+ ккал/).first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5000); // "≤ 5 seconds" product requirement
  await expect(page.getByRole('heading', { name: 'Журнал' })).toBeVisible();
  await expect(page.locator('ol').getByText(/Протеин/).first()).toBeVisible();
});

test('text → confirmation screen → save', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('почта').fill(email);
  await page.getByLabel('пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('ккал', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Записать еду' }).click();
  await page.getByLabel('Что съел').fill('творог 200');
  await page.getByRole('button', { name: 'Разобрать' }).click();
  await expect(page.getByLabel(/Граммы: Творог/)).toHaveValue('200');
  await page.getByRole('button', { name: 'Больше на 10 г' }).first().click();
  await expect(page.getByLabel(/Граммы: Творог/)).toHaveValue('210');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(/Записал · \d+ ккал/)).toBeVisible();
});
