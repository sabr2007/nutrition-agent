-- D24: foods named by the person (save_user_food) and an honest relevance gate.
--  * A food may know only its calories: protein/fat/carbs become nullable and such rows carry
--    confidence 'user_kcal_only' (meal items count unknown macros as 0 and flag them).
--  * One active personal row per name + brand for foods from the person's words or the web;
--    new numbers archive the old row (history stays), so later logs use what was said last.
--  * search_foods also returns aliases, so the app can see why a food matched.
--  * Personal foods join the event journal like other user tables.

alter table public.foods alter column protein_100g drop not null;
alter table public.foods alter column fat_100g drop not null;
alter table public.foods alter column carbs_100g drop not null;

alter table public.foods drop constraint if exists foods_confidence_check;
alter table public.foods add constraint foods_confidence_check
  check (confidence in ('high', 'medium', 'low', 'user_kcal_only'));

create unique index if not exists foods_user_named on public.foods (
  user_id, public.normalize_ru(name_ru), public.normalize_ru(coalesce(brand, ''))
) where user_id is not null and archived_at is null and source in ('user', 'web');

drop trigger if exists foods_journal on public.foods;
create trigger foods_journal after insert or update on public.foods
  for each row execute function public.tg_log_event();

drop function if exists public.search_foods(text, integer);
create function public.search_foods(q text, lim integer default 12)
returns table (
  id uuid, user_id uuid, source text, name_ru text, name_en text, brand text,
  barcode text, category text, state text, kcal_100g numeric, protein_100g numeric,
  fat_100g numeric, carbs_100g numeric, kcal_low_100g numeric, kcal_high_100g numeric,
  raw_food_id uuid, yield_factor numeric, default_portion_g numeric, portions jsonb,
  confidence text, aliases text[], score real
)
language sql
stable
set search_path = public, extensions
as $$
  with qq as (
    select public.normalize_ru(trim(q)) as s,
           websearch_to_tsquery('russian', public.normalize_ru(trim(q))) as tq_ru,
           websearch_to_tsquery('english', trim(q)) as tq_en
  )
  select f.id, f.user_id, f.source, f.name_ru, f.name_en, f.brand, f.barcode, f.category,
         f.state, f.kcal_100g, f.protein_100g, f.fat_100g, f.carbs_100g, f.kcal_low_100g,
         f.kcal_high_100g, f.raw_food_id, f.yield_factor, f.default_portion_g, f.portions,
         f.confidence, f.aliases,
         (greatest(similarity(f.search_text, qq.s), word_similarity(qq.s, f.search_text))
           + ts_rank(f.tsv, qq.tq_ru) + ts_rank(f.tsv, qq.tq_en) * 0.5
           + case when f.user_id is not null then 0.15 else 0 end
           + case when public.normalize_ru(f.name_ru) = qq.s then 0.6 else 0 end
           + case when public.normalize_ru(f.name_ru) like qq.s || '%' then 0.2 else 0 end
         )::real as score
  from public.foods f, qq
  where f.archived_at is null
    and length(qq.s) > 0
    and (
      f.search_text % qq.s
      or qq.s <% f.search_text
      or f.search_text like '%' || qq.s || '%'
      or f.tsv @@ qq.tq_ru
      or f.tsv @@ qq.tq_en
    )
  order by score desc, f.name_ru
  limit greatest(1, least(lim, 50))
$$;

revoke execute on function public.search_foods(text, integer) from public, anon;
grant execute on function public.search_foods(text, integer) to authenticated, service_role;
