# Рядом — личный AI-агент по питанию

PWA для iPhone: запись еды за пару секунд (шаблоны в один тап, текст, фото, «на весах», голос, штрихкод), честный подсчёт КБЖУ по базе продуктов, агент с памятью и инструментами, который сам пишет по контексту дня.

**Прод:** https://ryadom-coach.vercel.app (личный инстанс, регистрация закрыта) · **Статус:** [`docs/BLOCKERS.md`](docs/BLOCKERS.md) · **Итог первой сессии:** [`docs/SUMMARY.md`](docs/SUMMARY.md) · **Лицензия:** MIT

```
Next.js 16 (Vercel, Fluid) ── Supabase (Postgres 17 · Auth · Storage · pg_cron) ── LLM router
   PWA + service worker          append-only events, versions, RLS                 Workers AI (основной) · ChatGPT plan · AI Gateway · OpenAI
```

## Что внутри
| | |
|---|---|
| Ввод | шаблоны в 1 тап с отменой, «сейчас по плану», текст (быстрый парсер без LLM + LLM), фото (камера или галерея) с self-consistency, режим весов, голос → транскрипция, штрихкод (Open Food Facts), этикетка (фото КБЖУ → свой продукт), повтор, задним числом |
| Подсчёт | модель только распознаёт; КБЖУ = граммы × значения базы (192 продукта: USDA SR Legacy, российские таблицы, казахские блюда с диапазонами), сырой ↔ готовый вес |
| Агент | 21 типизированный инструмент, многоуровневая память (видна и редактируется), навыки с версиями, трейсы каждого запуска, подтверждение опасных действий, safety-слой |
| Проактивность | правила-данные (DSL), pg_cron каждые 5 минут, тихие часы, кулдауны, лимиты для сообщений агента, Declarative Web Push |
| Данные | журнал событий, версии приёмов, сырые входы и полные ответы моделей, правки модели → персональная калибровка, экспорт ZIP/CSV и Parquet |
| Eval | точность фото (Nutrition5k, размеченные приёмы), сценарии агента — [`docs/research/eval-results.md`](docs/research/eval-results.md), [`docs/research/agent-evals.md`](docs/research/agent-evals.md) |

Подробно: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), решения — [`docs/DECISIONS.md`](docs/DECISIONS.md), исследования — [`docs/research/`](docs/research).

## Деплой
- `main` → прод на Vercel автоматически (GitHub-интеграция), ветки → превью.
- Миграции: `supabase/migrations/*`, применяются `scripts/bootstrap-prod.sh` (первый раз) и CI-джобом `migrate` (когда заданы секреты `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`).
- Секреты только в Vercel env и Supabase Vault; шаблон — [`.env.example`](.env.example).
- Первый запуск прод-базы: `./scripts/bootstrap-prod.sh you@example.com` (см. [`docs/SETUP.md`](docs/SETUP.md)).
- Личные данные (цифры тела, распорядок, цели, шаблоны, правила напоминаний, стартовая память) — только в `scripts/personal-seed.json` (gitignored); формат — [`scripts/personal-seed.example.json`](scripts/personal-seed.example.json).

## Разработка
```bash
pnpm install
colima start && supabase start -x studio,imgproxy,mailpit,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta
cp .env.example .env.local        # ключи: supabase status -o env
pnpm user:create --email dev@local.test --seed scripts/personal-seed.example.json
pnpm dev
```
| Команда | Что |
|---|---|
| `pnpm typecheck` / `pnpm test` | типы / unit-тесты (КБЖУ, граница дня, DSL напоминаний, агрегация, сопоставление) |
| `pnpm test:e2e` | Playwright: вход → шаблон в 1 тап (<5 с) → «Сегодня»; текст → подтверждение → сохранение (`E2E_EMAIL`, `E2E_PASSWORD`) |
| `pnpm eval:photo --source n5k --n 20 --models <ids>` | точность фото на Nutrition5k; `--source labeled` — на твоих размеченных приёмах |
| `pnpm eval:agent <email> <password-file>` | 10 сценариев агента с проверками инструментов и безопасности |
| `pnpm eval:label` | чтение этикеток: 6 синтетических фото (`eval/fixtures/labels`), точное совпадение цифр |
| `uv run scripts/export.py` | выгрузка всех таблиц в Parquet + CSV (`DATABASE_URL`) |

Структура: `src/lib/{nutrition,data,recognition,llm,agent,reminders,push,offline}`, экраны — `src/app/(app)/*`, API — `src/app/api/*`, дизайн-токены — `src/app/globals.css`.
