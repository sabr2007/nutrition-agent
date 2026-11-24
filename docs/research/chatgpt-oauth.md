# Sign in with ChatGPT (ChatGPT plan usage): исследование для nutrition-agent

- **Дата проверки:** 2026-11-24 (все факты сверены с первоисточниками на эту дату)
- **Контекст:** Next.js на Vercel + Supabase, TypeScript, Vercel AI SDK. Владелец имеет ChatGPT Plus/Pro.
- **Пометка `UNVERIFIED`** означает: в официальной документации нет прямого подтверждения, нужно проверить тестом или запросом в OpenAI.

---

## TL;DR

1. **Программа существует.** На DevDay 29.09.2026 OpenAI объявила, что пользователи Plus и Pro могут тратить лимиты своего плана в сторонних инструментах (16 партнёров на старте), с настройкой лимита для каждого приложения. Scope `chatgpt.tokens.use.direct` реален, но вместе с ним нужны `offline_access` и `resource.invoke`.
2. **Self-serve путь без API-ключа и без формы есть, но он рассчитан на open-source и локально запущенные приложения.** Регистрация клиента динамическая (`client_id=dynamic_agent_client`), redirect только на loopback `http://127.0.0.1:<port>/...`. Для «paid or remotely hosted» приложений OpenAI отправляет заполнять interest form.
3. **Использование токена:** `POST https://api.openai.com/v1/responses` с `Authorization: Bearer <access_token>`, обязательно `store: false` и `stream: true`; каталог моделей аккаунта: `GET https://api.openai.com/v1/models`. Vision поддерживается, function tools поддерживаются (сгруппированными в `namespace`). **Транскрипции нет.** Structured outputs (`text.format: json_schema`) не упомянуты ни как поддерживаемые, ни как запрещённые: `UNVERIFIED`.
4. **Сигнал исчерпания лимита:** HTTP `429` с `error.code = subscription_sharing_usage_limit_exceeded`. Он может прийти и **посреди стрима** как событие `response.failed`.
5. **Наш случай (личное, однопользовательское OSS-приложение на Vercel)** явно в документации не описан. При строгом прочтении это «remotely hosted» → форма. Ближайший документированный паттерн: «open-source app on a remote VM», где OAuth проходит локально, а credentials переносятся на сервер. **Рекомендация:** реализовать документированный OSS-flow за feature flag (по умолчанию выключен), параллельно запросить у OpenAI подтверждение через interest form. Основной путь до подтверждения: API-ключ + Cloudflare Workers AI (см. `llm-providers.md`).

---

## 1. Существует ли программа в описанном виде

