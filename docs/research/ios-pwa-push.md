# iOS/Safari PWA: Web Push, офлайн, камера/микрофон, импорт шагов и сна

> Проверено: 24 ноября 2026. Целевая платформа: iPhone, приложение установлено на экран «Домой» (Home Screen web app).
> Ссылки вида [A1] ведут в раздел «Источники». Пометка **(вывод)** означает наше заключение, а не прямую цитату источника.

## Контекст версий

- Текущая линейка — **iOS/iPadOS 27**: Safari 27.0 вышел в сентябре 2026, 27.1 — 23.10.2026, 27.2 — 26.10.2026, 27.3 в бете [A21][A27]. Задача ставилась под iOS 26.x; всё ниже верно для 26.x и 27.x, если не оговорено иное.
- В просмотренных release notes Safari 26.0, 26.2–26.4, 27.0–27.2 **нет новых возможностей Web Push/Notifications** (в 27.0 только мелкий фикс URL-парсинга у `Notification`) [A6][A22][A21]. Последнее крупное изменение push — Declarative Web Push (Safari 18.4 на iOS, 18.5 на macOS) [A7][A3][A14].
- Что изменилось в 26.x/27.x и важно для нас:
  - 26.0: любой сайт, добавленный на «Домой», по умолчанию открывается как web app (переключатель «Open as Web App»), даже без manifest [A5][A6];
  - 26.0: в User-Agent заморожена версия ОС, поэтому версию iOS из UA определять нельзя [A6];
  - 26.0: в MediaRecorder добавлены ALAC и PCM [A6];
  - 26.4 и 27.0: Safari перестал перекодировать HEIC в JPEG при загрузке через `<input type=file>` [A22][A21];
  - 27.0: появился Service Worker static routing API [A21].

## TL;DR: что обязаны делать manifest, service worker и сервер

**Manifest** (`src/app/manifest.ts`)
- `display: "standalone"`, `id`, `start_url`, `scope: "/"`, `name`, `short_name`, `theme_color`, `lang: "ru"`.
- `apple-touch-icon` 180×180. Если он есть, iOS игнорирует иконки из manifest [A9].
- На iOS не поддерживаются `shortcuts`, `share_target`, `display_override`, `orientation`, `background_color` [A9].

**Service worker** (`/sw.js`, scope `/`)
- Отдавать с `Cache-Control: no-cache, no-store, must-revalidate`, регистрировать с `updateViaCache: 'none'` [A47].
- Обработчик `push` разбирает JSON декларативного формата и **всегда** вызывает `showNotification()` внутри `event.waitUntil()`. Без условий, не позже 30 с [A11].
- Обработчик `notificationclick` нужен для браузеров без декларативного push: открывает `notification.data.url`.
- Кэширует app shell и маршрут `/log`, чтобы deep link из уведомления открывался офлайн.
- Не полагаться на Background Sync, Periodic Sync, Background Fetch, `pushsubscriptionchange`, кнопки в уведомлениях, картинки в уведомлениях. Всё это на iOS отсутствует [A9][A10].

**Сервер**
- Стандартный Web Push (RFC 8030/8291/8292) через `web-push`. Payload — JSON `{"web_push": 8030, ...}` не больше 4 КБ [A1][A8].
- Всегда явно задавать `TTL`: по умолчанию в `web-push` он 4 недели [A48]. Также задавать `urgency` и `topic`.
- При ответах 404/410 удалять подписку [A1].

---

## 1. Web Push на iOS

### 1.1 Требования

| Требование | Детали | Источник |
|---|---|---|
| Только Home Screen web app | iOS/iPadOS 16.4+. Во вкладке Safari интерфейс `Notification` не определён | [A1][A2][A9] |
| Режим web app | В 16.4 требовался manifest с `display: standalone`/`fullscreen`. С iOS 26 любой добавленный сайт по умолчанию открывается как web app, но пользователь может выключить «Open as Web App» | [A2][A5] |
| Жест пользователя | Разрешение запрашивается только в ответ на тап. Apple: вызывать метод подписки «immediately from the gesture's event handler» | [A1][A2] |
| Стандарты | Push API, Notifications API, Service Workers, Badging API, VAPID. Apple Developer Program не нужен | [A1][A2] |
| Сеть сервера | TLS с SNI, HTTP/1.1 или HTTP/2. Если исходящий трафик фильтруется, разрешить `https://*.push.apple.com` | [A1] |
| `userVisibleOnly: true` | Обязателен: невидимые push Safari не поддерживает | [A1][A8] |
| Управление | Разрешения настраиваются отдельно для каждого web app в «Настройки → Уведомления». Работают Focus, экран блокировки и Apple Watch | [A2] |
| Несколько установок | Каждая установка — отдельное приложение (имя плюс manifest `id`) со своей подпиской | [A2] |

### 1.2 Отправка с сервера: заголовки, лимиты, ошибки

| Заголовок | Что делает (Apple) | Наше значение |
|---|---|---|
| `TTL` | Если push не доставлен сразу, сервис хранит его до 30 дней в зависимости от TTL. Число хранимых сообщений для офлайн-устройства ограничено | Напоминание о еде: 1800–3600 с. Weekly: 43200 с |
| `Urgency` | `very-low`, `low`, `normal`, `high`. `high` — попытка доставить немедленно, остальные учитывают энергосбережение | `high` для напоминаний о еде, `normal`/`low` для остального |
| `Topic` | Схлопывает недоставленные сообщения. До 32 символов URL-safe Base64 | `meal-lunch`, `weekly` |
| `Authorization` | VAPID JWT. Ключ обязан совпадать с ключом из `subscribe()`. JWT не обновлять чаще раза в час, `exp` не дальше 24 ч | См. ниже про `web-push` |
| Payload | Не больше 4 КБ (`PayloadTooLarge`) | Только текст и URL |

