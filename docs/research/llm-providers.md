# LLM-провайдеры для nutrition-agent: сравнение, роутинг, fallback

- **Дата проверки:** 2026-11-24. Цены сверены с официальными страницами на эту дату.
- **Задачи:** (1) vision: фото еды → JSON по схеме; (2) транскрипция русской речи; (3) чат с tool calling.
- **Стек:** Next.js на Vercel, Supabase, Vercel AI SDK v7 (`ai@7.0.181`, `@ai-sdk/openai@4.0.122` на 2026-11-24).
- Детали подключения ChatGPT-плана см. в `chatgpt-oauth.md`. Пометка `UNVERIFIED` означает отсутствие прямого подтверждения в документации.

---

## TL;DR: рекомендуемые модели

| Задача | Основная модель | Цена (Standard) | Fallback |
|---|---|---|---|
| Vision → JSON | `gpt-6.1-terra` (OpenAI) | $1.00 / $5.00 за 1M input/output | `gpt-6-luna` → `@cf/google/gemma-4-26b-a4b-it` ($0.10 / $0.30) |
| Сильная модель (reasoning) | `gpt-6.2-sol` | $2.00 / $10.00 | `gpt-6.2-astra` ($8 / $40) для самых сложных задач; `@cf/openai/gpt-oss-120b` ($0.35 / $0.75) |
| Самый дешёвый чат + tools | `gpt-6-luna` | $0.10 / $0.50 (cached $0.01) | `@cf/zai-org/glm-4.7-flash` ($0.0605 / $0.40) |
| Транскрипция (ru) | `gpt-transcribe` | **$0.0045 / мин** | `@cf/openai/whisper-large-v3-turbo` (**$0.000513 / мин**, при нашем объёме в бесплатной квоте) |
| ChatGPT-план (если включён) | `gpt-6-luna` / `gpt-6.1-terra` / `gpt-6.2-sol` через Sign in with ChatGPT | $0 сверх подписки, расходует лимиты плана | Транскрипции нет. Structured outputs `UNVERIFIED` |

`gpt-4o-transcribe`, `gpt-4o-mini-transcribe` и `whisper-1` объявлены **deprecated**, отключение 26.02.2027. Для новой интеграции брать `gpt-transcribe`.

---

## 1. Провайдеры

