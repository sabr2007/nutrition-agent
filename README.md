# Рядом — личный AI-агент по питанию

**v2: живёт в Telegram.** Пишешь боту, что съел (текст, голос, фото, альбом, продукт на кухонных весах) — агент записывает приём, КБЖУ считает база продуктов, ответ приходит с карточкой и кнопками. Сам напоминает по контексту дня (с кнопками ✓ / ⏰ / 🔕), видит шаги, сон и тренировки с браслета (Google Health API), предупреждает о жирах и предлагает добор белка в граммах. День, тело и настройки — в Telegram Mini App. Все модели — на подписке ChatGPT.

**Прод:** https://ryadom-coach.vercel.app (личный инстанс, регистрация закрыта) · **Шаги владельца:** [`docs/BLOCKERS.md`](docs/BLOCKERS.md) · **Итог:** [`docs/SUMMARY.md`](docs/SUMMARY.md) · **Лицензия:** MIT

```
Telegram ──webhook──▶ Next.js 16 (Vercel fra1, Fluid) ── Supabase (Postgres 17 · Auth · Storage · pg_cron, Франкфурт)
   бот + Mini App        очередь апдейтов в Postgres, агент      append-only events, версии, RLS
                         ChatGPT plan (gpt-6.1-sol, web search) · Whisper (голос) · Google Health API · Open Food Facts
```

## Что внутри
| | |
|---|---|
| Бот | вебхук с секретом, идемпотентность по `update_id`, очередь на чат (аренда в Postgres), привязка кодом, чужим — отказ без модели; фото/альбомы/голос, живой стрим ответа (`sendMessageDraft`), Markdown → Telegram HTML, inline-кнопки (варианты, подтверждения, «Записать», ✓/⏰/🔕), `/today /week /deep /mute /help` |
| Подсчёт | модель только распознаёт; КБЖУ = граммы × значения базы (USDA SR Legacy с насыщенными жирами, российские таблицы, казахские блюда, личные продукты). Нет продукта — `lookup_product`: база → Open Food Facts → интернет (страница производителя, Атуотер), найденное сохраняется с ссылкой |
| Агент | `gpt-6.1-sol`, effort выбирает код; ~25 инструментов (еда, правка своей записи, продукты, вес, активность, память, напоминания, рецепты…); проверки жиров и ранжирование по белку на 100 ккал — код, не модель; память и навыки с версиями, трейсы, safety-слой; eval-сценарии в проде (21/21) |
| Проактивность | правила-данные (DSL) + pg_cron каждые 5 минут → Telegram с кнопками; лимиты (≤ 6 в день, пауза ≥ 90 мин, молчание после 3 без ответа, тихие часы, `/mute`, «Не сегодня»); правила: утро после сна, белок к 15:00, шаги к 18:00, после тренировки, 5 часов без еды, вечер, неделя |
| Браслет | Google Health API: шаги, калории, пульс покоя, сон с фазами, тренировки; OAuth во внешнем браузере, опрос раз в 15 минут; запасной путь — Apple «Команды» |
| Mini App | Сегодня · Тело · Ещё; вход по `initData` (HMAC) → обычная сессия владельца; журнал правится на месте; «Сегодня» — 146 KB JS, знакомый день без экрана загрузки |
| Данные | журнал событий, версии приёмов, сырые входы и ответы моделей, экспорт ZIP/CSV и Parquet |

Подробно: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), решения — [`docs/DECISIONS.md`](docs/DECISIONS.md) (v2 — D24–D31), производительность — [`docs/PERF.md`](docs/PERF.md), eval — [`docs/research/agent-evals.md`](docs/research/agent-evals.md), исследования — [`docs/research/`](docs/research).

## Деплой
- `main` → прод на Vercel автоматически, ветки → превью (за Vercel Authentication). Функции — в `fra1`, рядом с базой (`vercel.json`).
- Миграции: `supabase/migrations/*` — `scripts/bootstrap-prod.sh` (`supabase db push`) или CI-джоб `migrate`. Ручных правок прода нет.
- Секреты — только в Vercel env и Supabase Vault; шаблон — [`.env.example`](.env.example). Бот: `node --env-file=.env.local --import tsx scripts/telegram-setup.ts` ставит вебхук, команды и кнопку меню (Mini App).
- Личные данные (цифры тела, распорядок, цели, шаблоны, правила, стартовая память) — только в `scripts/personal-seed.json` (gitignored); формат — [`scripts/personal-seed.example.json`](scripts/personal-seed.example.json).

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
| `pnpm typecheck` / `pnpm test` | типы / unit и интеграционные тесты: КБЖУ, гейт релевантности продуктов, жиры и белок, бот (синтетические апдейты Telegram с моком Bot API), `initData`, лимиты проактивности с подменой времени, парсинг Google Health |
| `pnpm test:e2e` | Playwright; `tests/e2e/mini-app.spec.ts` — Mini App с подставленным `Telegram.WebApp` и замоканным API (можно против прода: `E2E_BASE_URL=…`) |
| `POST /api/providers/chatgpt/check {"agent": true}` | eval-сценарии агента в проде в dry-run (cron-секрет) |
| `POST /api/cron/tick {"preview": true, "at": "15:30"}` | какие напоминания сработали бы в это время — без отправки и записи |
| `uv run scripts/export.py` | выгрузка всех таблиц в Parquet + CSV (`DATABASE_URL`) |

Структура: `src/lib/{telegram,agent,health,reminders,recognition,nutrition,data,llm,foods}`, Mini App — `src/app/(app)/*` и `src/components/*`, API — `src/app/api/*`, дизайн-токены — `src/app/globals.css`.