Коды ответа [A1]:
- `201` — принято.
- `400` — неверный запрос: `BadTtl`, `BadUrgency`, `BadWebPushTopic` и др.
- `403` — ошибка аутентификации: `BadJwtToken`, `VapidPkHashMismatch`.
- `404`/`410` — подписка недействительна; **удалить её**.
- `413` — payload слишком большой.
- `429` — слишком много запросов подряд на один device token; повторить с backoff.
- `500`/`503` — повтор с backoff.

Численных квот «на приложение» или «в день» Apple не публикует; ограничение одно — `429` [A1].

Про библиотеку `web-push` 4.0.0 из `package.json` (локальный исходник [A48]):
- **TTL по умолчанию — 4 недели (2419200 с).** Если его не задать, «обед?» может прийти через несколько дней, когда телефон выйдет в сеть.
- Urgency по умолчанию `normal`, шифрование `aes128gcm`.
- VAPID JWT генерируется заново на каждый вызов. Для одного пользователя с 2–4 push в день это далеко от лимита «раз в час». При пачках отправок можно кэшировать `getVapidHeaders(...)` на час и передавать `{ vapidDetails: null, headers: { Authorization } }`: библиотека тогда не генерирует свой JWT.
- Пакет — чистый ESM с **именованными** экспортами без `default`. Импортировать `import { sendNotification, setVapidDetails, WebPushError } from 'web-push'`. Default-импорт из Next.js-гайда к этой версии не подходит **(вывод по исходнику)**.

### 1.3 Что может показать уведомление на iOS

По IDL в исходниках WebKit [A10]:
- **Поддерживается:** `title`, `body`, `dir`, `lang`, `tag`, `icon`, `silent`, `data`, `navigate` (последний — для декларативного push).
- **Закомментировано, то есть не реализовано:** `image`, `badge`, `vibrate`, `timestamp`, `renotify`, `requireInteraction`, `actions`. Статического `maxActions` нет.

MDN BCD [A9] подтверждает: `actions`, `image`, `badge`, `requireInteraction`, `renotify`, `vibrate` и `timestamp` в Safari не поддерживаются, а `icon` «можно задать, но он ни на что не влияет»; iOS показывает иконку приложения. На iOS `silent: true` отключает звук (функция `platformShouldPlaySound` в WebKit) [A11].

Что это значит для нас:
- **Кнопок «Записать / Позже / Пропустить» в уведомлении нет.** «Позже» делаем первым экраном по deep link.
- Фото еды в уведомлении не показать: только заголовок и текст, писать коротко.
- Deep link передаём через `navigate`, а не только через `notificationclick`. Причина в истории багов: WebKit bug 263687 — по тапу Home Screen app открывался на корне, а не на URL из `openWindow()` (iOS 17). В 2025–2026 комментаторы не воспроизвели его на iOS 26.0 и 27.0.1 [A12]. BCD всё ещё помечает `notificationclick` на iOS как неподдерживаемый, это устарело **(вывод по [A10][A12])**.

### 1.4 Невидимых (silent) push нет: правило «трёх страйков»

- Apple: «Safari doesn't support invisible push notifications… If you don't, Safari revokes the push notification permission for your site.» [A1]
- Исходники WebKit (main) [A11]:
  - после доставки push в SW на вызов `showNotification` даётся **30 секунд** (`silentPushTimeoutForProduction { 30_s }`); иначе растёт счётчик «тихих» push;
  - при `maxSilentPushCount = 3` WebKit **удаляет все подписки этого origin**; кода, который уменьшал бы счётчик, мы не нашли;
  - на **декларативные** сообщения это не распространяется: «Declarative push messages can never result in a silent push timeout».
- Отсюда:
  - никаких data-only push для синхронизации или «разбудить приложение»;
  - нельзя пропускать показ уведомления по условию вроде «пользователь уже записал обед». Такое решение принимает сервер **до** отправки.

### 1.5 Declarative Web Push: используем

- **Доступность:** Safari 18.4 (iOS/iPadOS 18.4, Home Screen web apps, 31.03.2025) и Safari 18.5 на macOS [A4][A7][A14].
- **Формат** (W3C Push API, WD от 11.11.2026, и парсер WebKit) [A8][A13]:
  - верхний уровень: `web_push: 8030` (обязательно), `notification` (обязательно), `mutable` (boolean, по умолчанию `false`), `app_badge` (число или строка);
  - в `notification` обязательны `title` (непустой) и `navigate` (валидный URL); необязательны `body`, `lang`, `dir`, `tag`, `icon`, `silent`, `data`;
  - спецификация описывает также `image`, `badge`, `actions` и др.; WebKit их не реализует (см. 1.3);
  - WebKit пока принимает `mutable` и внутри `notification`, но это помечено как нестандартное и будет удалено (FIXME webkit.org/b/297389). Ставить только на верхний уровень.
- **Поведение** [A8][A3][A14]:
  - `mutable: false`: система показывает уведомление сама, service worker не участвует, тап открывает `navigate`;
  - `mutable: true`: SW получает `push` с `event.notification` («proposed notification»); если SW не показал замену, показывается исходное — без штрафа;
  - JSON с магическим ключом, но с невалидным уведомлением молча отбрасывается [A14];
  - JSON без магического ключа идёт старым путём, через SW.
- **`window.pushManager`** (Safari 18.4): подписка без service worker. Root-scoped SW делит с ним ту же подписку [A3][A9].
- **Другие браузеры:** по состоянию на 2026 декларативный push выпустил только Safari (по отраслевому обзору [A15]), сам формат уже в спецификации W3C [A8]. Fallback-обработчик в SW нужен для Chrome/Firefox, например при разработке на десктопе.
- **Почему стоит переходить:** уведомление приходит, даже когда SW выгружен или устройство под нагрузкой (WWDC25); нет риска страйков; меньше кода [A14][A3].
- **Решение:** все напоминания отправлять декларативно с `mutable: false`. `mutable: true` рассматривать позже, если понадобятся квитанции о доставке или правка текста на устройстве.

