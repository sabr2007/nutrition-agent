# Google Health API — что важно для v2

Проверено по документации 26.11.2026. Fitbit Web API выключен 02.11.2026; используем только Google Health API `https://health.googleapis.com/v4`. Источники: https://developers.google.com/health/ (setup, scopes, data-types, aggregate-data, endpoints, webhooks, app-verification, rate-limits, troubleshooting), REST-справочник `…/reference/rest/v4/users.dataTypes.dataPoints`.

## Подготовка (шаги владельца)
1. В Google Cloud включить **Google Health API** (`health.googleapis.com`); Data Access → добавить scopes «Google Health API»; Audience → External + test user (сам владелец).
2. В OAuth-клиенте (Web) указать redirect `https://<прод>/api/health/google/callback`.
3. На телефоне поставить приложение **Google Health**, войти тем же Google-аккаунтом, создать профиль или перенести Fitbit-аккаунт; браслет должен синхронизироваться с этим приложением.
- Связан ли аккаунт, видно только после входа: `GET /v4/users/me/identity` → 400 `ACCOUNT_NOT_LINKED` (не связан) или 403 «Could not mint UberMint…» (вошёл старый Fitbit-аккаунт).

## OAuth
- `https://accounts.google.com/o/oauth2/v2/auth?…&response_type=code&access_type=offline&prompt=consent&scope=…`; обмен и обновление — `POST https://oauth2.googleapis.com/token`; отзыв — `POST https://oauth2.googleapis.com/revoke` (`token=…`).
- Scopes (префикс `https://www.googleapis.com/auth/googlehealth.`): `activity_and_fitness.readonly` (шаги, активные/общие калории, тренировки), `health_metrics_and_measurements.readonly` (пульс, пульс покоя), `sleep.readonly`, по желанию `settings.readonly` (часовой пояс). Большинство — restricted.
- **Testing-режим: refresh-токен живёт 7 дней** (`refresh_token_expires_in: 604799`). Варианты: (а) Audience → «Publish app» в «In production» без верификации (предупреждение «unverified app», лимит 100 пользователей, токены долгоживущие); (б) новый проект в Personal-режиме (только для своего аккаунта, без верификации и без 7-дневного срока; для restricted Health-scopes не подтверждено). Полная верификация (CASA, $500–4500/год) нужна только для > 100 пользователей.

## Данные
| Что | dataType | Как читать | Поле |
|---|---|---|---|
| Шаги | `steps` | `POST …/dataPoints:dailyRollUp` | `steps.countSum` (строка) |
| Активные ккал | `active-energy-burned` | `dailyRollUp` | `activeEnergyBurned.kcalSum` |
| Все ккал | `total-calories` | `dailyRollUp` (≤ 14 дней) | `totalCalories.kcalSum` |
| Пульс покоя | `daily-resting-heart-rate` | `GET …/dataPoints?filter=daily_resting_heart_rate.date >= "YYYY-MM-DD"` | `beatsPerMinute` (строка) |
| Сон | `sleep` | `GET …/dataPoints:reconcile?filter=sleep.interval.civil_end_time >= "…"` (pageSize ≤ 25) | `interval`, `type` STAGES/CLASSIC, `stages[]`, `summary.minutesAsleep`, `stagesSummary[]`, `metadata.mainSleep` |
| Тренировки | `exercise` | `GET …/dataPoints?filter=exercise.interval.civil_start_time >= "…T00:00:00"` | `exerciseType`, `interval`, `activeDuration` ("900s"), `metricsSummary.caloriesKcal`, `averageHeartRateBeatsPerMinute` |
| Пульс | `heart-rate` | list по `heart_rate.sample_time.physical_time` или `rollUp` (≤ 14 дней) | `beatsPerMinute` / `beatsPerMinuteAvg` |

- `dailyRollUp`: тело `{"range":{"start":{"date":{y,m,d},"time":{}},"end":{…следующий день…}},"windowSizeDays":1}`; дни считаются по местному времени точек. Ключ дня — `civilStartTime.date`. Нулевые поля опускаются: `"time": {}` = полночь, нет значения = нет данных.
- 64-битные числа приходят строками (шаги, пульс, минуты сна), ккал — числами, длительности — `"900s"`.
- Пагинация `pageToken`/`nextPageToken` (пусто — конец). Список сортирован от новых к старым.
- Часовой пояс — `GET /v4/users/me/settings` (`timeZone`), нужен `settings.readonly`.
- Задержка: данные появляются после синхронизации приложения Google Health (~каждые 15 мин, пока открыто и рядом). `GET /v4/users/me/pairedDevices` → `lastSyncTime`.

## Вебхуки
Есть для steps, exercise, sleep, heart-rate, daily-resting-heart-rate (нет для калорий). Регистрация — `POST /v4/projects/{PROJECT_NUMBER}/subscribers` с OAuth `cloud-platform` и IAM-ролью (сервис-аккаунт), проверка двумя POST (`{"type":"verification"}`: с секретом → 200, без → 401), подпись ECDSA в `GOOGLE-HEALTH-API-SIGNATURE`; в уведомлении нет значений — данные всё равно надо дочитать. **Решение v2: опрос по cron каждые 15 минут** (проще, без сервис-аккаунта); вебхуки — следующий шаг.

## Лимиты
300 запросов/мин на пользователя (неверифицированное приложение — 2,5 QPS на пользователя); 429/503/504 — повтор с backoff.

## Примеры ответов (для фикстур тестов)
Шаги (`dailyRollUp`, дословно из доков):
```json
{"rollupDataPoints":[{"civilStartTime":{"date":{"year":2026,"month":2,"day":26},"time":{}},"civilEndTime":{"date":{"year":2026,"month":2,"day":27},"time":{}},"steps":{"countSum":"3822"}}]}
```
Сон (`reconcile`, сокращено из доков):
```json
{"dataPoints":[{"dataPointName":"users/user-id/dataTypes/sleep/dataPoints/data-point-id","sleep":{"interval":{"startTime":"2026-03-03T20:57:30Z","startUtcOffset":"0s","endTime":"2026-03-04T04:41:30Z","endUtcOffset":"0s"},"type":"STAGES","metadata":{"stagesStatus":"SUCCEEDED","processed":true,"mainSleep":true},"summary":{"minutesInSleepPeriod":"464","minutesAsleep":"407","minutesAwake":"57","stagesSummary":[{"type":"AWAKE","minutes":"56","count":"12"},{"type":"LIGHT","minutes":"198","count":"19"},{"type":"DEEP","minutes":"114","count":"10"},{"type":"REM","minutes":"94","count":"4"}]}}}],"nextPageToken":""}
```
Тренировка (`list`, восстановлено по полям из доков):
```json
{"dataPoints":[{"name":"users/123/dataTypes/exercise/dataPoints/8896720705097069096","dataSource":{"recordingMethod":"MANUAL","platform":"FITBIT"},"exercise":{"interval":{"startTime":"2026-02-23T13:10:00Z","startUtcOffset":"-18000s","endTime":"2026-02-23T13:25:00Z","endUtcOffset":"-18000s"},"exerciseType":"WALKING","metricsSummary":{"caloriesKcal":16,"steps":"2038","averageHeartRateBeatsPerMinute":"81"},"displayName":"Walk","activeDuration":"900s"}}],"nextPageToken":""}
```
Пульс покоя (собрано по схеме, не дословно):
```json
{"dataPoints":[{"dataSource":{"recordingMethod":"DERIVED","platform":"FITBIT"},"dailyRestingHeartRate":{"date":{"year":2026,"month":11,"day":25},"beatsPerMinute":"58"}}],"nextPageToken":""}
```
