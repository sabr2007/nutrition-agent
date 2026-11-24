# Исследования

| Тема | Файл | Главный вывод |
|---|---|---|
| Точность калорий по фото | [photo-accuracy.md](photo-accuracy.md) | модель распознаёт, база считает; граммы с весов и 1–2 вопроса дают больше всего; ориентир Gemini 3.0 Flash — MAE 81 ккал / MAPE 44% на Nutrition5k |
| Результаты нашего eval | [eval-results.md](eval-results.md) | Qwen 3.8 27B (Workers AI) — MAE 109 / MAPE 50%; ансамбль со слабой моделью хуже одной сильной |
| Evals агента | [agent-evals.md](agent-evals.md) | 10/10 сценариев после safety-слоя и подсказок намерения |
| Sign in with ChatGPT | [chatgpt-oauth.md](chatgpt-oauth.md) | официальный self-serve путь — для open-source/локальных приложений; loopback 127.0.0.1, PKCE, ротация refresh |
| LLM-провайдеры и цены | [llm-providers.md](llm-providers.md) | маршрутизация по задачам и порядок fallback |
| Уроки Hermes Agent | [hermes-lessons.md](hermes-lessons.md) | короткая память в промпте + поиск по истории, индекс навыков, SQL-гейт перед проактивностью, явное send/silent |
| iOS PWA и web push | [ios-pwa-push.md](ios-pwa-push.md) | Declarative Web Push, пуши только в установленной PWA по нажатию, нет Background Sync, Health — через «Команды» |
| Привычки и удержание | [habit-retention.md](habit-retention.md) | частота записи важнее полноты, ≤2 пушей в день, «never miss twice» вместо стриков, срыв — данные |