| Утверждение | Статус | Источник |
|---|---|---|
| Анонс на DevDay 2026-09-29 | **Подтверждено.** Recap DevDay датирован September 29, 2026; секция Sign in with ChatGPT: использование allowance у 16 партнёров, контроль объёма для каждого. Plan usage доступен Plus и Pro | [DevDay 2026 recap](https://openai.com/index/devday-2026-recap/) |
| Plus/Pro тратят usage своего плана в сторонних приложениях | **Подтверждено.** Help Center расширяет список для коммерческих приложений до Go, Plus, Pro, Business. OSS-документация говорит о Plus и Pro | [Help: Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites), [Quickstart](https://developers.openai.com/siwc/quickstart) |
| OAuth scope `chatgpt.tokens.use.direct` | **Подтверждено.** Полный набор для plan usage: `offline_access resource.invoke chatgpt.tokens.use.direct` плюс identity `openid profile email` | [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) |
| Без API-ключа | **Подтверждено.** Для OSS-flow не нужен ни client secret, ни partner API key | [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) |
| Документация нацелена на OSS и локальные приложения; платные или удалённо размещённые должны подать форму | **Подтверждено** (см. раздел 4) | [Overview](https://developers.openai.com/siwc/token-sharing-open-source), [Cookbook: Usage policy](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) |
| Usage общий с лимитами ChatGPT | **Подтверждено.** Запросы списываются из включённого в план allowance «ChatGPT Work and Codex» или из credits | [Help 20001542](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites), [learn.chatgpt.com Pricing](https://learn.chatgpt.com/docs/pricing) |
| Можно задать недельный лимит на приложение | **Подтверждено.** Settings → Usage → App limits → Manage limits, процент от недельного usage (в примере UI от 10% до 100%). Это потолок, а не зарезервированная доля | [Help 20001542](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites), [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) |

Официальный набор для разработчиков: [openai/sign-in-with-chatgpt-devkit](https://github.com/openai/sign-in-with-chatgpt-devkit) (локальный Node SDK `@siwc/local`, React-компоненты, пример Paste Perfect). README позиционирует его для open-source приложений, работающих на машине пользователя. Код под **Noncommercial License v1.0**. Если копировать его в наш репозиторий, изменённые файлы при распространении придётся лицензировать так же. Поэтому лучше писать свою реализацию по документации, а DevKit использовать как справочник.

---

## 2. OAuth: эндпоинты, PKCE, scopes, регистрация, redirect, токены

### 2.1 Эндпоинты (production)

Взяты из discovery-документа [`https://auth.openai.com/.well-known/openid-configuration`](https://auth.openai.com/.well-known/openid-configuration), проверено 2026-11-24:

| Назначение | URL |
|---|---|
| Issuer | `https://auth.openai.com` |
| Authorize | `https://auth.openai.com/api/accounts/authorize` |
| Token | `https://auth.openai.com/api/accounts/oauth/token` |
| Revocation | `https://auth.openai.com/api/accounts/oauth/revoke` |
| JWKS | `https://auth.openai.com/.well-known/jwks.json` |
| Userinfo | `https://auth.openai.com/api/accounts/oauth/userinfo` |

Discovery объявляет `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]` и token auth methods `none` / `client_secret_basic` / `client_secret_post`. Scopes `resource.invoke` и `chatgpt.tokens.use.direct` в `scopes_supported` discovery **не перечислены**: там только `openid profile email offline_access`. Они задокументированы на странице sign-in.

### 2.2 Параметры authorize-запроса (OSS-flow с plan usage)

Источник: [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

| Параметр | Значение |
|---|---|
| `response_type` | `code` |
| `client_id` | При первой регистрации `dynamic_agent_client`; дальше сохранённый выданный ID (`oaiapp_...`) |
| `agent_name_hint` | Реальное имя приложения, одинаковое во всех установках. Только при первой регистрации; пользователь может его отредактировать |
| `ext_agent_host_id` | **Обязателен.** Стабильный непрозрачный ID хоста: `urn:uuid:<uuidv4>`, рекомендуемый `urn:ietf:params:oauth:jwk-thumbprint:...` (RFC 9278) или `did:key:...`. Не email и не user id |
| `redirect_uri` | Только HTTP loopback на `127.0.0.1` (подробнее в 2.4) |
| `scope` | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `resource` | `https://api.openai.com/v1` |
| `state`, `nonce` | Свежие случайные значения на каждую попытку |
| `code_challenge_method` | `S256` |
| `code_challenge` | base64url(SHA-256(verifier)) без padding |
| `id_token_hint`, `login_hint` | Только для повторной авторизации сохранённого аккаунта |
| `prompt=consent` / `force_reconsent=true` | Только когда пользователь явно включает plan usage после отказа. `force_reconsent` допустим лишь после того, как OpenAI подтвердит развёртывание для интеграции (см. [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)) |

### 2.3 Регистрация клиента

- **OSS (self-serve):** заранее регистрировать ничего не нужно. При первом входе приложение шлёт `client_id=dynamic_agent_client`. Пользователь логинится, выбирает аккаунт и workspace, называет агента и подтверждает права. Callback возвращает `code`, `state` и **выданный `client_id`**. Выданный ID привязан к пользователю и выбранному workspace, его надо сохранить и использовать дальше. `dynamic_agent_client` нельзя сохранять и нельзя использовать для обмена кода. Client secret отсутствует (public client). Источники: [Overview](https://developers.openai.com/siwc/token-sharing-open-source), [Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
- **Коммерческие / website / plugin:** client ID выдаётся вручную. Страница [Request a client ID](https://developers.openai.com/siwc/request-client-id) ведёт на [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/). Сама форма адресована коммерческим партнёрам, а open-source разработчиков отправляет в документацию. Поля: work email, имя, компания, сайт, выбор «Sign in only» или «Sign in and ChatGPT plan use for AI requests», описание продуктов. Такие клиенты бывают public или confidential (`client_secret_basic`) с точно зарегистрированным callback URL; управление идёт в OpenAI Platform → OAuth apps ([On your website](https://developers.openai.com/siwc/website)). Публичная website-инструкция описывает только identity-scopes.

### 2.4 Правила redirect URI

- **OSS-flow:** только `http://127.0.0.1:<port>/<path>`, например `http://127.0.0.1:1455/auth/callback`. Подставлять `localhost` нельзя. После первой регистрации может меняться **только порт**; схема, хост и путь фиксированы (`/callback` не совпадёт с `/auth/callback`). В рамках одной попытки `redirect_uri` в authorize и в token exchange должен совпадать побайтно. HTTPS-callback на собственном домене для этого flow **не предусмотрен**.
- **Website-flow (коммерческий клиент):** точный зарегистрированный HTTPS callback для каждого окружения.
- **Следствие для Vercel:** приложение на Vercel не может само принять OAuth callback в OSS-flow. Callback на `127.0.0.1` попадает на компьютер, где открыт браузер. Документация для удалённых машин предлагает пройти OAuth локально и перенести credentials ([Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)).

### 2.5 Обмен кода, refresh, время жизни токенов

- **Exchange:** form-encoded `POST https://auth.openai.com/api/accounts/oauth/token` с полями `grant_type=authorization_code`, `client_id=<выданный>`, `code`, `code_verifier`, тем же `redirect_uri` и тем же `resource`. Секрета нет. При `invalid_grant` код отбрасываем и начинаем новую авторизацию с тем же выданным `client_id`.
- **Ответ:** `access_token`, `refresh_token` (при `offline_access`), `id_token`, `token_type`, `expires_in`, `scope`, `earliest_refresh_at` ([Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)). Смысл `earliest_refresh_at` не описан: `UNVERIFIED`. Разумно не обновлять токен раньше этого времени.
- **Валидация:** подпись ID token по JWKS, `iss = https://auth.openai.com`, `aud = <выданный client_id>`, `exp`, `nonce`. **Обязательно** проверить, что в granted `scope` есть `chatgpt.tokens.use.direct`: валидный ID token сам по себе plan usage не разрешает.
- **Lifetimes:** access token живёт **1 час** (`expires_in: 3600`). Refresh token живёт **30 дней** и **ротируется**: каждый успешный refresh выдаёт новый refresh token со свежими 30 днями, без лимита на число продлений. Access token содержит claims `sub`, `aud=https://api.openai.com/v1`, `client_id`, `scope`, `iss`, `iat`, `exp`, `jti`, `nbf` и непрозрачный объект `https://api.openai.com/auth`.
- **Refresh:** form-encoded `POST` на token endpoint с полями `grant_type=refresh_token`, `client_id=<выданный>` (не `dynamic_agent_client`), `refresh_token` и `resource=https://api.openai.com/v1`; `scope` не передаём, чтобы сохранить grant. Новые access, refresh, expiry и scopes сохраняем атомарно. **Refresh нужно сериализовать**, иначе параллельные процессы устроят гонку за ротируемый токен; в ошибках есть `refresh_token_reused` ([Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)).
- **Ошибки refresh, требующие повторного входа:** `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`. Ошибка `invalid_client` означает неверную конфигурацию клиента.

### 2.6 Выход и отзыв

- **Sign out:** form `POST https://auth.openai.com/api/accounts/oauth/revoke` с `token=<refresh_token>`, `token_type_hint=refresh_token` и выданным `client_id`. Успех: пустой `200`, в том числе для уже невалидного токена. Регистрация клиента при этом не удаляется.
- **Disconnect со стороны пользователя:** ChatGPT → Settings → Security and login → Sign in with ChatGPT → приложение → Disconnect. OpenAI **не уведомляет** приложение об отключении; мы узнаём о нём по ошибке запроса или refresh ([Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)).

### 2.7 Хранение токенов

Access, refresh и ID token хранятся только в защищённом локальном или self-hosted runtime-хранилище: не в браузере, не в git, не в логах и аналитике. Токены нельзя класть в URL. Если credentials скомпрометированы, пользователь отключает приложение в настройках ChatGPT ([Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)). Для нас это означает: только серверный код (Route Handlers / Server Actions), шифрование в Supabase, RLS без доступа для `anon` и `authenticated`.

---

## 3. Как используется токен

Источники: [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

### 3.1 Base URL и эндпоинты

| Возможность | Статус на plan-route |
|---|---|
| Base URL | `https://api.openai.com/v1` (публичный API). `chatgpt.com/backend-api` документация прямо запрещает |
| `POST /v1/responses` | **Поддерживается.** Bearer = OAuth access token |
| `GET /v1/models` | **Поддерживается.** Возвращает каталог **конкретного аккаунта** в формате `{"models":[{slug, display_name, visibility, ...}]}` (не стандартный `data[]`). Показывать модели с `visibility == "list"`, в запрос передавать `slug` |
| Chat Completions | Не документирован. Другой route вернёт `403 subscription_sharing_route_not_supported`. Считаем **неподдерживаемым** |
| Realtime API | Не документирован → **не поддерживается**. Упомянута только WebSocket-continuation внутри одного соединения Responses |
| Транскрипция (`/v1/audio/transcriptions`) | **Не поддерживается** (явно) |
| Files upload API | **Не поддерживается** (явно). Изображения передаём inline (base64 data URL) |
| Audio/video input | **Не поддерживается** (явно) |

### 3.2 Обязательная форма запроса

- `store: false` и `stream: true` в **каждом** HTTP-запросе; ответ читается как поток событий. Успех только после `response.completed`.
- `input` передаётся массивом со всей нужной историей; `previous_response_id` по HTTP не используем.
- Системные инструкции идут через `instructions` или developer-сообщения. Элементы `{type:"message", role:"system"}` отклоняются.
- **Нельзя передавать:** `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`. Также не задаём service-tier override.
- **Tools:** function/custom tools нужно **группировать в `namespace`** (`{"type":"namespace","name":..., "description":..., "tools":[...]}`) или передавать input-элементом `additional_tools` ([Function calling → Defining namespaces](https://developers.openai.com/api/docs/guides/function-calling), [Tool search → additional_tools](https://developers.openai.com/api/docs/guides/tools-tool-search)). Web search зависит от модели и политики аккаунта. **Не поддерживаются:** image generation, file search, Code Interpreter, computer use, hosted MCP/connectors, `tool_search`, `programmatic_tool_calling` в top-level `tools`.

### 3.3 Модели и возможности

- **Модели:** набор зависит от аккаунта и плана, его надо запрашивать через `GET /v1/models` токеном пользователя. В примерах документации фигурируют `gpt-6.1-sol` и `gpt-6.2-sol`. На странице цен Codex/ChatGPT Work для Plus перечислены оценки для GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Sol и GPT-6 Luna ([learn.chatgpt.com Pricing](https://learn.chatgpt.com/docs/pricing)). Точный список для plan-route по Plus и Pro: `UNVERIFIED`, проверяется вызовом.
- **Vision:** да. Текст, изображения и файлы принимаются, если их поддерживает выбранная модель. Все модели GPT-6.x принимают `text, image` ([Models](https://developers.openai.com/api/docs/models)).
- **Structured outputs (`text.format: json_schema`):** в списке запрещённых полей нет, явного подтверждения тоже нет: **`UNVERIFIED`**. Проверяем первым тестом. Если придёт `400 subscription_sharing_unsupported_capability` с `error.param`, указывающим на `text`, задача vision на plan-route не идёт.
- **Tool calling:** да, function tools в namespace. Вызов возвращается как `function_call` с полем `namespace` ([Tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search)). Vercel AI SDK v7 (`@ai-sdk/openai` 4.x) это умеет: `providerOptions.openai.namespace = { name, description }` на каждом tool, namespace возвращается обратно через `providerMetadata.openai.namespace` ([AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)).
- **Аудио:** транскрипцию русской речи делаем другим провайдером (`gpt-transcribe` по API-ключу или Workers AI Whisper, см. `llm-providers.md`).

---

## 4. Eligibility: можно ли hosted personal OSS-приложение на Vercel без формы

### 4.1 Что говорят первоисточники

Единственная дословная цитата (Overview, [developers.openai.com/siwc/token-sharing-open-source](https://developers.openai.com/siwc/token-sharing-open-source)):

> "These docs explain ChatGPT plan usage for open-source and locally hosted apps."

Остальное пересказываю со ссылками:

- **Overview** там же: желающим предлагать plan usage в платном или удалённо размещённом приложении предлагается заполнить interest form.
- **Cookbook, раздел Usage policy** ([ссылка](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)): интеграция доступна для open-source инструментов и личных проектов, которые работают локально. Для платного или удалённо размещённого приложения нужно встать в waitlist и получить доступ до того, как предлагать его пользователям. В разделе «At launch» перечислены open-source проекты, локальные личные проекты и отобранные private apps.
- **Quickstart** ([ссылка](https://developers.openai.com/siwc/quickstart)): plan usage доступен всем open-source партнёрам и отобранным private clients; identity-only для коммерческих партнёров идёт в limited trial.
- **Self-hosted VMs** ([ссылка](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)): документированный сценарий для **open-source приложения на удалённой VM**. OAuth проходит локально тем же клиентом, credentials переносятся по защищённому каналу (например, SSH), дальше VM сама делает refresh. Оговорка: host-specific атрибуция usage и отзыв доступа для перенесённых сессий пока не реализованы.
- **DevKit README** ([ссылка](https://github.com/openai/sign-in-with-chatgpt-devkit)): набор для OSS-приложений, работающих на машине пользователя.
- **Interest form** ([ссылка](https://openai.com/form/sign-in-with-chatgpt-interest/)): адресована коммерческим партнёрам; open-source разработчиков отправляют в документацию.
- **OpenAI Support на форуме** (09.11.2026, [тред](https://community.openai.com/t/codex-login-on-3rd-party-apps/1404507)): для open-source клиентов Sign in with ChatGPT назван поддерживаемым путём; платные или удалённо размещённые реализации должны следовать требованиям доступа (то есть форма).

### 4.2 Анализ нашего случая

| Критерий | Наше приложение | Вывод |
|---|---|---|
| Open-source | Да, если репозиторий публичный с OSI-лицензией | ✅ (термин в документации не определён) |
| Платное | Нет | ✅ |
| Локально запущено | **Нет**, Vercel | ❌ при буквальном чтении |
| «Remotely hosted app … offering it to users» | Развёрнуто удалённо, но только для себя, без других пользователей | Серая зона: прямо не разрешено и не запрещено |
| Технически совместимо с self-serve flow | Callback только на `127.0.0.1` → сервер не может пройти OAuth сам | Возможно только по паттерну «OAuth локально + перенос credentials» |

**Вердикт:**
- Строгое прочтение: развёртывание на Vercel = «remotely hosted» → нужна форма.
- Мягкое прочтение: однопользовательская self-развёртка собственного OSS-инструмента аналогична документированному сценарию «OSS app on a remote VM».
- Явного разрешения нет: **`UNVERIFIED`**.
- В официальном DevKit есть код ошибки `subscription_sharing_v2_client_not_enabled` («app is not enabled for token sharing»): у OpenAI есть механизм выключить plan usage для конкретного клиента ([errors.ts](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/packages/local/src/errors.ts)).
- Сторонний пример трактовки (не официальный): открытый PR в Inbox Zero держит plan-провайдер выключенным по умолчанию, потому что для paid или remotely hosted нужно одобрение, и не предлагает его для Vercel-развёртываний ([PR #4551](https://github.com/elie222/inbox-zero/pull/4551)).

### 4.3 Самый легитимный путь

1. **Канал подтверждения.** Сделать репозиторий публичным open-source (MIT или Apache-2.0) и **подать interest form**. В поле «Company» указать, что это индивидуальный разработчик, в «Website» дать ссылку на GitHub. Честно описать: некоммерческое, один пользователь (владелец), self-deployment на Vercel, OSS-flow с локальным OAuth и переносом credentials по паттерну Self-hosted VMs. Как альтернатива или дополнение: обращение в поддержку через help.openai.com. Срок ответа неизвестен (`UNVERIFIED`).
2. **Техническая реализация строго по документации:** dynamic registration, loopback `127.0.0.1` в локальном CLI, перенос credentials на свой backend, refresh на сервере, только `https://api.openai.com/v1`. Никаких чужих client ID (включая Codex CLI) и никакого `chatgpt.com/backend-api`.
3. **Feature flag `CHATGPT_PLAN_ENABLED=false` по умолчанию.** Включать в продакшене после положительного ответа OpenAI или осознанно, принимая риск отключения клиента. Других пользователей к plan-route не подключать.
4. **Основной путь не зависит от plan usage:** API-ключ OpenAI + Cloudflare Workers AI, plan-route добавляется как самый дешёвый первый уровень.

Недокументированные приёмы мы **не используем**. Пример: в некоторых сторонних проектах пользователь вручную копирует URL с `127.0.0.1` в веб-форму удалённого сервера. В документации OpenAI такого нет; документирован только локальный OAuth с переносом credentials.

---

## 5. Лимиты и ошибки (для автоматического fallback)

### 5.1 Лимиты плана

- Usage общий с ChatGPT Work и Codex. Каждое приложение может иметь недельный потолок в процентах от недельного usage; это потолок, а не выделенная квота. Приложение может упереться в свой потолок, когда у плана ещё есть запас ([Help 20001542](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)).
- **Plus:** пятичасовое окно **общее для всех приложений**, где используется план, включая open-source клиенты. **Pro:** пятичасового лимита сейчас нет ([Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [learn.chatgpt.com Pricing](https://learn.chatgpt.com/docs/pricing)). Могут действовать и недельные лимиты; конкретных чисел OpenAI не публикует (`UNVERIFIED`). Ориентир на 5 часов для Plus в «local messages» Codex: GPT-6 Luna 350–3 000, GPT-6.1 Terra 35–285, GPT-6.2 Sol 17–180, GPT-6.2 Astra 6–50. Наши запросы намного меньше Codex-задач, поэтому цифры только для порядка.
- Расход считается в токенах по ставкам credits: GPT-6 Luna 2.5 / 0.25 / 12.5 credits за 1M токенов input / cached input / output; GPT-6.1 Terra 25 / 1.25 / 125; GPT-6.2 Sol 50 / 2.5 / 250 ([Pricing](https://learn.chatgpt.com/docs/pricing)).
- Credits после исчерпания лимита по умолчанию выключены. Чтобы их включить, лимит приложения должен быть 100%, плюс отдельная настройка. Автопереключения на другую платную опцию нет. Повторный вход или retry не восстанавливает usage.

### 5.2 Ошибки и наши действия

Источник: [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). OpenAI сам не переключает запрос на другой способ оплаты; переключение делает наш роутер.

**До открытия стрима (direct admission).** Тело может быть `{"detail":"..."}`; текст не является машиночитаемым кодом.

| HTTP | Значение | Действие роутера |
|---|---|---|
| 401 | Подпись или разрешение не приняты | Проверить scopes и аккаунт → `needs_reauth`, fallback |
| 403 | Политика, регион, разрешение | Выключить plan-route, fallback, уведомить |
| 503 | Direct routing недоступен | Ограниченный backoff (1–2 попытки), затем fallback |

**Структурированные ошибки Responses** (используем точные `error.code` / `error.param`):

| `error.code` | HTTP | Действие роутера |
|---|---|---|
| `subscription_sharing_usage_limit_exceeded` | **429** | **Главный сигнал исчерпания лимита.** Приостановить plan-route, fallback, показать «Manage usage» → `https://chatgpt.com/settings/usage`. Время сброса из кода не выводим: может действовать лимит приложения |
| `subscription_sharing_usage_unavailable` | 503 | Ограниченный backoff → fallback |
| `subscription_sharing_user_unavailable` | 503 | Ограниченный backoff → fallback |
| `subscription_sharing_unsupported_capability` | 400 | Не повторять то же тело. Смотреть `error.param`, убрать фичу или перевести задачу на API-key route |
| `subscription_sharing_route_not_supported` | 403 | Ошибка метода или эндпоинта → исправить код, fallback |
| `subscription_sharing_user_not_eligible` | 403 | Выключить plan-route (без цикла OAuth) |
| `subscription_sharing_invalid_user` | 401 | Диагностика; после подтверждённого отзыва или терминальной ошибки refresh нужен повторный вход |
| `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context` | 403 | Проверить клиент и grant, без retry → fallback |

- **Ошибка посреди стрима:** `subscription_sharing_usage_limit_exceeded` или `subscription_sharing_usage_unavailable` может прийти событием `response.failed` уже после начала вывода. `response.incomplete` и оборванный поток обрабатываются отдельно; успех только при `response.completed`.
- В официальном DevKit клиент OpenAI создаётся с `maxRetries: 0`, чтобы не повторять 429 автоматически ([responses.ts](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/packages/local/src/responses.ts)). В AI SDK так же ставим `maxRetries: 0` для plan-route.

---

## 6. Выбранный путь и шаги реализации

### 6.1 Архитектура

```
[Ноутбук владельца]                                [Vercel: Next.js server]                 [OpenAI]
pnpm chatgpt:login (Node CLI)
  ├─ host_id ноутбука (urn:uuid, ~/.config/...)
  ├─ loopback 127.0.0.1:1455/auth/callback
  ├─ браузер → auth.openai.com/api/accounts/authorize ──────────────────────────────────▶ consent
  ├─ code → POST /api/accounts/oauth/token ──────────────────────────────────────────────▶ tokens
  ├─ валидация id_token + scope chatgpt.tokens.use.direct
  └─ POST https://<app>/api/admin/chatgpt/import ──▶ шифрование → Supabase (одна строка)
                                                     token manager (refresh + lease-lock)
                                                     LLM router: plan → API key → Workers AI
                                                     streamText(store:false, stream) ───────▶ /v1/responses
```

### 6.2 Шаги

1. **Подготовка репозитория.** Публичный репозиторий с OSI-лицензией. Модули: `src/lib/llm/` (`router.ts`, `errors.ts`, `providers/chatgpt-plan.ts`, `providers/openai-api.ts`, `providers/workers-ai.ts`), `scripts/chatgpt-login.ts`, `app/api/admin/chatgpt/import/route.ts`.
2. **Таблица в Supabase** (одна строка, доступ только через service role):
   ```sql
   create table private.chatgpt_plan_credentials (
     id smallint primary key default 1 check (id = 1),
     client_id text not null,               -- выданный oaiapp_...
     subject text not null, email text,
     server_host_id text not null,          -- urn:uuid:..., свой для сервера
     access_token_enc text not null, refresh_token_enc text not null, id_token_enc text,
     scopes text[] not null,
     expires_at timestamptz not null, earliest_refresh_at timestamptz,
     refresh_lease_until timestamptz,       -- lease-lock для сериализации refresh
     status text not null default 'active', -- active | needs_reauth | paused_limit | disabled
     paused_at timestamptz, updated_at timestamptz not null default now()
   );
   ```
   Шифрование: Supabase Vault или AES-256-GCM с ключом из env Vercel. RLS: запретить всё для `anon` и `authenticated`.
3. **Локальный CLI `scripts/chatgpt-login.ts`** (Node 22+). Набросок, не готовый код:
   ```ts
   import { createHash, randomBytes } from 'node:crypto';
   const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
   const RESOURCE = 'https://api.openai.com/v1';
   const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
   const b64u = (b: Buffer) => b.toString('base64url');

   export function buildAuthorizeUrl(p: { clientId?: string; hostId: string; port: number }) {
     const verifier = b64u(randomBytes(32));
     const attempt = {
       verifier,
       state: b64u(randomBytes(16)),
       nonce: b64u(randomBytes(16)),
       redirectUri: `http://127.0.0.1:${p.port}/auth/callback`, // не localhost
     };
     const q = new URLSearchParams({
       response_type: 'code',
       client_id: p.clientId ?? 'dynamic_agent_client',
       redirect_uri: attempt.redirectUri, scope: SCOPE, resource: RESOURCE,
       state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
       code_challenge: b64u(createHash('sha256').update(verifier).digest()),
       ext_agent_host_id: p.hostId,
       ...(p.clientId ? {} : { agent_name_hint: 'Nutrition Agent' }),
     });
     return { url: `${AUTHORIZE}?${q}`, attempt };
   }
   ```
   - Слушатель на `127.0.0.1` запускается **до** открытия браузера.
   - Callback: проверить `state`, обработать `error=access_denied`, взять `client_id` из callback (при новой регистрации).
   - Обменять код (раздел 2.5), проверить ID token через `jose` (`createRemoteJWKSet` + `jwtVerify` с `issuer` и `audience`, плюс `nonce`), проверить scope.
   - Отправить credentials на `/api/admin/chatgpt/import` по HTTPS с одноразовым admin-секретом. Токены не логировать и не печатать.
4. **Import endpoint.** Принимает credentials, шифрует и сохраняет. `server_host_id` генерирует один раз и **не перезаписывает** host ID ноутбука (требование Self-hosted VMs).
5. **Token manager на сервере.** `getPlanAccessToken()` возвращает токен, если до `expires_at` больше 5 минут. Иначе берёт lease атомарным `UPDATE ... SET refresh_lease_until = now() + interval '30 seconds' WHERE id = 1 AND (refresh_lease_until IS NULL OR refresh_lease_until < now()) RETURNING ...`, перечитывает строку, делает refresh и сохраняет access, refresh, expiry и scopes одной записью. Кто не взял lease, ждёт и перечитывает. Ошибки из списка в 2.5 переводят строку в `needs_reauth`. Сетевые ошибки и 5xx credentials **не стирают**. Если приложение может простаивать больше 30 дней, нужен Vercel Cron примерно раз в неделю: refresh, только если последний был больше 7 дней назад.
6. **Plan-провайдер на AI SDK v7.** Обязателен `streamText`, потому что route требует `stream: true`. Набросок:
   ```ts
   import { createOpenAI } from '@ai-sdk/openai';
   import { streamText, tool, Output } from 'ai';

   const NS = { name: 'nutrition', description: 'Дневник питания: запись и поиск приёмов пищи' };

   export async function planResponsesModel(slug: string) {
     const apiKey = await getPlanAccessToken(); // только сервер
     return createOpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', fetch: planFetchGuard }).responses(slug);
   }

   const result = streamText({
     model: await planResponsesModel('gpt-6.1-terra'),
     maxRetries: 0,
     system: SYSTEM_PROMPT, // уйдёт developer-сообщением
     messages,
     tools: {
       log_meal: tool({
         description: 'Записать приём пищи',
         inputSchema: mealSchema,
         execute: logMeal,
         providerOptions: { openai: { namespace: NS } },
       }),
     },
     providerOptions: { openai: { store: false, systemMessageMode: 'developer', reasoningEffort: 'low' } },
   });
   ```
   - `planFetchGuard` — наша обёртка над `fetch`. Она гарантирует `store:false` и `stream:true`, удаляет из тела поля из списка в 3.2, удаляет заголовки `OpenAI-Organization` / `OpenAI-Project`, ставит `redirect: 'error'` и логирует только `x-request-id`. Это приведение запроса к документированному контракту, не обход ограничений.
   - Не задаём `temperature`, `maxOutputTokens`, `serviceTier`, `user`, `metadata`.
   - Изображения передаём inline (data URL), предварительно уменьшив на клиенте примерно до 1024 px.
   - Vision с JSON: `streamText({ output: Output.object({ schema }) })`; результат читаем на сервере до `response.completed`.
7. **Выбор модели.** Раз в сутки или при смене аккаунта: `GET /v1/models`, фильтр `visibility == "list"`. Если сконфигурированного slug нет в каталоге, задача уходит на следующий провайдер.
8. **Классификация ошибок и fallback** по таблице 5.2, в `src/lib/llm/errors.ts`. Ошибки до первого токена переключаются прозрачно. После частичного вывода в чате показываем пометку и перегенерируем ответ на fallback-провайдере. Для vision и других идемпотентных задач просто повторяем на следующем провайдере.
9. **UI** по [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines):
   - бейдж «Using ChatGPT plan» и ссылка «Manage usage» → `https://chatgpt.com/settings/usage`;
   - модалка «Usage limit reached» с основной кнопкой Manage usage;
   - в настройках показывать подключённый аккаунт и инструкцию запуска CLI.
10. **Sign out:** revoke (раздел 2.6), затем стереть токены и сохранить `client_id` для следующего входа.

### 6.3 Тест-план для plan-route

1. Токен: `GET /v1/models`, проверить состав каталога для Plus и Pro.
2. Текст: стрим до `response.completed` с `store:false`.
3. **Structured outputs:** `text.format = json_schema` (strict) на `gpt-6.1-terra` и `gpt-6-luna`. Закрывает `UNVERIFIED` из 3.3.
4. **Vision + JSON:** inline-фото еды с `detail: "low"` и `"high"`.
5. **Tools:** namespace, два шага (function_call → function_call_output) с `store:false` и проверкой round-trip поля `namespace`.
6. Отрицательные тесты: `temperature` → ожидаем `400 subscription_sharing_unsupported_capability`; искусственно низкий лимит приложения (10%) → `429 subscription_sharing_usage_limit_exceeded`, в том числе внутри стрима.
7. Refresh: два параллельных вызова → один refresh, без `refresh_token_reused`.

---

## 7. Что владелец делает вручную

1. Сделать репозиторий публичным с OSI-лицензией. Решить, подавать ли [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/) (рекомендуется), и подать её с честным описанием сценария (раздел 4.3).
2. Один раз (и потом при `needs_reauth`) запустить на своём компьютере `pnpm chatgpt:login`: войти в ChatGPT, выбрать личный аккаунт или workspace, назвать агента и **разрешить использование плана** (scope `chatgpt.tokens.use.direct`).
3. В ChatGPT → Settings → Usage → App limits для приложения выставить недельный потолок, например 25–50%, чтобы не съесть лимиты Codex и ChatGPT. Credits после лимита не включать (по умолчанию выключены).
4. В Vercel задать env: `CHATGPT_PLAN_ENABLED`, ключ шифрования, admin-секрет импорта, `OPENAI_API_KEY` (fallback), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`.
5. В OpenAI Platform создать API-ключ в отдельном project со spend limit. Подписка ChatGPT **не включает** API-кредиты: API оплачивается отдельно ([learn.chatgpt.com Pricing](https://learn.chatgpt.com/docs/pricing)).
6. Для отключения: ChatGPT → Settings → Security and login → Sign in with ChatGPT → Disconnect.

---

## 8. Открытые вопросы (`UNVERIFIED`)

1. Считает ли OpenAI однопользовательскую self-развёртку OSS-приложения на Vercel «remotely hosted» (нужна форма) или допустимым self-hosted сценарием? Нужен письменный ответ.
2. Поддерживается ли `text.format: json_schema` на plan-route? Не задокументировано.
3. Точный список моделей plan-route для Plus и Pro: зависит от аккаунта, проверяется вызовом.
4. Семантика поля `earliest_refresh_at`.
5. Лимиты частоты запросов (RPM) на plan-route и числовые недельные лимиты не опубликованы.
6. Политика использования данных (обучение, хранение) для запросов через план: идёт ли она по правилам ChatGPT data controls или API? Не описано. Для данных о питании и здоровье это важно.
7. В каком виде AI SDK v7 отдаёт `response.failed` с `error.code` (stream part или `onError`) — проверить тестом.
8. Срок ответа на interest form.
9. Host ID для serverless-развёртки: один на проект (наш выбор) или на deployment? Документация описывает только VM.

---

## 9. Источники (проверены 2026-11-24)

**OpenAI: Sign in with ChatGPT**
- https://developers.openai.com/siwc (индекс), полная выгрузка: https://developers.openai.com/siwc/llms-full.txt
- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source (Overview, host ID, политика OSS/local)
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in (authorize-параметры, scopes, redirect, exchange)
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions (refresh, revoke, 5-часовой лимит Plus)
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference (`/v1/models`, `/v1/responses`, запрет backend-api)
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations (обязательные поля, tools, inputs, отсутствие транскрипции)
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery (коды ошибок)
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference (lifetimes, claims)
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/ui-ux-guidelines
- https://developers.openai.com/siwc/website, https://developers.openai.com/siwc/request-client-id
- https://auth.openai.com/.well-known/openid-configuration
- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt (Usage policy, At launch)
- https://github.com/openai/sign-in-with-chatgpt-devkit (README, LICENSE, `packages/local/src/errors.ts`, `responses.ts`, `oauth.ts`)
- https://openai.com/form/sign-in-with-chatgpt-interest/
- https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
- https://help.openai.com/en/articles/20001410 (Sign in with ChatGPT, identity)
- https://learn.chatgpt.com/docs/sign-in-with-chatgpt (партнёры, open-source интеграции)
- https://learn.chatgpt.com/docs/pricing (общие лимиты Codex и ChatGPT Work, 5 часов, credits)
- https://openai.com/index/devday-2026-recap/ (анонс 29.09.2026)
- https://community.openai.com/t/codex-login-on-3rd-party-apps/1404507 (ответ OpenAI_Support, 09.11.2026)

**OpenAI API (для tools)**
- https://developers.openai.com/api/docs/guides/function-calling (Defining namespaces)
- https://developers.openai.com/api/docs/guides/tools-tool-search (`additional_tools`, `function_call.namespace`)
- https://developers.openai.com/api/docs/models

**Vercel AI SDK**
- https://ai-sdk.dev/providers/ai-sdk-providers/openai (`namespace`, `store`, `systemMessageMode`, `instructions`)
- https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data (`streamText` + `Output.object`)
- npm на 2026-11-24: `ai@7.0.181`, `@ai-sdk/openai@4.0.122`

**Вторичные (не официальные, только для контекста)**
- https://github.com/elie222/inbox-zero/pull/4551 (пример трактовки политики и переписывания запросов)
