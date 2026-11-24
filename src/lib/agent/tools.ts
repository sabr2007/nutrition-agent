import 'server-only';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDaySummary } from '@/lib/data/day';
import { listTemplates, saveMeal, markChecklist } from '@/lib/data/meals';
import { getProfile, todayFor, isTrainingDay, goalForDay, type Profile } from '@/lib/data/profile';
import { addDays, instantForLocal, localParts, isoWeekdayOf } from '@/lib/nutrition/day';
import { macrosFor, r1 } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';
import { pickBest, searchFoodsSmart } from '@/lib/recognition/match';
import { personalContext } from '@/lib/recognition/pipeline';
import { LabelOutput, normalizeLabel } from '@/lib/recognition/label';
import { createPersonalFood } from '@/lib/data/foods';
import type { AgentAction, LoggedMeal } from '@/lib/chat/protocol';
import { suggestForRemaining } from './suggest';
import { buildShoppingList } from './shopping';
import { getTrends } from './trends';

export type ToolCtx = {
  sb: SupabaseClient;
  userId: string;
  profile: Profile;
  runId: string;
  trigger: 'chat' | 'cron' | 'event' | 'rule' | 'eval' | 'system';
  /** Collected UI side effects (buttons, proposed memories, confirmations, sent messages). */
  ui: AgentUi;
  /** In eval mode writes are simulated. */
  dryRun?: boolean;
  /** Photos attached to the current chat message: meals logged from them keep the link. */
  photo?: { mediaIds: string[]; model: string };
};

export type PendingAction = { id: string; kind: 'update_goal' | 'delete_meal'; summary: string; params: Record<string, unknown> };
export type AgentUi = {
  choices?: { question: string; options: string[] };
  proposedMemories: { id: string; content: string }[];
  pendingActions: PendingAction[];
  sentMessages: string[];
  loggedMeals: LoggedMeal[];
  /** Other writes (weight, checklist, reminders…) shown as chips under the reply. */
  actions: AgentAction[];
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD local day; default today');
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);

const compactFood = (f: Food) => ({
  id: f.id, name: f.name_ru, state: f.state, kcal_100g: Number(f.kcal_100g), protein_100g: Number(f.protein_100g),
  fat_100g: Number(f.fat_100g), carbs_100g: Number(f.carbs_100g), portions: f.portions ?? [], confidence: f.confidence,
  kcal_range_100g: f.kcal_low_100g != null ? [Number(f.kcal_low_100g), Number(f.kcal_high_100g)] : null,
});

function dayOf(ctx: ToolCtx, date?: string): string {
  return date ?? todayFor(ctx.profile);
}

const METRIC_LABEL = { weight: 'Вес', waist: 'Талия', body_fat: 'Жир' } as const;

/**
 * Links a meal logged from chat photos to its raw inputs: one `recognitions` row per agent
 * run (kind photo), so photo → recognition → meal stays traceable like on the log screen.
 */
async function photoRecognition(ctx: ToolCtx, items: { name: string; grams: number }[]): Promise<string | null> {
  if (!ctx.photo?.mediaIds.length) return null;
  const { data, error } = await ctx.sb.from('recognitions').insert({
    user_id: ctx.userId, kind: 'photo', media_ids: ctx.photo.mediaIds, pipeline_version: 'chat-agent-v1', prompt_version: 'agent',
    runs: [{ provider: 'chatgpt', model: ctx.photo.model, run_id: ctx.runId }], result: { items }, status: 'done',
  }).select('id').single();
  if (error) return null;
  return data.id as string;
}