### 1.6 Badging API

- `navigator.setAppBadge(n)` и `clearAppBadge()` работают в Home Screen web app с iOS 16.4. Бейдж показывается после разрешения на уведомления; `0` убирает его [A1][A2][A9].
- В декларативном push — поле `app_badge` [A3][A13].
- **Продуктовое правило:** бейдж только для непрочитанного ответа коуча. Счётчик «пропущенных записей» бейджем не показывать: это давит виной (см. habit-retention.md).

### 1.7 Надёжность доставки и жизненный цикл подписки

- Доставка best-effort через APNs [A1]:
  - офлайн-устройству сообщение хранится в пределах TTL (до 30 дней), количество ограничено;
  - `Urgency: high` — попытка доставить немедленно.
- Событие `pushsubscriptionchange` на iOS не поддерживается [A9]. **При каждом запуске** делать `getSubscription()` и upsert на сервер (по уникальному `endpoint`).
- Хранилище Home Screen app изолировано от Safari [A16]. Удаление иконки с экрана «Домой» удаляет данные приложения, повторная установка создаёт новую подписку **(вывод)**. Сервер должен хранить несколько подписок на пользователя и чистить мёртвые по 404/410.
- Пользователь может выключить уведомления для приложения или фильтровать их через Focus [A2]. Статус проверять через `Notification.permission` и `PushManager.permissionState()`.

---

## 2. Хранилище и офлайн

### 2.1 Квоты и вытеснение (Safari 17+)

- Квота origin — до ~60% диска, общая — до ~80% (для browser apps). **Home Screen web app получает те же квоты, что и в браузере** [A17][A18].
- Вытеснение [A17][A18]:
  - удаляются все данные origin целиком, порядок LRU по последнему взаимодействию или операции с хранилищем;
  - причины: превышение общей квоты, нехватка места в системе, неактивность (ITP);
  - origin в persistent-режиме может быть исключён.
- `navigator.storage.persist()`: WebKit решает без диалога, по эвристикам, в том числе «открыт ли сайт как Home Screen Web App» [A17][A18].
- `estimate()` возвращает квоту без гарантий. Нужно обрабатывать `QuotaExceededError` [A17].

### 2.2 7-дневный лимит на script-writable storage

- ITP (март 2020) удаляет IndexedDB, localStorage, регистрации SW и Cache API после **7 дней использования Safari** без взаимодействия с сайтом [A19].
- Для Home Screen web apps у WebKit отдельный счётчик дней фактического использования приложения: «We do not expect the first-party in such a web application to have its website data deleted» [A19].
- MDN это исключение отдельно не подтверждает [A18].
- **Решение:** локальное хранилище — кэш и outbox, источник правды — Supabase. Outbox должен опустошаться быстро.

### 2.3 Изоляция от Safari и вход

- WebKit: «Home Screen apps are created as isolated entities without shared state with the browser» (bug 181849, by design) [A16].
- Следствие: входить нужно **внутри установленного приложения**. Magic link из письма откроется в Safari, и сессия окажется в чужом хранилище **(вывод)**.
- **Решение:** email OTP-код Supabase [A20]:
  - в шаблон письма добавить `{{ .Token }}`;
  - вызвать `signInWithOtp`, затем `verifyOtp({ email, token, type: 'email' })`;
  - код можно запрашивать раз в 60 с, живёт он 1 час.

### 2.4 Какие API доступны

| API | iOS Safari | Источник |
|---|---|---|
| IndexedDB, в том числе в SW | ✓ (в 27.0 исправлены восстановление IDB в workers и блокировки транзакций) | [A9][A21] |
| Cache API | ✓ | [A9] |
| OPFS (`storage.getDirectory`) | ✓ с 15.2 | [A9] |
| Web Locks (`navigator.locks`) | ✓ с 15.4 | [A9] |
| `storage.persist()` / `estimate()` | ✓ | [A9] |
| Background Sync (`SyncManager`) | ✗ | [A9] |
| Periodic Background Sync | ✗ | [A9] |
| Background Fetch | ✗ | [A9] |
| SW static routing (`InstallEvent.addRoutes`) | ✓ с 27.0 | [A9][A21] |

`experimental.useOffline` в Next.js 16.4 (локальная документация [A47]):
- повторяет soft navigations и Server Actions после восстановления сети;
- прямые `fetch()` из клиентских компонентов не покрывает;
- полная перезагрузка офлайн без SW не работает;
- отложенный запрос живёт в памяти вкладки, поэтому это **не durable outbox** **(вывод)**. Подходит для индикатора «нет сети» (`useOffline` из `next/offline`).

Как устроен outbox — раздел 6.4.

---

## 3. Камера и микрофон в standalone-режиме

### 3.1 Фото: `<input type="file" capture>`, а не getUserMedia

- `<input type="file" accept="image/*" capture="environment">` поддерживается на iOS с 10-й версии [A9]. Открывается системная камера, web-разрешение на камеру не нужно.
- Рядом — вторая кнопка без `capture` для выбора из галереи.
- `accept="audio/*"` на iOS не поддерживается (bug 242110) [A9]. Для голоса нужен MediaRecorder.
- **HEIC.** Safari 26.4: «Fixed image uploading to not transcode images when `accept="image/*"` is specified» [A22]. Safari 27.0: «Fixed an issue where HEIC images were incorrectly converted to JPEG when uploaded via … file input» [A21]. На свежих iOS **придут HEIC-файлы**, а многие vision-API принимают только JPEG/PNG/WebP.
- **Решение:** нормализовать на клиенте: `createImageBitmap(file)` → canvas → `toBlob('image/jpeg', 0.8)`, длинная сторона до 1600 px. Получается ~200–400 КБ вместо 2–5 МБ — и для outbox, и для AI. Сервер на всякий случай тоже принимает HEIC. Декодирование HEIC через `createImageBitmap` проверить на устройстве.

