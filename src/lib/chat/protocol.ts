// Chat wire format shared by the /api/chat route and the chat screen (no server-only imports).
// The route streams newline-delimited JSON events while the agent works.

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image'; media_id: string; path: string };

/** A meal the agent logged, shown as a card under its reply. fat/carbs are optional (older messages). */
export type LoggedMeal = { id: string; title: string; kcal: number; protein_g: number; fat_g?: number; carbs_g?: number };

export type AgentActionKind = 'meal_edit' | 'body' | 'checklist' | 'slip' | 'reminder' | 'recipe' | 'memory' | 'shopping' | 'food';
/** A write the agent made outside the meals list, shown as a chip under its reply. */
export type AgentAction = { kind: AgentActionKind; text: string };

export type ChatMeta = {
  choices?: { question: string; options: string[] } | null;
  proposed_memories?: { id: string; content: string; status?: string }[];
  pending_actions?: { id: string; kind: string; summary: string; status?: string }[];
  logged_meals?: LoggedMeal[];
  actions?: AgentAction[];
  model?: string;
  deep?: boolean;
};

export type ChatMessage = {
  id: string | null;
  role: 'user' | 'assistant';
  kind: string;
  text: string;
  parts?: ChatPart[];
  created_at: string;
  meta?: ChatMeta;
};

export type ChatEvent =
  | { t: 'tool'; name: string; label: string }
  | { t: 'text'; d: string }
  | { t: 'done'; message: ChatMessage; user: ChatMessage | null }
  | { t: 'error'; message: string };

/** What the person sees while the agent runs a tool. */
export const TOOL_LABELS: Record<string, string> = {
  get_day_summary: 'Смотрю день',
  list_templates: 'Смотрю шаблоны',
  search_foods: 'Ищу продукт в базе',
  log_meal: 'Записываю приём',
  edit_meal: 'Исправляю приём',
  delete_meal: 'Готовлю удаление',
  update_checklist: 'Отмечаю чек-лист',
  log_body_metric: 'Записываю замер',
  log_slip: 'Записываю срыв',
  get_trends: 'Смотрю динамику',
  suggest_meal_for_remaining_macros: 'Подбираю варианты',
  generate_recipe: 'Считаю рецепт',
  make_shopping_list: 'Составляю список покупок',
  schedule_reminder: 'Ставлю напоминание',
  update_goal: 'Готовлю изменение цели',
  remember_fact: 'Запоминаю',
  search_memory: 'Вспоминаю',
  get_calendar_context: 'Смотрю расписание',
  load_skill: 'Открываю навык',
  ask_user: 'Готовлю вопрос',
  save_label_food: 'Сохраняю продукт с этикетки',
  save_user_food: 'Сохраняю продукт с твоими цифрами',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? 'Работаю';
}

export function encodeEvent(e: ChatEvent): string {
  return `${JSON.stringify(e)}\n`;
}

/** Splits buffered NDJSON into events; an incomplete last line stays in `rest`. */
export function parseEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: ChatEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ChatEvent);
    } catch {
      // a malformed line is skipped; the final `done` event carries the full message anyway
    }
  }
  return { events, rest };
}

/** Text the model sees for a past user message that carried photos. */
export function historyText(text: string, parts: ChatPart[] | null | undefined): string {
  const photos = (parts ?? []).filter((p) => p.type === 'image').length;
  if (!photos) return text;
  const mark = photos > 1 ? `[фото ×${photos}]` : '[фото]';
  return text ? `${mark} ${text}` : mark;
}
