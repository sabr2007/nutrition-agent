# Установка и настройка

## Что уже настроено
| Что | Где | Статус |
|---|---|---|
| Репозиторий | github.com/sabr2007/nutrition-agent (public, MIT); старая история — приватный архив `nutrition-agent-private` | ✓ |
| Vercel-проект `ryadom` | автодеплой `main` → прод, ветки → превью | ✓ |
| Прод-URL | https://ryadom-coach.vercel.app (алиас `ryadom-delta.vercel.app`) | ✓ |
| Supabase | проект `ryadom-nutrition` (eu-central-1): миграции v1 + v2 (`20261126000100`–`0700`), регистрация закрыта, cron каждые 5 минут, секреты cron в Vault | ✓ |
| Регион функций | `fra1` рядом с базой (`vercel.json`) | ✓ |
| Telegram-бот | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_PAIRING_CODE` в Vercel env; вебхук, команды и кнопка меню (Mini App) поставлены — §7 | ✓ (привязка — шаг владельца) |
| Google Health | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` в Vercel env — §8 | 🟡 консоль Google — шаг владельца |
| Аккаунт владельца | создан через Admin API, личный план из `scripts/personal-seed.json` | ✓ |
| Vercel env (prod + preview) | Supabase URL/ключи, VAPID, CRON_SECRET, APP_ENCRYPTION_KEY, APP_URL, CLOUDFLARE_* (только голос). Старые `LLM_PROVIDER_ORDER`, `LLM_DISABLE_GATEWAY`, `RECOGNITION_SAMPLES`, `CHATGPT_PLAN_ENABLED` код больше не читает — их можно удалить | ✓ |
| Cloudflare API-токен | только Workers AI (расшифровка голоса), имя «ryadom-nutrition-agent (Workers AI)» | ✓ |
| GitHub Actions | секреты `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | ✓ |
| ChatGPT plan | подключён 24.11, единственный провайдер моделей — см. §3 | ✓ |

## 1. Прод-база (уже поднята; для повторного запуска или нового окружения)
```bash
./scripts/bootstrap-prod.sh ЛОГИН
```
Нужны залогиненные `supabase` и `vercel` CLI. Скрипт идемпотентен: найдёт проект, применит недостающие миграции, обновит секреты cron и ключи в Vercel, передеплоит. Пароль владельца печатается один раз только при создании аккаунта. Сбросить пароль: `scripts/create-user.ts --email ЛОГИН --reset-password` (с ключами прод-окружения).

`ЛОГИН` в командах — логин от приложения (тот, которым входишь в «Рядом»), без кавычек и скобок.

**Личный план.** Цели, шаблоны (`done_key` — какое напоминание закрывает шаблон), правила напоминаний, распорядок, цифры тела и стартовая память — в `scripts/personal-seed.json` (gitignored). Формат — `scripts/personal-seed.example.json`. Разделы плана, которых нет в личном файле, берутся из примера; профиль и память — никогда. Сид применяется один раз при создании аккаунта и не перезаписывает существующие строки; дальше всё правится в приложении («Настройки», «Память») или агентом.

## 2. Установить на iPhone
1. Открой https://ryadom-coach.vercel.app в Safari, войди.
2. Поделиться → «На экран "Домой"». Дальше открывай только с иконки: у PWA своё хранилище, вход нужен один раз.
3. На «Сегодня» нажми «Включить» напоминания (iOS требует нажатие в установленном приложении). В «Настройках» есть «Тест».
4. Микрофон: iOS может спрашивать разрешение при каждом запуске PWA (известная ошибка WebKit).

## 3. ChatGPT plan («Войти через ChatGPT»)
Официально self-serve доступен для open-source и локальных приложений (`docs/research/chatgpt-oauth.md`). Репозиторий уже публичный под MIT.
1. Отправь форму https://openai.com/form/sign-in-with-chatgpt-interest/ (вариант «Sign in and ChatGPT plan use for AI requests», ссылка на репозиторий). Это подтверждение, что хостинг на Vercel для личного OSS-приложения допустим.
2. Скачай публичные переменные прод-окружения (файл gitignored; секретные значения Vercel всё равно не отдаёт, они и не нужны):
   ```bash
   vercel env pull .env.production.local --environment=production
   ```
3. Запусти вход. Скрипт спросит пароль от «Рядом» (ввод скрыт), затем напечатает ссылку на auth.openai.com; ответ придёт на `127.0.0.1:1455`:
   ```bash
   node --env-file=.env.production.local --import tsx scripts/chatgpt-login.ts --email ЛОГИН
   ```
   `--email` — логин от «Рядом», а не почта ChatGPT. Токены уходят на сервер «Рядом» под твоим входом; сервер шифрует их своим ключом.
   Перед ссылкой скрипт проверяет, что сервер принимает вход и может хранить токены. Если отправка всё же сорвётся, токены остаются в памяти процесса, и Enter повторяет её без нового входа в ChatGPT. Адрес сервера берётся из `--app-url`, затем из `APP_URL`, иначе прод; заглушки `[SENSITIVE]` из `vercel env pull` пропускаются.
4. Отдельно включать ничего не нужно: как только вход сохранён, все модели идут через план (флаг `CHATGPT_PLAN_ENABLED` больше не используется).
5. Поставь недельный лимит для приложения: ChatGPT → Settings → Usage.

Запасных провайдеров нет (решение D22): при исчерпании лимита (`429 subscription_sharing_usage_limit_exceeded`) чат и фото отвечают «лимит исчерпан», ручная запись и шаблоны работают. Проверка подключения и моделей: `POST /api/providers/chatgpt/check` (под своим входом), с телом `{"agent": true}` — ещё и сценарии агента в dry-run. Выданный OpenAI `client_id` хранится в `scripts/.chatgpt-client.json` (gitignored) и используется при следующих входах.

## 4. Локальная разработка
```bash
pnpm install
colima start            # или Docker Desktop
supabase start -x studio,imgproxy,mailpit,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta
cp .env.example .env.local   # заполнить ключами из `supabase status -o env`
pnpm user:create --email dev@local.test --seed scripts/personal-seed.example.json
pnpm dev
```
Тесты: `pnpm test` (unit), `pnpm test:e2e` (Playwright, нужен локальный стек и `E2E_EMAIL`/`E2E_PASSWORD`), eval: см. README.

## 5. Модели и стоимость
- Все модели — на подписке ChatGPT, одна модель на задачу (`src/lib/llm/models.ts`): чат и агент — `gpt-6-luna`, «Думать дольше» — `gpt-6.1-sol`, фото и этикетки — `gpt-6.1-terra`, разбор текста и тексты пушей — `gpt-6-luna`. Доплаты нет, расходуется лимит подписки; поставь недельный лимит для приложения в ChatGPT → Settings → Usage.
- Голос — Whisper на Cloudflare Workers AI, бесплатно в дневной квоте.
- Вызовы за 7 дней по моделям — «Настройки → Модели» (стоимость показана по прайсу API, фактически платится подпиской).

## 6. Экспорт данных
- В приложении: «Настройки → Экспорт» (ZIP с CSV всех таблиц).
- Parquet для анализа: `DATABASE_URL=... uv run scripts/export.py` (строка подключения — Supabase Dashboard → Connect → Session pooler).

## 7. Telegram-бот и Mini App (v2)
1. Бот создаётся в @BotFather; токен → `TELEGRAM_BOT_TOKEN` в Vercel env (production + preview). `TELEGRAM_WEBHOOK_SECRET` (1–256 символов `A-Za-z0-9_-`) и `TELEGRAM_PAIRING_CODE` — сгенерировать, положить в Vercel env и в свой `.env.local` (в репозиторий — никогда).
2. Вебхук, команды и кнопка меню (открывает Mini App на прод-URL):
```bash
node --env-file=.env.local --import tsx scripts/telegram-setup.ts
```
Скрипт идемпотентный: `setWebhook` с секретом и `allowed_updates: [message, callback_query]`, `setMyCommands`, `setChatMenuButton`, затем `getWebhookInfo` для проверки.
3. Привязка: написать боту `/start <код>`. Код одноразовый (в базе — только хеш); после привязки бот отвечает только этому Telegram-аккаунту, остальным — короткий отказ без вызова модели.
4. Mini App открывается кнопкой меню; вход — по `initData` (подпись Telegram), отдельного пароля не нужно. Вне Telegram — прежний вход по паролю.

## 8. Браслет: Google Health API
Fitbit Web API отключён 02.11.2026 — только Google Health API. В Google Cloud Console (проект с OAuth-клиентом): включить Google Health API; в Data Access добавить scopes `googlehealth.activity_and_fitness.readonly`, `googlehealth.health_metrics_and_measurements.readonly`, `googlehealth.sleep.readonly`, `googlehealth.settings.readonly`; redirect URI `https://<прод>/api/health/google/callback`. В режиме Testing refresh-токен живёт 7 дней (Publish app → In production снимает ограничение для < 100 пользователей). На телефоне — приложение Google Health под тем же аккаунтом. Подключение — Mini App → «Ещё» → «Настройки» → «Браслет: Google Health» (откроется внешний браузер: Google не пускает OAuth во встроенные webview). Дальше синк раз в 15 минут из cron-тика.