### 3.2 getUserMedia в Home Screen app: разрешение не запоминается

- WebKit bug 327237 (NEW, 12.10.2026, iOS 26.6.2) [A24]:
  - разрешение на камеру и микрофон в Home Screen app живёт только до конца текущего запуска;
  - после холодного старта запрос появляется снова;
  - в Safari есть «Разрешить» для сайта, у web app такой настройки нет.
- Bug 215884 [A25]: hash-навигация сбрасывала разрешение и глушила поток. Статус «RESOLVED CONFIGURATION CHANGED», жалобы шли до 2026.
- Apple Developer Forums [A26]: MediaRecorder в PWA работает при первом запуске и перестаёт после перезапуска (до перезагрузки телефона). Инженер WebKit: «We had issues with getUserMedia not always working in PWA».
- Исправления 27.x: аудиосессия теперь удерживается во время захвата (27.0) [A21]; исправлен вечный `NotAllowedError` после сброса аудиосервиса (27.2) [A27].
- **Решение:**
  - запрашивать микрофон только по тапу на кнопку записи и заранее сказать, что iOS может спрашивать при каждом запуске;
  - после записи всегда вызывать `stream.getTracks().forEach(t => t.stop())`;
  - на `visibilitychange: hidden` и `pagehide` — `recorder.stop()` и освобождение потока;
  - во время записи не трогать `location.hash`;
  - fallback: текстовое поле с системной диктовкой клавиатуры iOS (без web-разрешений).

### 3.3 MediaRecorder: MIME-типы на iOS

| Safari | Что пишет MediaRecorder | Источник |
|---|---|---|
| 14.x | MP4: H.264 + AAC | [A28][A9] |
| 18.4 | плюс WebM (Opus; VP8/VP9) и fragmented MP4 (ISOBMFF) | [A7][A4] |
| 26.0 | плюс ALAC и PCM | [A6] |

- **Рекомендация: на iOS писать `audio/mp4` (AAC).** Это самый давний и проверенный путь, есть на всех iOS 17–27, а сервисы транскрипции его принимают.
- `audio/webm;codecs=opus` — второй выбор: он есть с iOS 18.4 и это дефолт Chrome.
- Тип определять через `MediaRecorder.isTypeSupported()`, на сервер отправлять **фактический** `recorder.mimeType` и подходящее расширение (`.m4a`/`.mp4` или `.webm`).
- OpenAI speech-to-text принимает `mp4`, `m4a`, `webm`, `ogg` и др., до 25 МБ [A51]. Модели `whisper-1`, `gpt-4o-transcribe` и `gpt-4o-mini-transcribe` помечены deprecated с отключением 26.02.2027; рекомендуемая — `gpt-transcribe` [A51].

---

## 4. Шаги и сон

### 4.1 HealthKit из PWA недоступен

- HealthKit — нативный фреймворк. Доступ через entitlement и usage-ключи (`NSHealthShareUsageDescription`), разрешение на каждый тип данных отдельно [A31][A32].
- Web-API к Health в Safari нет (в release notes и BCD ничего подобного) **(вывод)**.
- Хранилище HealthKit зашифровано, пока устройство заблокировано: «your app may not be able to read data from the store when it runs in the background» [A31]. Это касается и Shortcuts **(вывод; сообщества подтверждают [A41])**.

### 4.2 Обходной путь без нативного кода: Shortcuts → webhook

**Действия Shortcuts:**
- `Find Health Samples` [A33]. Параметры: Type (`Steps`, `Sleep Analysis`), фильтр даты (`is today`, `is in the last N days`, `is between`), **Group by** (Minute…Year; Day даёт дневные суммы), Sort by, Order, Limit.
- `Get Details of Health Sample` [A34]: Value, Unit, Start Date, End Date, Duration, Source, Name.
- `Repeat with Each`, `Format Date` (ISO 8601), `Dictionary`.
- `Get Contents of URL` [A35]: метод POST (Show More), Headers, Request Body = JSON / Form / File.

**Триггеры:**
- iOS 26 [A36][A37]: «Автоматизация» → «Создать автоматизацию для себя» → триггер (Time of Day, Alarm, Sleep/Wake Up и др.) → выключить «Ask Before Running». Триггеры, которые могут выполняться без вопроса, включают Time of Day, Alarm, Sleep, Arrive, Leave, Charger и другие [A38].
- **iOS 27** [A38][A39]: автоматизации теперь встроены в сами шорткаты (Edit → Automation) и синхронизируются между устройствами. Есть «Privacy → Allow Running When Locked».

**Разрешения:**
- В «Здоровье» → Shortcuts → разрешить чтение Шагов и Сна. Если видна только часть данных, проверить «Allow Shortcuts to read data» [A33].
- В самом шорткате дать «Always Allow» на доступ к данным и к нашему домену [A40].

**Подводные камни:**
- Health шифруется на заблокированном телефоне. Запускать в моменты, когда телефон, скорее всего, разблокирован: «Будильник выключен» или «Пробуждение» утром. Сервер делает upsert, так что повторные отправки безопасны.
- Двойной счёт iPhone + Apple Watch при ручном суммировании сэмплов [A41]. Использовать `Group by: Day` или фильтр по Source и сверить с приложением «Здоровье».
- Данные сна могут появиться с задержкой после пробуждения [A41]. Утром отправлять прошлую ночь, а не только что начавшееся утро.

Пошаговый дизайн — раздел 6.6.

### 4.3 Что понадобится для нативного компаньона (HealthKit)