export function buildTools(ctx: ToolCtx): ToolSet {
  const { sb, userId } = ctx;

  return {
    get_day_summary: tool({
      description: 'Totals, goal ranges, remaining macros, meals and checklist for a local day. Call before giving any numbers.',
      inputSchema: z.object({ date: dateSchema }),
      execute: async ({ date }) => {
        const s = await getDaySummary(sb, userId, dayOf(ctx, date), ctx.profile);
        return {
          day: s.day, is_today: s.isToday, training_day: s.trainingDay, challenge_day: s.challengeDay,
          goal: s.goal && {
            name: s.goal.name, kcal: [s.goal.kcal_min, s.goal.kcal_max], kcal_floor: s.goal.kcal_floor,
            protein_g: [s.goal.protein_min_g, s.goal.protein_max_g], fat_g: [s.goal.fat_min_g, s.goal.fat_max_g],
            carbs_g: [s.goal.carbs_min_g, s.goal.carbs_max_g], success: s.goal.success_criteria,
          },
          totals: s.totals, remaining: s.remaining, status: s.status,
          meals: s.meals.map((m) => ({ id: m.id, time: localParts(new Date(m.eaten_at), ctx.profile.timezone).hhmm, title: m.title, slot: m.slot, kcal: m.kcal, protein_g: m.protein_g, items: m.items.map((i) => `${i.name} ${i.grams}г`) })),
          checklist: s.checklist.map((c) => ({ key: c.key, label: c.label, done: c.done, value: c.value, due: c.due_time })),
          now_local: localParts(new Date(), ctx.profile.timezone).hhmm,
        };
      },
    }),

    list_templates: tool({
      description: "User's meal templates (their typical day) with macros.",
      inputSchema: z.object({}),
      execute: async () => (await listTemplates(sb, userId)).map((t) => ({
        id: t.id, key: t.key, name: t.name, slot: t.slot, time: t.default_time, training_day_only: t.training_day_only,
        kcal: t.kcal, protein_g: t.protein_g, items: t.items.map((i) => `${i.foods.name_ru} ${Number(i.grams)}г`),
      })),
    }),

    search_foods: tool({
      description: 'Search the food database (per-100 g values). Use before logging unknown foods.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
      execute: async ({ query, limit }) => (await searchFoodsSmart(sb, query, limit ?? 5)).map(compactFood),
    }),

    log_meal: tool({
      description: 'Log eaten food. Each item: food_id (from search_foods) OR query, plus grams or count. Macros are computed by the database, never by you. Use template_key to log a template.',
      inputSchema: z.object({
        items: z.array(z.object({
          food_id: z.string().uuid().optional(),
          query: z.string().optional(),
          grams: z.number().positive().max(5000).optional(),
          count: z.number().positive().max(50).optional(),
          state: z.enum(['raw', 'cooked', 'dry', 'as_is']).optional(),
        })).max(20).optional(),
        template_key: z.string().optional(),
        time_local: hhmm.optional().describe('HH:MM local time it was eaten; default now'),
        date: dateSchema,
        slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'shake', 'supplement', 'late']).optional(),
        title: z.string().max(120).optional(),
        note: z.string().max(300).optional(),
      }),
      execute: async (args) => {
        const day = dayOf(ctx, args.date);
        const eatenAt = args.time_local ? instantForLocal(day, args.time_local.padStart(5, '0'), ctx.profile.timezone, ctx.profile.day_boundary_minutes) : new Date();
        const pc = await personalContext(sb, userId);
        let items: { food_id: string; name: string; grams: number; source: 'agent' | 'template' }[] = [];
        let checklistKey: string | null = null;
        let templateId: string | null = null;
        let slot: string | null = args.slot ?? null;
        let title = args.title ?? null;
        if (args.template_key) {
          const t = (await listTemplates(sb, userId)).find((x) => x.key === args.template_key || x.name === args.template_key);
          if (!t) return { error: `template not found: ${args.template_key}` };
          items = t.items.map((i) => ({ food_id: i.food_id, name: i.foods.name_ru, grams: Number(i.grams), source: 'template' as const }));
          checklistKey = t.checklist_key; templateId = t.id; slot = slot ?? t.slot; title = title ?? t.name;
        }
        const unresolved: string[] = [];
        for (const it of args.items ?? []) {
          let food: Food | undefined;
          if (it.food_id) {
            const { data } = await sb.from('foods').select('*').eq('id', it.food_id).maybeSingle();
            food = (data as Food) ?? undefined;
          } else if (it.query) {
            food = pickBest(await searchFoodsSmart(sb, it.query, 6), it.state, pc.preferred, it.query)?.food;
          }
          if (!food) { unresolved.push(it.query ?? it.food_id ?? '?'); continue; }
          const grams = it.grams ?? (it.count ? (food.portions?.[0]?.g ?? Number(food.default_portion_g ?? 100)) * it.count : Number(food.default_portion_g ?? 100));
          items.push({ food_id: food.id, name: food.name_ru, grams: r1(grams), source: 'agent' });
        }
        if (unresolved.length && !items.length) return { error: 'foods not found', unresolved, hint: 'call search_foods with simpler words or ask the user' };
        if (!items.length) return { error: 'nothing to log' };
        if (ctx.dryRun) {
          const { data: foods } = await sb.from('foods').select('*').in('id', items.map((i) => i.food_id));
          const byId = new Map((foods ?? []).map((f) => [f.id as string, f as Food]));
          const t = items.reduce((a, i) => { const f = byId.get(i.food_id)!; const m = macrosFor(i.grams, { kcal: Number(f.kcal_100g), protein: Number(f.protein_100g), fat: Number(f.fat_100g), carbs: Number(f.carbs_100g) }); return { kcal: a.kcal + m.kcal, protein_g: a.protein_g + m.protein_g }; }, { kcal: 0, protein_g: 0 });
          ctx.ui.loggedMeals.push({ id: 'dry-run', title: title ?? items.map((i) => i.name).join(', '), kcal: Math.round(t.kcal), protein_g: r1(t.protein_g) });
          return { saved: true, dry_run: true, items, kcal: Math.round(t.kcal), protein_g: r1(t.protein_g), unresolved };
        }
        // Honest uncertainty for the reply: kcal range from composite dishes, low-confidence items.
        const { data: fmeta } = await sb.from('foods').select('id, name_ru, kcal_100g, kcal_low_100g, kcal_high_100g, confidence').in('id', items.map((i) => i.food_id));
        const fm = new Map((fmeta ?? []).map((f) => [f.id as string, f]));
        const range = items.reduce((a, i) => {
          const f = fm.get(i.food_id);
          const mid = (Number(f?.kcal_100g ?? 0) * i.grams) / 100;
          return [a[0] + (f?.kcal_low_100g != null ? (Number(f.kcal_low_100g) * i.grams) / 100 : mid), a[1] + (f?.kcal_high_100g != null ? (Number(f.kcal_high_100g) * i.grams) / 100 : mid)];
        }, [0, 0]);
        const lowConfidence = items.filter((i) => fm.get(i.food_id)?.confidence === 'low').map((i) => i.name);
        const fromPhoto = !templateId && Boolean(ctx.photo?.mediaIds.length);
        const recognitionId = fromPhoto ? await photoRecognition(ctx, items.map((i) => ({ name: i.name, grams: i.grams }))) : null;
        const saved = await saveMeal(sb, userId, {
          eaten_at: eatenAt.toISOString(), slot, title: title ?? items.map((i) => i.name).slice(0, 3).join(', '),
          input_method: templateId ? 'template' : fromPhoto ? 'photo' : 'agent', template_id: templateId, note: args.note ?? null,
          recognition_id: recognitionId,
          client_id: `agent:${ctx.runId}:${JSON.stringify(items).length}:${items.map((i) => i.food_id.slice(0, 4) + i.grams).join('')}`.slice(0, 80),
          items,
        }, { checklistKey });
        ctx.ui.loggedMeals.push({ id: saved.id, title: title ?? items[0].name, kcal: Math.round(saved.kcal), protein_g: saved.protein_g });
        return {
          saved: true, meal_id: saved.id, day: saved.local_day, kcal: Math.round(saved.kcal), protein_g: saved.protein_g, fat_g: saved.fat_g, carbs_g: saved.carbs_g,
          kcal_range: range[1] - range[0] > 40 ? [Math.round(range[0]), Math.round(range[1])] : null,
          low_confidence_items: lowConfidence,
          note_for_reply: lowConfidence.length ? 'Оценка примерная: назови диапазон ккал и предложи уточнить граммы кнопками.' : null,
          items: items.map((i) => `${i.name} ${i.grams}г`), checklist_marked: saved.checklist, unresolved,
        };
      },
    }),

    edit_meal: tool({
      description: 'Edit a logged meal (creates a new version, history kept). Provide full new item list and/or new time.',
      inputSchema: z.object({
        meal_id: z.string().uuid(),
        items: z.array(z.object({ food_id: z.string().uuid(), grams: z.number().positive().max(5000) })).optional(),
        time_local: hhmm.optional(),
        slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'shake', 'supplement', 'late']).optional(),
      }),
      execute: async ({ meal_id, items, time_local, slot }) => {
        const { data: m } = await sb.from('meals').select('id, local_day, eaten_at, meal_items(food_id, name, grams, per100)').eq('id', meal_id).eq('user_id', userId).eq('is_current', true).maybeSingle();
        if (!m) return { error: 'meal not found or not current' };
        const newItems = items
          ? await Promise.all(items.map(async (i) => { const { data: f } = await sb.from('foods').select('name_ru').eq('id', i.food_id).single(); return { food_id: i.food_id, name: (f?.name_ru as string) ?? '?', grams: i.grams, source: 'agent' as const, edited: true }; }))
          : ((m.meal_items ?? []) as { food_id: string | null; name: string; grams: number; per100: { kcal: number; protein: number; fat: number; carbs: number } | null }[]).map((i) => ({ food_id: i.food_id, name: i.name, grams: Number(i.grams), per100: i.per100, source: 'agent' as const }));
        if (ctx.dryRun) return { saved: true, dry_run: true };
        const eatenAt = time_local ? instantForLocal(m.local_day as string, time_local.padStart(5, '0'), ctx.profile.timezone, ctx.profile.day_boundary_minutes).toISOString() : (m.eaten_at as string);
        const saved = await saveMeal(sb, userId, { supersedes_id: meal_id, eaten_at: eatenAt, slot: slot ?? undefined, input_method: 'agent', items: newItems });
        ctx.ui.actions.push({ kind: 'meal_edit', text: `Приём исправлен · ${Math.round(saved.kcal)} ккал · б ${r1(saved.protein_g)}` });
        return { saved: true, meal_id: saved.id, kcal: Math.round(saved.kcal), protein_g: saved.protein_g };
      },
    }),

    delete_meal: tool({
      description: 'Request deletion of a meal. Requires the user to confirm with a button; do not claim it is deleted.',
      inputSchema: z.object({ meal_id: z.string().uuid(), reason: z.string().max(200).optional() }),
      execute: async ({ meal_id }) => {
        const { data: m } = await sb.from('meals').select('id, title, kcal').eq('id', meal_id).eq('user_id', userId).eq('is_current', true).maybeSingle();
        if (!m) return { error: 'meal not found' };
        const action: PendingAction = { id: crypto.randomUUID(), kind: 'delete_meal', summary: `Удалить «${m.title ?? 'приём'}» (${Math.round(Number(m.kcal))} ккал)?`, params: { meal_id } };
        ctx.ui.pendingActions.push(action);
        return { status: 'awaiting_user_confirmation', summary: action.summary };
      },
    }),

    update_checklist: tool({
      description: 'Mark a checklist item (keys: weigh, breakfast, creatine, protein_1, banana_pre, workout, protein_2, lunch, dinner, prep_chicken, tvorog, steps, sleep, close_day). For steps/sleep pass value.',
      inputSchema: z.object({ key: z.string(), done: z.boolean().default(true), value: z.number().optional(), date: dateSchema }),
      execute: async ({ key, done, value, date }) => {
        if (ctx.dryRun) return { ok: true, dry_run: true };
        await markChecklist(sb, userId, dayOf(ctx, date), key, done, 'agent', value ?? null);
        const { data: item } = await sb.from('checklist_items').select('label').eq('user_id', userId).eq('key', key).maybeSingle();
        const label = (item?.label as string | undefined) ?? key;
        ctx.ui.actions.push({ kind: 'checklist', text: `${done ? '✓' : '○'} ${label}${value != null ? ` · ${value}` : ''}` });
        return { ok: true, key, done, value: value ?? null };
      },
    }),

    log_body_metric: tool({
      description: 'Log weight (kg), waist (cm) or body fat (%).',
      inputSchema: z.object({ kind: z.enum(['weight', 'waist', 'body_fat']), value: z.number().positive().max(400), fasted: z.boolean().optional(), date: dateSchema }),
      execute: async ({ kind, value, fasted, date }) => {
        if (ctx.dryRun) return { ok: true, dry_run: true };
        const unit = kind === 'weight' ? 'kg' : kind === 'waist' ? 'cm' : '%';
        // Backdated measurements are pinned to the user's wake-up time (end of quiet hours).
        const measuredAt = date ? instantForLocal(date, ctx.profile.quiet_end, ctx.profile.timezone, ctx.profile.day_boundary_minutes).toISOString() : new Date().toISOString();
        const { error } = await sb.from('body_metrics').insert({ user_id: userId, kind, value, unit, fasted: fasted ?? null, measured_at: measuredAt });
        if (error) return { error: error.message };
        if (kind === 'weight') await markChecklist(sb, userId, dayOf(ctx, date), 'weigh', true, 'agent');
        ctx.ui.actions.push({ kind: 'body', text: `${METRIC_LABEL[kind]} ${value} ${unit === '%' ? '%' : unit === 'kg' ? 'кг' : 'см'}${date ? ` · ${date}` : ''}` });
        return { ok: true, kind, value, unit };
      },
    }),

    log_slip: tool({
      description: 'Record a slip/overeating episode without judgment: trigger, place, feeling, and an if-then plan for next time.',
      inputSchema: z.object({
        trigger: z.enum(['hunger', 'stress', 'social', 'tired', 'boredom', 'craving', 'other']).optional(),
        location: z.string().max(120).optional(), feeling: z.string().max(120).optional(),
        description: z.string().max(500).optional(), plan_next_time: z.string().max(300).optional(),
        meal_id: z.string().uuid().optional(),
      }),
      execute: async (a) => {
        if (ctx.dryRun) return { ok: true, dry_run: true };
        const { data, error } = await sb.from('slips').insert({ user_id: userId, ...a }).select('id').single();
        if (error) return { error: error.message };
        ctx.ui.actions.push({ kind: 'slip', text: 'Срыв записан — это данные, не провал' });
        return { ok: true, slip_id: data.id };
      },
    }),

    get_trends: tool({
      description: 'Trends over N days: per-day kcal/protein, days in plan, weight (7-day average), waist, slips with triggers.',
      inputSchema: z.object({ days: z.number().int().min(3).max(60).default(7) }),
      execute: async ({ days }) => getTrends(sb, userId, ctx.profile, days),
    }),

    suggest_meal_for_remaining_macros: tool({
      description: 'Deterministic options (with grams) to cover remaining protein within the calorie budget, from foods the user usually has. Respects dislikes.',
      inputSchema: z.object({ protein_g: z.number().min(0).max(250).optional(), kcal_max: z.number().min(0).max(3000).optional(), before_sleep: z.boolean().optional() }),
      execute: async (a) => suggestForRemaining(sb, userId, ctx.profile, a),
    }),

    generate_recipe: tool({
      description: 'Save a simple recipe YOU composed; the tool computes macros per serving from the food database. Ingredients by query + grams (raw/dry weights).',
      inputSchema: z.object({
        title: z.string().max(120), servings: z.number().int().min(1).max(8).default(1),
        ingredients: z.array(z.object({ query: z.string(), grams: z.number().positive().max(3000) })).min(1).max(15),
        steps: z.array(z.string().max(300)).min(1).max(12), minutes: z.number().int().max(240).optional(), save: z.boolean().default(true),
      }),
      execute: async ({ title, servings, ingredients, steps, minutes, save }) => {
        const pc = await personalContext(sb, userId);
        const lines = await Promise.all(ingredients.map(async (ing) => {
          const best = pickBest(await searchFoodsSmart(sb, ing.query, 5), null, pc.preferred, ing.query);
          if (!best) return { query: ing.query, grams: ing.grams, missing: true as const };
          const f = best.food;
          return { query: ing.query, food: f.name_ru, food_id: f.id, grams: ing.grams, ...macrosFor(ing.grams, { kcal: Number(f.kcal_100g), protein: Number(f.protein_100g), fat: Number(f.fat_100g), carbs: Number(f.carbs_100g) }) };
        }));
        const found = lines.filter((l): l is Extract<typeof l, { food_id: string }> => 'food_id' in l);
        const total = found.reduce((a, l) => ({ kcal: a.kcal + l.kcal, protein_g: a.protein_g + l.protein_g, fat_g: a.fat_g + l.fat_g, carbs_g: a.carbs_g + l.carbs_g }), { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
        const perServing = { kcal: Math.round(total.kcal / servings), protein_g: r1(total.protein_g / servings), fat_g: r1(total.fat_g / servings), carbs_g: r1(total.carbs_g / servings) };
        let recipeId: string | null = null;
        if (save && !ctx.dryRun) {
          const { data } = await sb.from('recipes').insert({ user_id: userId, title, body: { servings, ingredients: lines, steps, minutes: minutes ?? null }, ...perServing, source: 'agent' }).select('id').single();
          recipeId = (data?.id as string) ?? null;
          if (recipeId) ctx.ui.actions.push({ kind: 'recipe', text: `Рецепт «${title}» сохранён · ${perServing.kcal} ккал/порция` });
        }
        return { recipe_id: recipeId, title, servings, per_serving: perServing, ingredients: lines.map((l) => ('missing' in l ? `${l.query}: НЕ НАЙДЕНО в базе` : `${l.food} ${l.grams}г`)) };
      },
    }),

    make_shopping_list: tool({
      description: 'Shopping list for N days from the meal templates (raw weights aggregated and rounded to packs).',
      inputSchema: z.object({ days: z.number().int().min(1).max(14).default(3), start_date: dateSchema }),
      execute: async ({ days, start_date }) => {
        const list = await buildShoppingList(sb, userId, ctx.profile, days, dayOf(ctx, start_date), !ctx.dryRun);
        if (!ctx.dryRun) ctx.ui.actions.push({ kind: 'shopping', text: `Список покупок на ${days} дн. сохранён` });
        return list;
      },
    }),

    schedule_reminder: tool({
      description: 'Schedule a one-off push reminder at a local time (respects quiet hours).',
      inputSchema: z.object({ time_local: hhmm, date: dateSchema, text: z.string().min(3).max(200) }),
      execute: async ({ time_local, date, text }) => {
        const day = dayOf(ctx, date);
        const at = instantForLocal(day, time_local.padStart(5, '0'), ctx.profile.timezone, ctx.profile.day_boundary_minutes);
        if (at.getTime() < Date.now() - 60_000) return { error: 'time is in the past' };
        if (ctx.dryRun) return { ok: true, dry_run: true };
        const { error } = await sb.from('notifications').insert({ user_id: userId, rule_key: 'agent_reminder', local_day: day, title: 'Напоминание', body: text, scheduled_for: at.toISOString(), status: 'pending', deep_link: '/' });
        if (error) return { error: error.message };
        ctx.ui.actions.push({ kind: 'reminder', text: `Напомню в ${time_local}${date ? ` (${date})` : ''}: ${text}` });
        return { ok: true, at_local: `${day} ${time_local}` };
      },
    }),

    update_goal: tool({
      description: 'Propose a change to the current goal (calories/macros/steps). Requires user confirmation via button. Never below 1500 kcal.',
      inputSchema: z.object({
        changes: z.object({
          kcal_min: z.number().int().min(1500).max(5000).optional(), kcal_max: z.number().int().min(1500).max(5000).optional(),
          protein_min_g: z.number().int().min(40).max(300).optional(), protein_max_g: z.number().int().min(40).max(350).optional(),
          fat_min_g: z.number().int().min(30).max(200).optional(), fat_max_g: z.number().int().min(30).max(250).optional(),
          carbs_min_g: z.number().int().min(0).max(600).optional(), carbs_max_g: z.number().int().min(0).max(700).optional(),
          steps_min: z.number().int().min(0).max(40000).optional(),
        }),
        reason: z.string().max(300),
      }),
      execute: async ({ changes, reason }) => {
        const goal = await goalForDay(sb, userId, todayFor(ctx.profile));
        if (!goal) return { error: 'no active goal' };
        const next = { ...goal, ...changes };
        if (next.kcal_min < 1500 || next.kcal_max < next.kcal_min) return { error: 'invalid: kcal must stay >= 1500 and max >= min' };
        const parts = Object.entries(changes).map(([k, v]) => `${k}: ${(goal as unknown as Record<string, unknown>)[k]} → ${v}`);
        const action: PendingAction = { id: crypto.randomUUID(), kind: 'update_goal', summary: `Изменить цель «${goal.name}»: ${parts.join(', ')}. Причина: ${reason}`, params: { goal_id: goal.id, changes } };
        ctx.ui.pendingActions.push(action);
        return { status: 'awaiting_user_confirmation', summary: action.summary };
      },
    }),

    remember_fact: tool({
      description: 'Save a durable fact about the user (routine, preference, pattern, summary). propose=true (default) asks the user with a button first; use propose=false only for day/week summaries or when the user explicitly asked to remember.',
      inputSchema: z.object({
        content: z.string().min(5).max(400),
        kind: z.enum(['fact', 'preference', 'pattern', 'routine', 'episode', 'day_summary', 'week_summary']),
        tags: z.array(z.string().max(30)).max(6).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        pinned: z.boolean().optional(),
        propose: z.boolean().default(true),
        supersedes_id: z.string().uuid().optional(),
      }),
      execute: async (a) => {
        if (ctx.dryRun) return { ok: true, dry_run: true, status: a.propose ? 'proposed' : 'active' };
        const { data: dup } = await sb.from('memories').select('id').eq('user_id', userId).eq('content', a.content).in('status', ['active', 'proposed']).limit(1);
        if (dup?.length) return { ok: true, duplicate: true, id: dup[0].id };
        const status = a.propose ? 'proposed' : 'active';
        const { data, error } = await sb.from('memories').insert({
          user_id: userId, kind: a.kind, content: a.content, tags: a.tags ?? [], importance: a.importance ?? 3,
          pinned: a.pinned ?? false, status, source: 'agent', supersedes_id: a.supersedes_id ?? null,
          ref_day: a.kind === 'day_summary' ? todayFor(ctx.profile) : null,
        }).select('id').single();
        if (error) return { error: error.message };
        if (a.supersedes_id && !a.propose) await sb.from('memories').update({ status: 'archived' }).eq('id', a.supersedes_id).eq('user_id', userId);
        if (a.propose) ctx.ui.proposedMemories.push({ id: data.id as string, content: a.content });
        else if (a.kind !== 'day_summary' && a.kind !== 'week_summary') ctx.ui.actions.push({ kind: 'memory', text: `Запомнил: ${a.content}` });
        return { ok: true, id: data.id, status };
      },
    }),

    search_memory: tool({
      description: 'Search long-term memory and history: saved facts/summaries, slips, past meals and messages. Filter by text and/or date range ("что я ел в прошлый вторник").',
      inputSchema: z.object({ query: z.string().max(200).optional(), date_from: dateSchema, date_to: dateSchema, limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ query, date_from, date_to, limit }) => {
        const lim = limit ?? 8;
        const q = query?.trim();
        const mem = sb.from('memories').select('id, kind, content, ref_day, created_at, status').eq('user_id', userId).in('status', ['active', 'proposed']).order('created_at', { ascending: false }).limit(lim);
        const slips = sb.from('slips').select('id, local_day, occurred_at, trigger, location, feeling, description, plan_next_time').eq('user_id', userId).order('occurred_at', { ascending: false }).limit(lim);
        const meals = sb.from('meals').select('id, local_day, eaten_at, title, kcal, protein_g, meal_items(name, grams)').eq('user_id', userId).eq('is_current', true).eq('status', 'confirmed').order('eaten_at', { ascending: false }).limit(lim * 3);
        const msgs = sb.from('agent_messages').select('role, text, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(lim);
        if (q) { mem.textSearch('tsv', q, { config: 'russian', type: 'websearch' }); msgs.textSearch('tsv', q, { config: 'russian', type: 'websearch' }); meals.ilike('title', `%${q.split(' ')[0]}%`); }
        if (date_from) { slips.gte('local_day', date_from); meals.gte('local_day', date_from); mem.gte('created_at', date_from); }
        if (date_to) { slips.lte('local_day', date_to); meals.lte('local_day', date_to); }
        const [m, s, me, ms] = await Promise.all([mem, slips, meals, msgs]);
        await sb.from('memories').update({ last_used_at: new Date().toISOString() }).in('id', (m.data ?? []).map((x) => x.id));
        return {
          memories: m.data ?? [], slips: s.data ?? [],
          meals: (me.data ?? []).map((x) => ({ day: x.local_day, time: localParts(new Date(x.eaten_at as string), ctx.profile.timezone).hhmm, title: x.title, kcal: Math.round(Number(x.kcal)), protein_g: Number(x.protein_g), items: ((x.meal_items ?? []) as { name: string; grams: number }[]).map((i) => `${i.name} ${Number(i.grams)}г`) })),
          messages: (ms.data ?? []).map((x) => ({ role: x.role, text: String(x.text).slice(0, 200), at: x.created_at })),
        };
      },
    }),

    get_calendar_context: tool({
      description: 'Schedule context for a day: training day and times, usual meal times, quiet hours, local time now, challenge timeline.',
      inputSchema: z.object({ date: dateSchema }),
      execute: async ({ date }) => {
        const day = dayOf(ctx, date);
        const p = await getProfile(sb, userId);
        const goal = await goalForDay(sb, userId, day);
        const templates = await listTemplates(sb, userId);
        const weekday = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][isoWeekdayOf(day)];
        return {
          day, weekday, training_day: isTrainingDay(p, day), training: p.training, quiet_hours: [p.quiet_start, p.quiet_end],
          now_local: localParts(new Date(), p.timezone).hhmm, today: todayFor(p),
          usual_schedule: templates.filter((t) => t.default_time && (!t.training_day_only || isTrainingDay(p, day))).map((t) => `${t.default_time} ${t.name}`),
          goal: goal ? { name: goal.name, ends_on: goal.ends_on, days_left: goal.ends_on ? Math.round((Date.parse(goal.ends_on) - Date.parse(day)) / 86_400_000) : null } : null,
          tomorrow: addDays(day, 1),
        };
      },
    }),

    save_label_food: tool({
      description: 'Save a packaged product from a nutrition label photo to the personal food base. Transcribe the printed numbers exactly (per 100 g and/or per serving); the code converts and checks them. Returns food_id for log_meal.',
      inputSchema: LabelOutput,
      execute: async (raw) => {
        let label;
        try {
          label = normalizeLabel(raw);
        } catch (e) {
          return { error: (e as Error).message };
        }
        const name = label.name ?? raw.name ?? 'Продукт с этикетки';
        if (ctx.dryRun) return { saved: true, dry_run: true, name, per100: label.per100, warnings: label.warnings.map((w) => w.text) };
        const { food, created } = await createPersonalFood(sb, userId, {
          name, brand: label.brand, state: label.state, kcal: label.per100.kcal, protein: label.per100.protein,
          fat: label.per100.fat, carbs: label.per100.carbs, fiber: label.per100.fiber, portion_g: label.servingG,
        }, 'chat');
        ctx.ui.actions.push({ kind: 'food', text: `${created ? 'Продукт сохранён' : 'Продукт уже был в базе'}: ${food.name_ru} · ${Math.round(Number(food.kcal_100g))} ккал/100 г` });
        return {
          saved: true, created, food_id: food.id, name: food.name_ru, per100: label.per100, serving_g: label.servingG,
          warnings: label.warnings.map((w) => w.text),
        };
      },
    }),

    load_skill: tool({
      description: 'Load the full procedure of a skill from the skills index before following it.',
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        const { data } = await sb.from('skills').select('id, key, version, title, body, tools, user_id, usage_count').eq('key', key).eq('is_current', true).eq('status', 'active')
          .or(`user_id.is.null,user_id.eq.${userId}`).order('user_id', { ascending: false, nullsFirst: false }).limit(1);
        const s = data?.[0];
        if (!s) return { error: `skill not found: ${key}` };
        if (s.user_id) await sb.from('skills').update({ usage_count: Number(s.usage_count) + 1, last_used_at: new Date().toISOString() }).eq('id', s.id);
        return { key: s.key, version: s.version, title: s.title, procedure: s.body, tools: s.tools };
      },
    }),

    ask_user: tool({
      description: 'Show the user 2–4 quick-reply buttons for a short question. Use instead of open questions when options are clear.',
      inputSchema: z.object({ question: z.string().max(200), options: z.array(z.string().max(40)).min(2).max(4) }),
      execute: async ({ question, options }) => {
        ctx.ui.choices = { question, options };
        return { shown: true };
      },
    }),

    send_message: tool({
      description: 'Proactive mode only: send the user one short message (push + chat). Do not call if you decided to stay silent.',
      inputSchema: z.object({ text: z.string().min(3).max(300) }),
      execute: async ({ text }) => {
        if (ctx.trigger === 'chat') return { error: 'not needed in chat: just answer' };
        ctx.ui.sentMessages.push(text);
        return { queued: true };
      },
    }),
  };
}

export function emptyUi(): AgentUi {
  return { proposedMemories: [], pendingActions: [], sentMessages: [], loggedMeals: [], actions: [] };
}
