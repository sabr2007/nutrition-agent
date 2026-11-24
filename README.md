# Рядом — личный AI-агент по питанию

PWA для iPhone: чат как в ChatGPT (текст, фото, голос), где агент сам записывает еду, вес и отметки в твой день; шаблоны в один тап, штрихкод и этикетки; честный подсчёт КБЖУ по базе продуктов; агент с памятью и инструментами, который сам пишет по контексту дня. Все модели — на подписке ChatGPT.

**Прод:** https://ryadom-coach.vercel.app (личный инстанс, регистрация закрыта) · **Статус:** [`docs/BLOCKERS.md`](docs/BLOCKERS.md) · **Итог первой сессии:** [`docs/SUMMARY.md`](docs/SUMMARY.md) · **Лицензия:** MIT

```
Next.js 16 (Vercel, Fluid) ── Supabase (Postgres 17 · Auth · Storage · pg_cron) ── ChatGPT plan
   PWA + service worker          append-only events, versions, RLS                 (одна модель на задачу; голос — Whisper)
```

## Что внутри
| | |
|---|---|
| Ввод | чат как в ChatGPT: «+» → камера / фото / навыки / «думать дольше», миниатюры с крестиком, микрофон с волной и ■/↑; агент видит фото и сам пишет в день; плюс шаблоны в 1 тап, «сейчас по плану», текст (быстрый парсер без LLM + модель), фото, режим весов, штрихкод (Open Food Facts), этикетка, повтор, задним числом |
| Подсчёт | модель только распознаёт; КБЖУ = граммы × значения базы (192 продукта: USDA SR Legacy, российские таблицы, казахские блюда с диапазонами), сырой ↔ готовый вес |
| Агент | 22 типизированных инструмента (еда, вес, чек-лист, этикетка → свой продукт, память, напоминания…), стрим ответа, многоуровневая память (видна и редактируется), навыки с версиями, трейсы каждого запуска, подтверждение опасных действий, safety-слой |
| Проактивность | правила-данные (DSL), pg_cron каждые 5 минут, тихие часы, кулдауны, лимиты для сообщений агента, Declarative Web Push |
| Данные | журнал событий, версии приёмов, сырые входы и полные ответы моделей, правки модели → персональная калибровка, экспорт ZIP/CSV и Parquet |
| Eval | сценарии агента (локально или в проде в dry-run через `/api/providers/chatgpt/check`) — [`docs/research/agent-evals.md`](docs/research/agent-evals.md); история eval фото — [`docs/research/eval-results.md`](docs/research/eval-results.md) |

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
| `pnpm test:e2e` | Playwright: таб-бар «Чат»; чат: фото → миниатюра → стрим ответа → карточка «в дневнике», «Думать дольше», ошибка → «Повторить», голос (фейковый микрофон) → текст в поле; шаблон в 1 тап; этикетка вручную (`E2E_EMAIL`, `E2E_PASSWORD`, `E2E_BASE_URL` для dev-сервера) |
| `pnpm eval:agent <email> <password-file>` | 11 сценариев агента с проверками инструментов и безопасности (нужна база с подключённым ChatGPT) |
| `uv run scripts/export.py` | выгрузка всех таблиц в Parquet + CSV (`DATABASE_URL`) |

Структура: `src/lib/{nutrition,data,recognition,llm,agent,chat,reminders,push,offline}`, экраны — `src/app/(app)/*`, чат — `src/components/chat/*`, API — `src/app/api/*`, дизайн-токены — `src/app/globals.css`.