- Платный Apple Developer Program (для TestFlight/App Store); capability HealthKit и `NSHealthShareUsageDescription` в Info.plist, иначе приложение падает при запросе авторизации [A31].
- Чтение `stepCount` через `HKStatisticsCollectionQuery` с дневными интервалами (`cumulativeSum` разрешает перекрытие источников) [A44]; `sleepAnalysis` через выборку сэмплов или anchored query.
- Фоновая доставка [A32][A42]:
  - `HKObserverQuery` плюс `enableBackgroundDelivery(for:frequency:)` и entitlement `com.apple.developer.healthkit.background-delivery` (iOS 15+);
  - шаги приходят **не чаще раза в час**;
  - completion handler вызывать обязательно: после трёх неудач HealthKit перестаёт будить приложение.
- Повторять чтение после разблокировки: хранилище зашифровано, пока телефон заблокирован [A31].
- Политика конфиденциальности обязательна. Health-данные нельзя использовать для рекламы и передавать третьим лицам без явного согласия [A31].
- Распространение: TestFlight до 100 внутренних тестеров, сборка живёт 90 дней [A43].
- Минимальный объём: SwiftUI-оболочка «разрешить → синхронизировать» и тот же endpoint `/api/ingest/health`, что и у Shortcuts. Тогда серверный контракт один.

---

## 5. Установка на экран «Домой»

- `beforeinstallprompt` на iOS нет [A9]; программно установку не вызвать.
- Шаги по Apple для iOS 26/27 [A45]:
  1. Открыть сайт в Safari.
  2. Нажать «…» (Page Menu) → «Поделиться». При раскладке вкладок Bottom/Top — сразу кнопку «Поделиться».
  3. Выбрать «На экран "Домой"». Если пункта нет — «Изменить действия» внизу списка.
  4. Включить «Open as Web App» и нажать «Добавить».
- **Определить, что приложение уже установлено:**
  ```ts
  const isStandalone =
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches || // WebKit bug 264218: iOS может отдавать fullscreen
    (navigator as any).standalone === true;           // устаревшее, только iOS
  ```
  BCD отмечает, что в установленном приложении с `display: standalone` iOS может считать `display-mode: fullscreen` истинным [A9][A46]; поэтому проверяем оба значения.
- Версию iOS по UA не определять: начиная с iOS 26 она заморожена [A6]. Нужное определять по возможностям: `'pushManager' in window` для декларативного push, `'setAppBadge' in navigator`.
- Баннер установки:
  - показывать только во вкладке Safari (не в standalone) и после первого полезного действия, например первой записи еды;
  - три шага с картинками и пояснением «зачем»: напоминания, офлайн, полный экран;
  - «Не сейчас» скрывает баннер на 7 дней;
  - во встроенных браузерах мессенджеров предлагать «Открыть в Safari» **(вывод)**.

---

## 6. Решения для нашей реализации

### 6.1 Формат push payload

Один формат для всех браузеров. Safari показывает его сам, остальные — через SW.

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Обед?",
    "body": "Можно просто фото тарелки — 10 секунд.",
    "navigate": "https://<домен>/log?slot=lunch&rid=7f3c…&src=push",
    "lang": "ru",
    "dir": "ltr",
    "tag": "meal-lunch-2026-11-24",
    "data": { "rid": "7f3c…", "kind": "meal_reminder", "slot": "lunch" }
  },
  "app_badge": 0
}
```

| Тип | Когда | TTL, с | Urgency | Topic |
|---|---|---|---|---|
| `meal_reminder` | Персональное окно приёма пищи, если ещё нет записи | 1800–3600 | high | `meal-<slot>` |
| `snooze_followup` | После «Позже» (30/60 мин), не больше одного раза на слот | 1800 | high | тот же `meal-<slot>` |
| `context_nudge` | Длинный пробел в записях, событие из Shortcuts | 3600 | normal | `nudge` |
| `coach_reply` | Готов ответ коуча на фото или голос | 21600 | normal | `coach` |
| `weekly_reflection` | Вс вечер или пн утро | 43200 | low | `weekly` |

Правила:
- `rid` в URL нужен, чтобы засчитать открытие: при `mutable: false` SW не участвует, поэтому открытие фиксирует сама страница `/log`.
- `tag` поддерживается в WebKit, но замена уведомления по `tag` на iOS не гарантирована — проверить на устройстве [A9][A10].
- Длинные тексты не отправлять (лимит 4 КБ).

Отправка (Node, `web-push` 4.0):

```ts
import { sendNotification, setVapidDetails, WebPushError } from 'web-push';

setVapidDetails('mailto:<ops-адрес>', process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);

