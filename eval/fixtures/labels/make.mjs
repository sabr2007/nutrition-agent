// Renders synthetic nutrition-label photos for eval/label-eval.ts (Playwright Chromium).
//   node eval/fixtures/labels/make.mjs
// Brands are fictional; values are realistic and consistent with Atwater factors.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const css = `
  body { margin: 0; background: #d9d4c7; font-family: Arial, Helvetica, sans-serif; }
  .pack { width: 760px; margin: 40px; padding: 28px 32px; background: #fbf8ef; color: #1d1a16; border-radius: 6px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
  h1 { font-size: 30px; margin: 0 0 6px; } .brand { font-size: 18px; color: #6b5b3e; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 21px; } td, th { border: 1.5px solid #1d1a16; padding: 6px 10px; text-align: left; }
  th { background: #ece5d3; } .small { font-size: 15px; line-height: 1.35; } .net { margin-top: 14px; font-size: 20px; font-weight: bold; }
`;
const fixtures = {
  'table-100g': `<div class="pack"><h1>Хлопья овсяные «Утро»</h1><div class="brand">ТОО «Зерно Степи»</div>
    <table><tr><th colspan="2">Пищевая ценность на 100 г продукта</th></tr>
    <tr><td>Белки</td><td>11,9 г</td></tr><tr><td>Жиры</td><td>7,2 г</td></tr><tr><td>Углеводы</td><td>60,5 г</td></tr>
    <tr><td>Пищевые волокна</td><td>9,1 г</td></tr><tr><td>Энергетическая ценность</td><td>355 ккал / 1486 кДж</td></tr></table>
    <div class="net">Масса нетто: 400 г</div></div>`,
  'paragraph-eaeu': `<div class="pack"><h1>Крупа гречневая ядрица</h1><div class="brand">«Алтын Дән»</div>
    <p class="small">Состав: крупа гречневая ядрица, первый сорт. Пищевая ценность в 100 г продукта: белки – 12,6 г, жиры – 3,3 г,
    углеводы – 57,1 г. Энергетическая ценность (калорийность) – 1293 кДж/308 ккал. Способ приготовления: 1 стакан крупы залить
    2 стаканами кипящей подсоленной воды, варить 20 минут. Хранить в сухом месте при температуре не выше +25 °С и относительной
    влажности не более 70%. Срок годности 18 месяцев. Изготовитель: ТОО «Алтын Дән», Республика Казахстан.</p>
    <div class="net">Масса нетто: 800 г</div></div>`,
  'per-serving': `<div class="pack"><h1>Гранола с орехами</h1><div class="brand">«Crunchy Day»</div>
    <table><tr><th>Пищевая ценность</th><th>на 100 г</th><th>на порцию 30 г</th></tr>
    <tr><td>Энергетическая ценность</td><td>450 ккал</td><td>135 ккал</td></tr><tr><td>Белки</td><td>9 г</td><td>2,7 г</td></tr>
    <tr><td>Жиры</td><td>18 г</td><td>5,4 г</td></tr><tr><td>Углеводы</td><td>62 г</td><td>18,6 г</td></tr></table>
    <div class="net">Масса нетто: 350 г · готово к употреблению</div></div>`,
  'per-serving-only': `<div class="pack"><h1>Протеиновый батончик «Кокос»</h1><div class="brand">«FitBar»</div>
    <p class="small" style="font-size:19px">Пищевая и энергетическая ценность в 1 батончике (60 г): белки — 20 г, жиры — 7 г,
    углеводы — 18 г, в т.ч. сахара — 2 г. Энергетическая ценность — 215 ккал.</p><div class="net">Масса нетто: 60 г</div></div>`,
  'milk-ml': `<div class="pack"><h1>Молоко питьевое 2,5%</h1><div class="brand">«Сүт Әлемі»</div>
    <p class="small" style="font-size:19px">Пищевая ценность в 100 мл: белки 3,0 г, жиры 2,5 г, углеводы 4,7 г.
    Энергетическая ценность 52 ккал/218 кДж.</p><div class="net">Объём: 1 л</div></div>`,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 860, height: 760 }, deviceScaleFactor: 1.6 });
for (const [name, body] of Object.entries(fixtures)) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`);
  const box = await page.locator('.pack').boundingBox();
  const clip = { x: 0, y: 0, width: 860, height: Math.ceil((box?.y ?? 0) + (box?.height ?? 600) + 40) };
  writeFileSync(path.join(dir, `${name}.jpg`), await page.screenshot({ type: 'jpeg', quality: 85, clip }));
}
// A phone-photo look: rotate/blur the rendered label as an image (transforms on a live
// table misplace its cells in Chromium), plus uneven light and glare.
const { readFileSync } = await import('node:fs');
const clean = readFileSync(path.join(dir, 'table-100g.jpg')).toString('base64');
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: radial-gradient(circle at 30% 20%, #e8e2d2, #8f8778); }
  img { width: 760px; margin: 70px 40px; transform: rotate(-4deg); filter: blur(0.8px) contrast(0.88) brightness(0.97); box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  .glare { position: fixed; inset: 0; background: linear-gradient(115deg, rgba(255,255,255,0) 40%, rgba(255,255,255,.35) 52%, rgba(255,255,255,0) 64%); }
</style><img src="data:image/jpeg;base64,${clean}"><div class="glare"></div>`);
writeFileSync(path.join(dir, 'photo-skewed.jpg'), await page.screenshot({ type: 'jpeg', quality: 80 }));
await browser.close();
console.log('labels rendered');