| Провайдер | Модель оплаты | Сильные стороны | Ограничения |
|---|---|---|---|
| **ChatGPT plan** (Sign in with ChatGPT, OAuth) | Лимиты подписки Plus/Pro, без API-ключа | Сильные модели GPT-6.x без доплаты | Политика для hosted-приложений не ясна (нужна форма, см. `chatgpt-oauth.md`). Только `/v1/responses`, обязательно `stream:true` и `store:false`. Нет `temperature` и `max_output_tokens`. Tools только в `namespace`. **Нет транскрипции**. Лимиты общие с Codex и ChatGPT |
| **OpenAI API** (API-ключ) | Pay-as-you-go за токены или минуты | Полный набор функций: structured outputs, vision, tools, `gpt-transcribe` | Платно. Подписка ChatGPT API-кредитов не даёт ([Pricing](https://learn.chatgpt.com/docs/pricing)) |
| **Cloudflare Workers AI** | Neurons: $0.011 за 1 000; 10 000 neurons/день бесплатно | Очень дёшево, бесплатная квота, Whisper за $0.0005/мин, zero data retention у моделей | Open-weight модели. JSON mode **без стриминга**. OpenAI-совместимы только chat/embeddings (Responses только для gpt-oss). Транскрипция через нативный `/ai/run` |

---

## 2. Сравнение по задачам

### 2.1 Vision: фото еды → JSON

Цены за 1M токенов, Standard, короткий контекст (≤272K).

| Провайдер / модель | Input | Cached | Output | Vision | Structured output | Tools | Комментарий |
|---|---|---|---|---|---|---|---|
| OpenAI `gpt-6-luna` | $0.10 | $0.01 | $0.50 | ✅ | ✅ | ✅ | Самый дешёвый; `reasoning.effort` по умолчанию `medium`, для простых задач ставить `none` или `low` |
| OpenAI `gpt-6.1-terra` | $1.00 | $0.05 | $5.00 | ✅ | ✅ | ✅ (только Responses) | Позиционируется под визуальное рассуждение и сопоставление фото товаров с каталогом. **Основной кандидат для еды** |
| OpenAI `gpt-6.2-sol` | $2.00 | $0.10 | $10.00 | ✅ | ✅ | ✅ | `reasoning.effort=none` отклоняется |
| OpenAI `gpt-6.2-astra` | $8.00 | $0.40 | $40.00 | ✅ | ✅ | ✅ | Флагман, для vision избыточен |
| ChatGPT plan (те же slug из `/v1/models`) | — | — | — | ✅ | `UNVERIFIED` | ✅ (namespace) | Изображения только inline, Files API не поддерживается |
| Workers AI `@cf/google/gemma-4-26b-a4b-it` | $0.10 | — | $0.30 | ✅ | ✅ `response_format: json_schema` | ✅ | 256K контекст, reasoning. **Основной дешёвый fallback** |
| Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct` | $0.27 | — | $0.85 | ✅ | ✅ (JSON mode) | ✅ | 131K контекст |
| Workers AI `@cf/qwen/qwen3.8-27b` | $0.45 | $0.05 | $3.20 | ✅ | ✅ | ✅ | Дорогой output |
| Workers AI `@cf/mistralai/mistral-small-3.1-24b-instruct` | $0.351 | — | $0.555 | по описанию | ✖ нет `response_format` в схеме | ✅ | |
| Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` | $0.0485 | — | $0.676 | ✅ | ✖ | ✖ | Сначала нужен запрос `"prompt":"agree"` (лицензия Meta) |

**Стоимость картинки у OpenAI.** Изображение режется на патчи 32×32 px. Число патчей умножается на коэффициент модели (1.2 у GPT-6 Astra и GPT-5.x). Для `gpt-6-luna` и `gpt-6.1-terra` коэффициент и лимиты в таблицах не указаны: `UNVERIFIED`. У GPT-6 Astra `detail: auto` = `original`, то есть без уменьшения. Поэтому **уменьшаем фото на клиенте примерно до 1024 px по длинной стороне**: 1024×768 = 768 патчей ≈ 920 токенов. Можно использовать `detail: "low"` (вписывание в 512×512). Источник: [Images and vision](https://developers.openai.com/api/docs/guides/images-vision).

### 2.2 Транскрипция русской речи

| Провайдер / модель | Цена | Статус | Особенности |
|---|---|---|---|
| OpenAI **`gpt-transcribe`** | **$0.0045 / мин** | Рекомендуемая для новых интеграций | `POST /v1/audio/transcriptions`. Файлы до 25 MB: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. Подсказки `languages: ["ru"]` (массив ISO 639-1, единичный `language` не передавать), `keywords` (названия блюд и продуктов), `prompt`. Поддерживает стриминг. В ответе определённые языки |
| OpenAI `gpt-live-transcribe` | $0.017 / мин | Для живого микрофона (Realtime) | Не нужен, пока пишем голосовые файлами |
| OpenAI `gpt-4o-mini-transcribe` | $0.003 / мин ($1.25 / $5 за 1M) | **Deprecated**, отключение 26.02.2027 | Дешевле, но скоро отключится |
| OpenAI `gpt-4o-transcribe` | $0.006 / мин | **Deprecated**, 26.02.2027 | |
| OpenAI `whisper-1` | $0.006 / мин | **Deprecated**, 26.02.2027 | |
| ChatGPT plan | — | **Не поддерживается** (transcription API и аудио-вход исключены явно) | |
| Workers AI **`@cf/openai/whisper-large-v3-turbo`** | **$0.000513 / мин** (46.63 neurons/мин) | Активна | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/openai/whisper-large-v3-turbo`, тело `{ "audio": "<base64>", "language": "ru" }`; есть `initial_prompt`, `vad_filter`, `beam_size` |
| Workers AI `@cf/openai/whisper` | $0.0005 / мин | Активна | Старее turbo |
| Workers AI `@cf/deepgram/nova-3` | $0.0052 / мин (batch), $0.0092 / мин (WebSocket) | Активна | Язык задаётся BCP-47; качество для русского `UNVERIFIED` |

Поддержка `"ru"` в `languages` у `gpt-transcribe`: формат ISO 639-1 документирован, отдельного списка языков нет. Почти наверняка поддерживается, но формально `UNVERIFIED`, проверить первым тестом.

### 2.3 Чат и tool calling

| Уровень | Провайдер / модель | Input / Output за 1M | Tools | JSON | Комментарий |
|---|---|---|---|---|---|
| Дешёвый | OpenAI `gpt-6-luna` | $0.10 / $0.50 | ✅ | ✅ | 1.05M контекст. В Chat Completions function calling работает только при `reasoning_effort=none`, поэтому используем Responses |
| Дешёвый | Workers AI `@cf/zai-org/glm-4.7-flash` | $0.0605 / $0.40 | ✅ | ✅ | Только текст, 131K, 100+ языков |
| Дешёвый | Workers AI `@cf/google/gemma-4-26b-a4b-it` | $0.10 / $0.30 | ✅ | ✅ | Есть vision, удобно использовать одну модель на обе задачи |
| Самый дешёвый текст | Workers AI `@cf/ibm-granite/granite-4.0-h-micro` | $0.017 / $0.112 | — | — | Для русского языка не проверялась |
| Средний | OpenAI `gpt-6.1-terra` | $1.00 / $5.00 | ✅ | ✅ | |
| Сильный | OpenAI `gpt-6.2-sol` | $2.00 / $10.00 | ✅ | ✅ | `gpt-6.1-sol` стоит столько же |
| Максимум | OpenAI `gpt-6.2-astra` | $8.00 / $40.00 | ✅ | ✅ | |
| Сильный, дешёвый | Workers AI `@cf/openai/gpt-oss-120b` | $0.35 / $0.75 | ✅ | ✅ | Доступна на Free-плане Workers, без vision |
| Сильный (только Workers Paid) | Workers AI `@cf/thinkingmachines/inkling-2-small` | $0.30 / $1.00 | ✅ | ✅ | Есть vision; лимит 20 RPM при стандартном биллинге |

Модификаторы цен OpenAI: Batch −50%. Fast ×2. Long context (>272K) ×2 на input и ×1.5 на output. Регион или data residency +10% для моделей, вышедших с 05.03.2026 ([Pricing](https://developers.openai.com/api/docs/pricing)).

---

## 3. Оценка стоимости для нашего объёма

Допущения в день: 8 фото; 15 голосовых по 30 с (7.5 мин); 40 реплик чата по 4 000 input и 400 output токенов (история и tools); 1 недельный «сильный» анализ на 20K input и 2K output. Фото оцениваем как ≈920 image-токенов + 1 000 текстовых + 400 output. Reasoning-токены считаются как output, поэтому `effort` держим низким. Все цифры оценочные.

| Компонент | Вариант | ≈ $/мес |
|---|---|---|
| Vision | `gpt-6.1-terra` (~$0.0039 за фото) | 0.94 |
| Vision | `gpt-6-luna` (~$0.0004 за фото) | 0.09 |
| Vision | `@cf/google/gemma-4-26b-a4b-it` (~29 neurons за фото) | ~0.08 или $0 в бесплатной квоте |
| Транскрипция | `gpt-transcribe` (225 мин) | 1.01 |
| Транскрипция | `whisper-large-v3-turbo` (≈350 neurons/день) | **$0** (квота 10 000/день) |
| Чат | `gpt-6-luna` | 0.72 (меньше с prompt caching) |
| Чат | `gpt-6.2-sol` | 14.40 |
| Чат | `@cf/zai-org/glm-4.7-flash` (≈1 460 neurons/день) | **$0** в квоте |
| Сильный анализ | `gpt-6.2-sol`, раз в неделю | 0.26 |
| **Итого (рекомендация, только API-ключ)** | Luna + Terra + gpt-transcribe + Sol | **≈ $3 / мес** |
| **Итого (транскрипция на Workers AI)** | то же, но Whisper | **≈ $2 / мес** |

Всё на Workers AI укладывается примерно в 2 000 neurons/день из бесплатных 10 000. При нашем объёме Workers Paid ($5/мес минимум) не нужен ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). ChatGPT-план, если его разрешат, снимает основную статью расходов: сильные модели в чате.

---

## 4. Рекомендуемый роутинг и порядок fallback

| Уровень задачи | 1 (первый) | 2 | 3 |
|---|---|---|---|
| `chat_fast`: рутинный чат, разбор намерений, вызовы tools | ChatGPT plan → `gpt-6-luna`* | OpenAI → `gpt-6-luna` (`reasoningEffort: 'low'`) | Workers AI → `@cf/zai-org/glm-4.7-flash` |
| `vision`: фото → JSON | ChatGPT plan → `gpt-6.1-terra`** | OpenAI → `gpt-6.1-terra` (бюджетный режим: `gpt-6-luna`) | Workers AI → `@cf/google/gemma-4-26b-a4b-it` (JSON без стрима) → `@cf/meta/llama-4-scout-17b-16e-instruct` |
| `strong`: недельный анализ, план питания, сложные вопросы | ChatGPT plan → `gpt-6.2-sol` (по кнопке «глубоко» `gpt-6.2-astra`) | OpenAI → `gpt-6.2-sol` | Workers AI → `@cf/openai/gpt-oss-120b` |
| `transcribe`: голос (ru) | OpenAI → `gpt-transcribe` (`languages:['ru']`, `keywords`) | Workers AI → `@cf/openai/whisper-large-v3-turbo` (`language:'ru'`) | — (план не поддерживает) |

\* Только если `CHATGPT_PLAN_ENABLED=true`, учётка в статусе `active` и slug есть в `GET /v1/models` аккаунта.
\** Только после теста, подтверждающего `json_schema` на plan-route.

Если важнее нулевая стоимость, чем качество, у транскрипции можно поменять местами уровни 1 и 2: Whisper бесплатен в квоте, `gpt-transcribe` берёт `keywords`.

**Circuit breaker.** Состояние провайдера хранится в Supabase:
- `paused_limit` для плана после 429 `subscription_sharing_usage_limit_exceeded`. Снимается кнопкой «Я поднял лимит» или пробой следующим реальным запросом не чаще раза в 60 минут. Время сброса из ошибки не выводим (так требует документация).
- `needs_reauth` после 401 или терминальных ошибок refresh.
- `cooldown` на N минут после 503 / 429 (rate) / 3040.

Ошибки до первого токена переключаем прозрачно. При ошибке посреди стрима в чате показываем пометку «ответ продолжен другим провайдером» и перегенерируем ответ. Vision и транскрипцию просто повторяем на следующем уровне.

---

## 5. Сигналы ошибок для автоматического fallback

| Провайдер | Сигнал | Действие |
|---|---|---|
| ChatGPT plan | **HTTP 429 + `error.code=subscription_sharing_usage_limit_exceeded`**; может прийти событием `response.failed` в середине стрима | Пауза plan-route → fallback, ссылка «Manage usage» → `https://chatgpt.com/settings/usage` |
| ChatGPT plan | 503: `subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable` или admission `{"detail":...}` | 1–2 повтора с backoff → fallback |
| ChatGPT plan | 400 `subscription_sharing_unsupported_capability` (смотреть `error.param`) | Не повторять. Убрать фичу или перевести задачу на OpenAI API |
| ChatGPT plan | 401 / 403 (`subscription_sharing_invalid_user`, `..._user_not_eligible`, `..._route_not_supported`, `chatpass_v2_*`) | `needs_reauth` или выключение plan-route → fallback |
| OpenAI API | 429 без billing-кода (rate limit) или `slow_down` | Соблюдать `Retry-After`, 1–2 повтора → fallback |
| OpenAI API | 429 с `error.code` из `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` (`error.type` бывает `insufficient_quota`) | **Не повторять**: fallback на Workers AI и алерт владельцу |
| OpenAI API | 503 `server_is_overloaded`, 500 | `Retry-After` / один повтор → fallback |
| Workers AI | 429, внутренний код `3036` (кончилась бесплатная квота 10 000 neurons, Free-план) | Fallback до 00:00 UTC |
| Workers AI | 429, код `3040` (out of capacity) | Короткий cooldown → fallback |
| Workers AI | 403 `5035` (нужен Workers Paid), 410 `5028` (модель deprecated), 408 `3007` (timeout) | Конфигурационная ошибка, другая модель, повтор |
| Workers AI | Ошибка «JSON Mode couldn't be met» | Повтор с упрощённой схемой → следующая модель |

Источники: [SIWC Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [OpenAI Error codes](https://developers.openai.com/api/docs/guides/error-codes), [Workers AI Errors](https://developers.cloudflare.com/workers-ai/platform/errors/), [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).

---

## 6. Интеграция с Vercel AI SDK v7 (наброски)

```ts
// src/lib/llm/providers/openai-api.ts — API-ключ (только сервер)
import { createOpenAI } from '@ai-sdk/openai';
import { transcribe } from 'ai';

export const openaiApi = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function transcribeRu(audio: Uint8Array) {
  return transcribe({
    model: openaiApi.transcription('gpt-transcribe'),
    audio,
    providerOptions: { openai: { languages: ['ru'], keywords: ['гречка', 'творог', 'ккал'] } },
  });
}
```

```ts
// src/lib/llm/providers/workers-ai.ts — вариант 1 (рекомендация Cloudflare): createAI вне Worker
import { createAI } from 'agents/models/ai-sdk'; // требует ai@^7
export const workersAi = createAI({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!, // права: Workers AI Read
  gateway: 'default',
});
// workersAi('@cf/google/gemma-4-26b-a4b-it'), workersAi.transcription('@cf/openai/whisper-large-v3-turbo')

// Вариант 2 (легче): OpenAI-совместимый chat endpoint
// baseURL: https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1  (+ /chat/completions)
// с @ai-sdk/openai-compatible. Транскрипция при этом идёт через REST /ai/run/@cf/openai/whisper-large-v3-turbo
```

- Пакет `workers-ai-provider` объявлен **deprecated**, Cloudflare рекомендует `createAI` ([Workers AI + AI SDK](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/), [createAI reference](https://developers.cloudflare.com/agents/models/ai-sdk/)).
- JSON mode на Workers AI не стримится. Для vision на Workers используем `generateText` + `Output.object`, а не `streamText`.
- Для ChatGPT-плана всегда `streamText`. Настройки: `providerOptions.openai = { store: false, systemMessageMode: 'developer' }`, `maxRetries: 0`, у каждого tool `providerOptions.openai.namespace`. Подробности в `chatgpt-oauth.md`, раздел 6.
- Для OpenAI API на vision ставим `strictJsonSchema: true` (structured outputs в strict-режиме) и `reasoningEffort: 'low'` (или `'none'` у Luna и Terra).

---

## 7. Устаревающие модели: не закладывать в код

| Модель | Отключение | Замена от OpenAI / Cloudflare |
|---|---|---|
| `gpt-5-mini` | 11.12.2026 | `gpt-6.1-terra` |
| `gpt-5-nano` | 11.12.2026 | `gpt-6-luna` |
| `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` | 14.01.2027 | `gpt-6-luna` |
| `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` | 26.02.2027 | `gpt-transcribe` или `gpt-live-transcribe` |
| `gpt-5.4-nano` | 01.04.2027 | `gpt-6-luna` |
| Workers AI `@cf/zai-org/glm-5.3-flash`, `@cf/moonshotai/kimi-k2.6` | Помечены Deprecated 20.11.2026 | см. каталог |
| Workers AI `@cf/google/gemma-3-12b-it` | Страница модели отдаёт 404, хотя цена ещё есть на странице pricing | `gemma-4-26b-a4b-it` |

Источники: [OpenAI Deprecations](https://developers.openai.com/api/docs/deprecations), страницы моделей Workers AI.

---

## 8. Открытые вопросы (`UNVERIFIED`)

1. Работает ли `json_schema` на ChatGPT plan-route, и какие slug доступны конкретно на Plus и на Pro (см. `chatgpt-oauth.md`).
2. Коэффициент image-токенов для `gpt-6-luna` и `gpt-6.1-terra`: в таблице патчевой токенизации они не указаны.
3. Сколько токенов занимает изображение у `gemma-4-26b-a4b-it` на Workers AI (оценка в разделе 3 условная).
4. Принимает ли OpenAI-совместимый endpoint Workers AI `image_url` для vision-моделей. Нативная схема Gemma 4 `image_url` принимает.
5. Качество русского у Whisper turbo по сравнению с `gpt-transcribe` на наших записях: нужен A/B на 20–30 голосовых.
6. Поддержка `"ru"` в `languages` у `gpt-transcribe` (формат ISO 639-1 документирован, отдельного списка нет).

---

## 9. Источники (проверены 2026-11-24)

**OpenAI API**
- Цены: https://developers.openai.com/api/docs/pricing
- Каталог моделей: https://developers.openai.com/api/docs/models, https://developers.openai.com/api/docs/models/all
- Карточки моделей: https://developers.openai.com/api/docs/models/gpt-6-luna, https://developers.openai.com/api/docs/models/gpt-6.1-terra, https://developers.openai.com/api/docs/models/gpt-6.2-sol, https://developers.openai.com/api/docs/models/gpt-6.2-astra, https://developers.openai.com/api/docs/models/gpt-transcribe
- Транскрипция: https://developers.openai.com/api/docs/guides/transcription, https://developers.openai.com/api/docs/guides/speech-to-text, https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- Vision и токены изображений: https://developers.openai.com/api/docs/guides/images-vision
- Устаревание моделей: https://developers.openai.com/api/docs/deprecations
- Коды ошибок: https://developers.openai.com/api/docs/guides/error-codes
- Лимиты ChatGPT-плана и credits: https://learn.chatgpt.com/docs/pricing

**Cloudflare Workers AI**
- Цены и neurons: https://developers.cloudflare.com/workers-ai/platform/pricing/
- OpenAI-совместимые endpoint'ы: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- JSON mode: https://developers.cloudflare.com/workers-ai/features/json-mode/
- Лимиты: https://developers.cloudflare.com/workers-ai/platform/limits/
- Ошибки: https://developers.cloudflare.com/workers-ai/platform/errors/
- Модели: https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/ (схема: https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/sync-input.json), https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/, https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/, https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/, https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/, https://developers.cloudflare.com/workers-ai/models/nova-3/
- AI SDK: https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/, https://developers.cloudflare.com/agents/models/ai-sdk/
- Changelog: https://developers.cloudflare.com/workers-ai/changelog/
- Workers Paid: https://developers.cloudflare.com/workers/platform/pricing/

**Vercel AI SDK**
- https://ai-sdk.dev/providers/ai-sdk-providers/openai (namespace tools, `gpt-transcribe` с `languages` и `keywords`, `store`, `systemMessageMode`)
- https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- Версии: https://www.npmjs.com/package/ai, https://www.npmjs.com/package/@ai-sdk/openai

**ChatGPT plan:** см. раздел «Источники» в `chatgpt-oauth.md`.