export async function sendReminder(sub: PushSubscriptionJSON, payload: object, opts: { ttl: number; urgency: 'high' | 'normal' | 'low'; topic: string }) {
  try {
    await sendNotification(sub as any, JSON.stringify(payload), { TTL: opts.ttl, urgency: opts.urgency, topic: opts.topic });
  } catch (e) {
    if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) {
      /* удалить подписку */
    }
    /* 429/5xx → повтор с экспоненциальным backoff; 400/403/413 → лог и алерт */
  }
}
```

### 6.2 Поведение service worker

```js
// public/sw.js: fallback для браузеров без Declarative Web Push (и для mutable)
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let msg = {};
    try { msg = event.data ? event.data.json() : {}; } catch { /* не JSON */ }
    const n = (msg && msg.web_push === 8030 && msg.notification) || {};
    const url = n.navigate || '/';
    // Показываем ВСЕГДА и безусловно, иначе Safari засчитает «тихий push» (3 → отписка).
    await self.registration.showNotification(n.title || 'Дневник питания', {
      body: n.body, lang: n.lang || 'ru', dir: n.dir || 'auto', tag: n.tag,
      silent: n.silent, data: { ...(n.data || {}), url }, navigate: url,
    });
    if (msg.app_badge !== undefined && self.navigator.setAppBadge) {
      await self.navigator.setAppBadge(Number(msg.app_badge)).catch(() => {});
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      await w.focus();
      if ('navigate' in w) await w.navigate(url).catch(() => {});
      return;
    }
    await clients.openWindow(url);
  })());
});
```

Помимо этого SW:
- кэширует app shell, иконки, шрифты и страницу `/log`; для страниц стратегия network-first с fallback на кэш;
- **не** кэширует API и ответы Supabase. В Safari 27 запросы к API можно пускать мимо SW через static routing (`addRoutes`) [A21].

### 6.3 Поток получения разрешения

1. Регистрируем SW при старте приложения и сохраняем `registration` в модульной переменной. Тогда в обработчике тапа `subscribe()` — первый и единственный `await`, и жест пользователя не теряется.
2. Push не предлагаем до установки (во вкладке Safari его нет) и до первой успешной записи еды (пользователь уже увидел пользу) **(практика)**.
3. Мягкий запрос — свой экран: «Напомню о приёме пищи до 2 раз в день, в ваши окна. Тихие часы — ночью. Можно выключить в любой момент». Кнопки «Включить» и «Не сейчас».
4. По «Включить»: `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. Это вызывает системный запрос iOS. Затем POST подписки, IANA-таймзоны и окон приёма пищи на `/api/push/subscriptions`.
5. Сразу отправляем тестовое уведомление «Готово, так будут выглядеть напоминания».
6. При отказе (`Notification.permission === 'denied'`) повторно спросить нельзя. Показываем инструкцию: «Настройки → Уведомления → <имя приложения>».
7. При каждом запуске: `getSubscription()` и upsert на сервер. Если разрешение есть, а подписки нет — кнопка «Восстановить напоминания».

### 6.4 Офлайн-outbox

**Хранилище** — IndexedDB, два store (через `idb-keyval` с `createStore` или тонкую обёртку):

```ts
type OutboxOp = {
  opId: string;          // UUID с клиента = idempotency key
  userId: string;        // защита от отправки после смены аккаунта
  kind: 'meal.upsert' | 'meal.delete' | 'voice.note' | 'water.log';
  entityId: string;      // client_id записи (UUID), стабилен между повторами
  payload: unknown;      // валидируется zod и на клиенте, и на сервере
  mediaKeys: string[];   // ключи Blob в store `media` (JPEG ≤ ~400 КБ, аудио ≤ 60 с)
  eatenAt: string;       // ISO-время еды + отдельно IANA-таймзона пользователя
  tz: string;
  attempts: number;
  nextAttemptAt: number; // epoch ms
  state: 'pending' | 'inflight' | 'failed';
  lastError?: string;
};
```

**Запись:**
- запись сразу попадает в outbox, UI показывает её оптимистично (серверные данные плюс pending-операции);
- сразу после этого — попытка отправки.

**Когда отправлять** (Background Sync нет):
- при старте приложения;
- на `visibilitychange → visible`, `pageshow`, `online`;
- сразу после постановки операции в очередь;
- по таймеру, пока приложение на экране: backoff 5 с → 15 с → 1 мин → 5 мин → 15 мин с джиттером;
- по кнопке «Синхронизировать».

**Один flush за раз:** `navigator.locks.request('outbox-flush', { ifAvailable: true }, …)` (Web Locks ✓) [A9].

**Алгоритм flush:**
1. Обновить сессию Supabase. Если она не обновляется — остановиться и попросить войти (OTP); операции сохранить.
2. Для каждой операции по порядку загрузить медиа в Storage по детерминированному пути `meals/{user_id}/{client_id}.jpg` с `upsert: true` (идемпотентно).
3. Затем POST `/api/sync` с `opId`. На сервере:
   - таблица `applied_ops(op_id primary key)` отсекает повторы;
   - `meals` делает upsert по `client_id` (unique);
   - RLS по `user_id`.
4. Обработка ответа:
   - `2xx` или «уже применено» → удалить операцию и её blobs;
   - `4xx` валидации → `failed`, показать пользователю;
   - сеть или `5xx` → `attempts++` и новый `nextAttemptAt`.

**Надёжность:**
- после установки и входа вызвать `navigator.storage.persist()`;
- следить за `estimate()`;
- отправленные медиа удалять сразу.

**Как пользователь видит синхронизацию:**
- неназойливая метка «3 записи ждут сети»;
- индикатор офлайна — через `useOffline()` (Next 16.4) [A47].

**Сервер принимает решения сам.** Напоминание не отправляется, если запись за слот уже есть. Чтобы сервер успевал это знать, outbox надо опустошать при каждом открытии приложения.

**Опционально (P2), если перейдём на `mutable: true`:** в обработчике `push` сначала показать уведомление, потом попробовать отправить outbox. Отложено: нужно проверить на устройстве, что SW действительно будится.

### 6.5 Аудио

```ts
const CANDIDATES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
export const pickAudioMime = () =>
  typeof MediaRecorder === 'undefined' ? null
    : CANDIDATES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
// new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 })
// после stop(): type = rec.mimeType || mimeType; ext = type.startsWith('audio/mp4') ? 'm4a' : 'webm'
```

- Лимит записи 60–90 с с таймером на экране.
- Без `timeslice`, одним Blob: так проще и надёжнее для MP4. Если запись прервалась, сохраняем то, что есть.
- Blob кладём в outbox, транскрипция — на сервере после синхронизации.

### 6.6 Импорт шагов и сна через Shortcuts

**Сервер:**
- `POST /api/ingest/health`, заголовок `Authorization: Bearer <токен>`;
- токен генерируется в настройках приложения, хранится только его хеш, можно отозвать;
- rate limit;
- валидация zod;
- upsert `daily_steps(user_id, date)`; сырые сегменты сна хранятся отдельно, а `sleep_minutes` считается на сервере: исключаем `In Bed`/`Awake`, сливаем перекрытия, при конфликте источников предпочитаем Watch.

