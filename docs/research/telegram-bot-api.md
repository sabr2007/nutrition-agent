# Telegram Bot API и Mini Apps — что важно для v2

Проверено по живой документации 26.11.2026 (Bot API 10.5 от 22.11.2026). Ссылки: `api` = https://core.telegram.org/bots/api, `wa` = https://core.telegram.org/bots/webapps, `cl` = https://core.telegram.org/bots/api-changelog, FAQ = https://core.telegram.org/bots/faq.

## Стрим ответа
- **`sendMessageDraft`** (`api#sendmessagedraft`, добавлен в 9.3, с 9.5 доступен всем ботам): `chat_id` (только личный чат), `draft_id` (ненулевой; правки с тем же id анимируются), `text` (0–4096 после разбора; пустой — плейсхолдер «Thinking…», с 10.0), `parse_mode`, `entities`, `can_stop`/`keep_on_stop` (10.3). Черновик эфемерный (~30 с) — итог нужно отправить обычным `sendMessage`. Кнопка «Стоп» присылает апдейт `stopped_message_generation` (входит в `allowed_updates` по умолчанию; при явном списке добавить самому). Лимит частоты обновлений черновика в доках не указан.
- Запасной путь — плейсхолдер + `editMessageText` (1–4096 символов). Отдельного лимита на правки нет; общий — ~1 сообщение/с на чат.
- `sendChatAction` держится ≤ 5 с, пропадает, когда приходит сообщение бота.

## Вебхук
- `setWebhook`: `url` (HTTPS, порты 443/80/88/8443), `secret_token` 1–256 символов `A-Za-z0-9_-`, `allowed_updates`, `drop_pending_updates`, `max_connections` 1–100 (по умолчанию 40).
- Секрет приходит в заголовке `X-Telegram-Bot-Api-Secret-Token`. На не-2xx Telegram повторяет «разумное число раз»; необработанные апдейты хранятся ≤ 24 ч. **Редиректы не поддерживаются** — URL вебхука без слэша на конце и без www-редиректа.
- `getWebhookInfo`: `url`, `pending_update_count`, `last_error_date`, `last_error_message`, `max_connections`, `allowed_updates`.
- `setMyCommands`: ≤ 100 команд, `command` 1–32 символа `[a-z0-9_]`, `description` 1–256. `setChatMenuButton` с `MenuButtonWebApp {type:'web_app', text, web_app:{url}}`.

## initData (вход в Mini App)
- Строка проверки: все поля, кроме `hash`, отсортированы по ключу, `key=value` через `\n`. `secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)`; `hex(HMAC_SHA256(key=secret_key, msg=data_check_string)) == hash`. Поле `signature` в строку **входит** (исключается только `hash`); проверять на реальной строке.
- `auth_date` — Unix-время открытия; максимальный возраст доки не задают (берём 24 ч).
- Сторонняя проверка Ed25519 (`signature`, строка `<bot_id>:WebAppData\n…` без `hash` и `signature`) — нам не нужна.
- Поля: `query_id`, `user` (JSON), `receiver`, `chat`, `chat_type`, `chat_instance`, `start_param`, `can_send_after`, `auth_date`, `hash`, `signature`.

## Mini App SDK
- Скрипт `https://telegram.org/js/telegram-web-app.js?65` (официального npm-пакета нет; типы — `@types/telegram-web-app`, сообщество — `@tma.js/sdk`).
- `ready()`, `expand()`, `disableVerticalSwipes()` (7.7+), `setHeaderColor`/`setBackgroundColor` (6.1+, `#RRGGBB` или `bg_color`/`secondary_bg_color`), `setBottomBarColor` (7.10+), `BackButton.show/hide/onClick/offClick` (6.1+), `HapticFeedback.impactOccurred(light|medium|heavy|rigid|soft)` / `notificationOccurred(error|success|warning)` / `selectionChanged()` (6.1+), `openLink(url)` (только по действию пользователя), `isVersionAtLeast`.
- `safeAreaInset`/`contentSafeAreaInset` {top,bottom,left,right} и CSS-переменные `--tg-safe-area-inset-*`, `--tg-content-safe-area-inset-*`; тема — `--tg-theme-*`; события `safeAreaChanged`, `contentSafeAreaChanged`, `activated`/`deactivated`, `themeChanged`, `viewportChanged`.
- Данные запуска SDK читает из `location.hash` (`tgWebAppData…`) — для своего роутинга использовать путь или query, не `#`.

## iframe и CSP
- Официального списка нет. Telegram Web (/k и /a) встраивает Mini App в iframe с origin `https://web.telegram.org`; нативные клиенты (iOS, Android, Desktop, macOS) — webview без iframe.
- Ставим `frame-ancestors 'self' https://web.telegram.org` и убираем `X-Frame-Options: DENY` для страниц Mini App.
- С 20.07.2026 методы Mini App отклоняются с чужих origin (Bot API 10.2) — все страницы на одном домене.
- Cookies в iframe Telegram Web не держатся (bugs.telegram.org/c/37071) — вход только через initData + токен в localStorage.

## Открыть экран из сообщения
- Кнопка `web_app` в inline-клавиатуре — только в личных чатах; URL — любой HTTPS-путь/query (`https://host/?meal=<id>`).
- `startapp` через `t.me/<bot>?startapp=` требует Main Mini App в BotFather — не нужен.

## Лимиты
- Текст 1–4096 символов, подпись 0–1024, `callback_data` 1–64 байта, текст `answerCallbackQuery` 0–200 (клиент крутит прогресс, пока бот не ответит).
- > 1 сообщения/с в один чат → 429; ~30/с в сумме.
- `getFile` — до 20 МБ, файл `https://api.telegram.org/file/bot<token>/<file_path>` живёт ≥ 1 ч.

## HTML parse_mode
- Теги: `b/strong`, `i/em`, `u/ins`, `s/strike/del`, `tg-spoiler`, `a href`, `code`, `pre`, `pre><code class="language-x">`, `blockquote` (+ `expandable`), `tg-emoji`, `tg-time`. **Заголовков и списков нет** (они есть только в Rich messages, `sendRichMessage`, 10.1).
- Экранировать `<` `>` `&` → `&lt;` `&gt;` `&amp;`; именованные сущности только эти и `&quot;`.
- Вложенность полная; `pre`/`code` ничего не содержат; blockquote не вкладываются.

## Апдейты
- Альбом = отдельные `Message` с общим `media_group_id`, порядок и интервал не гарантированы.
- `photo` — массив размеров; брать по `file_size`/ширине, а не по позиции.
- `voice` — OGG/Opus, `video_note` — MP4 (до 1 мин), `audio`/`document` — `mime_type` со слов отправителя.
- `callback_query`: `id`, `from`, `message` (может быть `InaccessibleMessage` с `date: 0`), `data`.
- 10.5: `getMe` возвращает `BotFullInfo`.
