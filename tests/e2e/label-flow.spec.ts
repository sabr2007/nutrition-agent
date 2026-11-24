import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const email = process.env.E2E_EMAIL ?? '';
const password = process.env.E2E_PASSWORD ?? '';

test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not set');

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('почта').fill(email);
  await page.getByLabel('пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('ккал', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Записать еду' }).click();
}

test('label typed by hand → personal food → breakfast entry', async ({ page }) => {
  const name = `Каша тест ${Date.now().toString(36)}`;
  await login(page);
  await page.getByRole('button', { name: 'поиск продукта' }).click();
  await page.getByRole('textbox', { name: 'Поиск продукта' }).fill(name);
  await page.getByRole('button', { name: /свой продукт по этикетке/ }).click();
  await page.getByLabel('ккал на 100 г').fill('355');
  await page.getByLabel('белки на 100 г').fill('11,9');
  await page.getByLabel('жиры на 100 г').fill('7,2');
  await page.getByLabel('углев. на 100 г').fill('60,5');
  await page.getByRole('radio', { name: 'сухой' }).click();
  await page.getByRole('button', { name: '40 г', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить · 40 г · 142 ккал' }).click();

  await expect(page.getByLabel(`Граммы: ${name}`)).toHaveValue('40');
  await page.getByRole('radio', { name: 'Завтрак' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(/Записал · 142 ккал/)).toBeVisible();
  await expect(page.locator('ol').getByText(name).first()).toBeVisible();
});

test('photo of a label → numbers filled by the model → saved', async ({ page }) => {
  test.skip(process.env.E2E_LLM !== '1', 'needs a live vision model (E2E_LLM=1)');
  test.setTimeout(150_000);
  await login(page);
  await page.locator('input[aria-label="Фото этикетки"]').setInputFiles(path.join(process.cwd(), 'eval', 'fixtures', 'labels', 'table-100g.jpg'));
  await expect(page.getByLabel('ккал на 100 г')).toHaveValue('355', { timeout: 120_000 });
  await expect(page.getByLabel('белки на 100 г')).toHaveValue('11.9');
  await expect(page.getByLabel('Название продукта')).toHaveValue(/Хлопья овсяные/);
  await expect(page.getByRole('radio', { name: 'сухой' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /^Добавить · 40 г/ }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(/Записал · 142 ккал/)).toBeVisible();
});