```json
{
  "schema": 1,
  "sentAt": "2026-11-24T06:42:10Z",
  "steps": [{ "date": "2026-11-23", "count": 8421 }, { "date": "2026-11-24", "count": 312 }],
  "sleep": [
    { "start": "2026-11-23T21:41:00Z", "end": "2026-11-24T01:05:00Z", "value": "Core", "source": "Apple Watch" }
  ]
}
```

**Шорткат «Синхронизация с дневником»** (выдаём iCloud-ссылкой с инструкцией; токен пользователь вставляет в действие Text):
1. `Find Health Samples`: Type = Steps, Start Date is in the last 2 days, **Group by Day**, Sort by Start Date → `Repeat with Each` → `Get Details of Health Sample` (Start Date, Value) → `Format Date` (yyyy-MM-dd) → `Dictionary {date, count}` → `Add to Variable steps`.
2. `Find Health Samples`: Type = Sleep Analysis, Start Date is in the last 1 day → `Repeat with Each` → `Get Details` (Start Date, End Date, Value, Source) → `Dictionary` → `Add to Variable sleep`.
3. `Dictionary {schema: 1, steps, sleep, sentAt: Current Date (ISO 8601)}`.
4. `Get Contents of URL`: Method POST; Headers `Authorization: Bearer <токен>`, `Content-Type: application/json`; Request Body = File со словарём из шага 3 (или JSON-поля) [A35].
5. Автоматизация:
   - iOS 26: «Будильник выключен» или «Пробуждение» плюс опционально «21:30»; «Ask Before Running» выключен;
   - iOS 27: Edit → Automation в самом шорткате, «Allow Running When Locked».
   - Первый запуск вручную, чтобы выдать «Always Allow» на Health и наш домен [A36][A37][A38][A40].

**Проверка:** сверить шаги со значением в приложении «Здоровье» за 3 дня. Если сумма больше — включить фильтр Source по Watch [A41].

**Контекстные триггеры через Shortcuts (опционально):** «Arrive/Leave» (уход с работы → подсказка спланировать ужин) отправляют POST `/api/context`, и уже сервер решает, слать ли push. Работает без геолокации в PWA, но требует настройки от пользователя.

### 6.7 Планировщик на сервере

- **Supabase Cron** (pg_cron): интервалы от 1 секунды до года, умеет делать HTTP-вызовы (Edge Function или наш route). Рекомендация Supabase — не больше 8 одновременных jobs и до 10 минут на job [A49].
- **Схема:** раз в минуту job выбирает «созревшие» напоминания из таблицы `scheduled_pushes` (в том числе разовые snooze) и вызывает `/api/push/dispatch`.
- **Почему не Vercel** [A50]:
  - Cron Jobs на Hobby — раз в сутки с точностью ±59 мин, на Pro — поминутно;
  - Vercel Schedules (beta) на Hobby — джиттер 15 минут.
  - Для «обед в 12:40» это слишком грубо, поэтому только Supabase Cron или Vercel Pro.

### 6.8 Чек-лист проверки на устройстве (iOS 26.x и 27.x)

1. Push при выгруженном приложении. Тап открывает `/log?slot=…` и фиксирует `rid`.
2. Телефон офлайн дольше TTL → устаревшее напоминание не приходит.
3. Удалить и снова установить приложение → новая подписка, старая отдаёт 410.
4. Focus «Сон» → уведомления не прорываются.
5. Микрофон: запрос после холодного старта; запись → свернуть приложение → корректный стоп и Blob.
6. Фото с камеры: приходит HEIC или JPEG → нормализация в JPEG работает.
7. Запись офлайн → выгрузить приложение → открыть → синхронизация без дублей (повторный POST того же `opId`).
8. Шорткат при заблокированном и разблокированном телефоне; сверка шагов с «Здоровьем».

---

## Источники

**Apple и WebKit: push, web apps**
- [A1] Apple Developer — Sending web push notifications in web apps and browsers. https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- [A2] WebKit Blog — Web Push for Web Apps on iOS and iPadOS (16.02.2023). https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- [A3] WebKit Blog — Meet Declarative Web Push. https://webkit.org/blog/16535/meet-declarative-web-push/
- [A4] WebKit Blog — WebKit Features in Safari 18.4. https://webkit.org/?p=16574
- [A5] WebKit Blog — News from WWDC25: Web technology coming this fall in Safari 26 beta. https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- [A6] Apple — Safari 26.0 Release Notes (15.09.2025). https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- [A7] Apple — Safari 18.4 Release Notes (31.03.2025). https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes
- [A8] W3C — Push API, Working Draft 11.11.2026 (Declarative push message). https://www.w3.org/TR/2026/WD-push-api-20261111/
- [A12] WebKit Bugzilla 263687 — notificationClick openWindow goes to PWA root. https://bugs.webkit.org/show_bug.cgi?id=263687
- [A14] Apple WWDC25, session 235 — Learn more about Declarative Web Push. https://developer.apple.com/videos/play/wwdc2025/235/
- [A15] Aimtell — The State of Declarative Web Push in 2026 (отраслевой обзор, вторичный источник). https://aimtell.com/blog/state-of-declarative-web-push-2026
- [A52] WHATWG — Notifications API Standard (семантика `navigate`, `tag`, `actions`). https://notifications.spec.whatwg.org/

**Исходники WebKit и данные совместимости**
- [A9] MDN browser-compat-data (ветка main, выгружено 24.11.2026): `api/Notification.json`, `api/ServiceWorkerRegistration.json`, `api/PushManager.json`, `api/PushEvent.json`, `api/Window.json`, `api/Navigator.json`, `api/ServiceWorkerGlobalScope.json`, `api/SyncManager.json`, `api/PeriodicSyncManager.json`, `api/BackgroundFetchManager.json`, `api/StorageManager.json`, `api/LockManager.json`, `api/MediaRecorder.json`, `api/InstallEvent.json`, `api/BeforeInstallPromptEvent.json`, `html/elements/input.json`, `css/at-rules/media.json`, `manifests/webapp/*.json`. https://github.com/mdn/browser-compat-data
- [A10] WebKit source — `NotificationOptions.idl`, `Notification.idl`, `NotificationEvent.idl`. https://github.com/WebKit/WebKit/tree/main/Source/WebCore/Modules/notifications
- [A11] WebKit source — `WebPushDaemonConstants.h` (`maxSilentPushCount = 3`), `NotificationData.h` (`silentPushTimeoutForProduction { 30_s }`), `webpushd/WebPushDaemon.mm`, `webpushd/PushService.mm`. https://github.com/WebKit/WebKit/blob/main/Source/WebKit/Shared/WebPushDaemonConstants.h ; https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/notifications/NotificationData.h ; https://github.com/WebKit/WebKit/blob/main/Source/WebKit/webpushd/WebPushDaemon.mm
- [A13] WebKit source — `NotificationJSONParser.cpp` (поля декларативного push). https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/notifications/NotificationJSONParser.cpp

**Хранилище и офлайн**
- [A16] WebKit Bugzilla 181849 — «Add to homescreen» apps don't share storage with Safari. https://bugs.webkit.org/show_bug.cgi?id=181849
- [A17] WebKit Blog — Updates to Storage Policy (10.08.2023). https://webkit.org/blog/14403/updates-to-storage-policy/
- [A18] MDN — Storage quotas and eviction criteria (изм. 05.01.2026). https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- [A19] WebKit Blog — Full Third-Party Cookie Blocking and More (24.03.2020). https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- [A20] Supabase — Passwordless email logins (OTP). https://supabase.com/docs/guides/auth/auth-email-passwordless

**Release notes Safari 26–27**
- [A21] Apple — Safari 27 Release Notes; WebKit — WebKit Features for Safari 27.0. https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes ; https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
- [A22] Apple — Safari 26.4 Release Notes (24.03.2026). https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes
- [A27] WebKit Blog — WebKit Features for Safari 27.2 (26.10.2026). https://webkit.org/blog/18515/webkit-features-for-safari-27-2/

**Камера и микрофон**
- [A24] WebKit Bugzilla 327237 — Home Screen web apps ask for camera/microphone permission again on every launch. https://bugs.webkit.org/show_bug.cgi?id=327237
- [A25] WebKit Bugzilla 215884 — getUserMedia recurring permissions prompts in standalone. https://bugs.webkit.org/show_bug.cgi?id=215884
- [A26] Apple Developer Forums — MediaRecorder as PWA on iOS (08.2025). https://developer.apple.com/forums/thread/797987
- [A28] WebKit Blog — MediaRecorder API (23.11.2020). https://webkit.org/blog/11353/mediarecorder-api/
- [A51] OpenAI — Speech to text guide (форматы, лимит 25 МБ, модели). https://developers.openai.com/api/docs/guides/speech-to-text

**HealthKit**
- [A31] Apple — HealthKit: Protecting user privacy. https://developer.apple.com/documentation/healthkit/protecting-user-privacy
- [A32] Apple — `enableBackgroundDelivery(for:frequency:withCompletion:)`. https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)
- [A42] Apple — `com.apple.developer.healthkit.background-delivery` entitlement. https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery
- [A43] Apple — TestFlight overview. https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview
- [A44] Apple — HealthKit: Executing statistics collection queries. https://developer.apple.com/documentation/healthkit/executing-statistics-collection-queries

**Shortcuts**
- [A33] Справочник действия Find Health Samples (M. Cassinelli). https://matthewcassinelli.com/actions/find-health-samples/
- [A34] Справочник действия Get Details of Health Sample (M. Cassinelli). https://matthewcassinelli.com/actions/get-details-of-health-sample/
- [A35] Apple — Request your first API in Shortcuts (Get Contents of URL). https://support.apple.com/guide/shortcuts/apd58d46713f/ios
- [A36] Apple — Create a new personal automation (iOS 26). https://support.apple.com/guide/shortcuts/create-a-new-personal-automation-apdfbdbd7123/9.0/ios/26
- [A37] Apple — Enable or disable a personal automation. https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios
- [A38] Apple — Add automations to Shortcuts (iOS 27). https://support.apple.com/guide/shortcuts/add-automations-apdfbdbd7123/ios
- [A39] Apple — New in iOS, iPadOS, macOS, watchOS, and visionOS 27 (26.10.2026). https://support.apple.com/en-us/149045
- [A40] Apple — Adjust privacy settings in Shortcuts. https://support.apple.com/guide/shortcuts/adjust-privacy-settings-apd961a4fc65/ios
- [A41] Сообщество (MacPowerUsers): двойной счёт шагов iPhone + Watch, границы дат. https://talk.macpowerusers.com/t/shortcut-to-calculate-sum-of-steps-walked-for-the-week/37000

**Установка**
- [A45] Apple — Turn a website into an app in Safari on iPhone. https://support.apple.com/guide/iphone/iphea86e5236/ios
- [A46] WebKit Bugzilla 264218 — display-mode media query is incorrect on full screen PWA. https://bugs.webkit.org/show_bug.cgi?id=264218

**Наш стек и инфраструктура**
- [A47] Next.js 16.4.6 docs (локально): `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`, `offline-support.md`
- [A48] `web-push` 4.0.0 (локально): `node_modules/web-push/src/web-push-lib.js`, `vapid-helper.js`, `index.js`
- [A49] Supabase — Cron. https://supabase.com/docs/guides/cron
- [A50] Vercel — Cron Jobs usage & pricing; Schedules limits. https://vercel.com/docs/cron-jobs/usage-and-pricing ; https://vercel.com/docs/schedules/limits
