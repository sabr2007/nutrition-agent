-- v2 (D27): saturated fat and sugar, deterministic fat warnings.
--  * foods: satfat_100g, sugar_100g (nullable: unknown is not zero). Base foods from USDA SR
--    Legacy by NDB number (source_ref), FoodData Central CSV 2018-04 (public domain): nutrient
--    606 «Fatty acids, total saturated» and 269 «Sugars, total». Others stay null; no saturated-fat
--    warnings are made for them.
--  * meal_items / meals: satfat_g, sugar_g (meals: the sum over items that know it, else null).
--  * nudges: warnings already given (one fat warning per meal, at most three a day).

alter table public.foods add column if not exists satfat_100g numeric(6, 2) check (satfat_100g >= 0);
alter table public.foods add column if not exists sugar_100g numeric(6, 2) check (sugar_100g >= 0);
alter table public.meal_items add column if not exists satfat_g numeric(7, 1);
alter table public.meal_items add column if not exists sugar_g numeric(7, 1);
alter table public.meals add column if not exists satfat_g numeric(7, 1);
alter table public.meals add column if not exists sugar_g numeric(7, 1);

update public.foods f set satfat_100g = v.satfat, sugar_100g = v.sugar
from (values
  ('01009', 18.87, 0.48),
  ('01019', 13.30, 0.00),
  ('01022', 17.61, 2.22),
  ('01028', 10.11, 1.13),
  ('01032', 15.37, 0.07),
  ('01123', 3.13, 0.37),
  ('01124', 0.00, 0.71),
  ('01129', 3.27, 1.12),
  ('01132', 3.33, 1.39),
  ('01287', 1.23, 3.56),
  ('04018', 3.40, 10.02),
  ('04053', 13.81, 0.00),
  ('04584', 9.86, 0.00),
  ('05009', 3.79, 0.00),
  ('05062', 0.56, 0.00),
  ('05064', 1.01, 0.00),
  ('05066', 2.46, 0.00),
  ('05089', 3.00, null),
  ('05091', 4.52, 0.00),
  ('05219', 0.29, 0.05),
  ('05332', 2.30, 0.00),
  ('07028', 1.23, 0.00),
  ('08038', 0.34, 8.86),
  ('08120', 1.11, 0.99),
  ('08121', 0.31, 0.27),
  ('09003', 0.03, 10.39),
  ('09032', 0.02, 53.44),
  ('09037', 2.13, 0.66),
  ('09040', 0.11, 12.23),
  ('09050', 0.03, 9.96),
  ('09087', 0.03, 63.35),
  ('09089', 0.06, 16.26),
  ('09132', 0.05, 15.48),
  ('09176', 0.09, 13.66),
  ('09181', 0.05, 7.86),
  ('09195', 2.03, 0.54),
  ('09200', 0.01, 9.35),
  ('09206', 0.02, 8.40),
  ('09218', 0.04, 10.58),
  ('09252', 0.02, 9.75),
  ('09266', 0.01, 9.85),
  ('09298', 0.09, 65.18),
  ('09302', 0.02, 4.42),
  ('09316', 0.01, 4.89),
  ('09326', 0.02, 6.20),
  ('10093', 3.09, 0.00),
  ('10862', 11.96, 0.00),
  ('11011', 0.04, 1.88),
  ('11052', 0.05, 3.26),
  ('11080', 0.03, 6.76),
  ('11090', 0.11, 1.70),
  ('11098', 0.06, 2.20),
  ('11109', 0.03, 3.20),
  ('11124', 0.03, 4.74),
  ('11135', 0.13, 1.91),
  ('11143', 0.04, 1.34),
  ('11147', 0.03, 1.10),
  ('11205', 0.04, 1.67),
  ('11209', 0.03, 3.53),
  ('11215', 0.09, 1.00),
  ('11233', 0.18, 0.99),
  ('11251', 0.04, 1.19),
  ('11260', 0.05, 1.98),
  ('11282', 0.04, 4.24),
  ('11312', 0.07, 5.00),
  ('11352', 0.03, 0.82),
  ('11367', 0.03, 0.89),
  ('11380', 0.14, 3.47),
  ('11457', 0.06, 0.42),
  ('11477', 0.08, 2.50),
  ('11507', 0.02, 4.18),
  ('11529', 0.03, 2.63),
  ('11546', 0.10, 12.18),
  ('11549', 0.04, 3.56),
  ('11821', 0.06, 4.20),
  ('11935', 0.01, 21.27),
  ('11959', 0.09, 2.05),
  ('12036', 4.46, 2.62),
  ('12061', 3.80, 4.35),
  ('12155', 6.13, 2.61),
  ('14003', 0.00, 0.00),
  ('14209', 0.00, 0.00),
  ('14355', 0.00, 0.00),
  ('15236', 3.05, 0.00),
  ('15270', 0.10, null),
  ('16015', 0.14, 0.32),
  ('16033', 0.07, 0.32),
  ('16056', 0.60, 10.70),
  ('16057', 0.27, 4.80),
  ('16069', 0.15, 2.03),
  ('16070', 0.05, 1.80),
  ('16087', 6.28, 4.72),
  ('16098', 10.32, 10.49),
  ('16123', 0.07, 0.40),
  ('16427', 0.69, 0.62),
  ('18254', 5.43, 14.55),
  ('19120', 18.51, 51.50),
  ('19296', 0.00, 82.12),
  ('19335', 0.00, 99.80),
  ('19411', 3.40, 0.33),
  ('19904', 24.49, 23.99),
  ('20010', 0.13, 0.90),
  ('20012', 0.23, 0.41),
  ('20013', 0.04, 0.10),
  ('20029', 0.03, 0.10),
  ('20036', 0.59, 0.66),
  ('20045', 0.08, 0.05),
  ('20081', 0.15, 0.27),
  ('20120', 0.28, 2.67),
  ('20121', 0.18, 0.56),
  ('20137', 0.23, 0.87),
  ('20444', 0.18, 0.12),
  ('21238', 2.27, 0.21),
  ('23557', 2.18, 0.00),
  ('23584', 1.31, 0.00)
) as v(ref, satfat, sugar)
where f.user_id is null and f.source = 'usda_sr' and f.source_ref = v.ref;

create table if not exists public.nudges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  local_day date not null,
  kind text not null,
  meal_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists nudges_day on public.nudges (user_id, local_day, kind);
alter table public.nudges enable row level security;
create policy nudges_select_own on public.nudges for select to authenticated using (user_id = (select auth.uid()));
create policy nudges_insert_own on public.nudges for insert to authenticated with check (user_id = (select auth.uid()));
create trigger nudges_journal after insert or update on public.nudges for each row execute function public.tg_log_event();

-- save_meal: as before, plus satfat_g / sugar_g of items and their sums.
create or replace function public.save_meal(p jsonb)
returns public.meals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prev public.meals;
  m public.meals;
  existing public.meals;
  it jsonb;
  i integer := 0;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if p ? 'client_id' and p ->> 'client_id' is not null then
    select * into existing from public.meals
      where user_id = uid and client_id = p ->> 'client_id';
    if found then
      return existing; -- idempotent replay from offline outbox
    end if;
  end if;

  if p ? 'supersedes_id' and p ->> 'supersedes_id' is not null then
    select * into prev from public.meals
      where id = (p ->> 'supersedes_id')::uuid and user_id = uid and is_current
      for update;
    if not found then
      raise exception 'meal to edit not found or not current';
    end if;
    update public.meals set is_current = false where id = prev.id;
  end if;

  insert into public.meals (
    user_id, root_id, version, supersedes_id, status, eaten_at, slot, title, input_method,
    template_id, recognition_id, confidence, is_labeled, time_to_confirm_ms, note, client_id,
    local_day
  ) values (
    uid,
    prev.root_id,
    coalesce(prev.version, 0) + 1,
    prev.id,
    coalesce(p ->> 'status', 'confirmed'),
    coalesce((p ->> 'eaten_at')::timestamptz, prev.eaten_at, now()),
    coalesce(p ->> 'slot', prev.slot),
    coalesce(p ->> 'title', prev.title),
    coalesce(p ->> 'input_method', prev.input_method, 'manual'),
    coalesce((p ->> 'template_id')::uuid, prev.template_id),
    coalesce((p ->> 'recognition_id')::uuid, prev.recognition_id),
    coalesce((p ->> 'confidence')::numeric, prev.confidence),
    coalesce((p ->> 'is_labeled')::boolean, prev.is_labeled, false),
    (p ->> 'time_to_confirm_ms')::integer,
    coalesce(p ->> 'note', prev.note),
    p ->> 'client_id',
    public.user_local_day(uid, coalesce((p ->> 'eaten_at')::timestamptz, prev.eaten_at, now()))
  )
  returning * into m;

  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    insert into public.meal_items (
      meal_id, user_id, food_id, name, grams, state, kcal, protein_g, fat_g, carbs_g, satfat_g, sugar_g, per100,
      confidence, source, model_grams, model_label, edited, sort_order
    ) values (
      m.id, uid, (it ->> 'food_id')::uuid, it ->> 'name', (it ->> 'grams')::numeric,
      it ->> 'state',
      coalesce((it ->> 'kcal')::numeric, 0), coalesce((it ->> 'protein_g')::numeric, 0),
      coalesce((it ->> 'fat_g')::numeric, 0), coalesce((it ->> 'carbs_g')::numeric, 0),
      (it ->> 'satfat_g')::numeric, (it ->> 'sugar_g')::numeric,
      it -> 'per100', (it ->> 'confidence')::numeric, coalesce(it ->> 'source', 'user'),
      (it ->> 'model_grams')::numeric, it ->> 'model_label',
      coalesce((it ->> 'edited')::boolean, false), i
    );
    i := i + 1;
  end loop;

  update public.meals set
    kcal = coalesce((select sum(kcal) from public.meal_items where meal_id = m.id), 0),
    protein_g = coalesce((select sum(protein_g) from public.meal_items where meal_id = m.id), 0),
    fat_g = coalesce((select sum(fat_g) from public.meal_items where meal_id = m.id), 0),
    carbs_g = coalesce((select sum(carbs_g) from public.meal_items where meal_id = m.id), 0),
    satfat_g = (select sum(satfat_g) from public.meal_items where meal_id = m.id),
    sugar_g = (select sum(sugar_g) from public.meal_items where meal_id = m.id)
  where id = m.id
  returning * into m;

  return m;
end
$$;

-- delete_meal keeps satfat/sugar on the deleted version too.
create or replace function public.delete_meal(p_id uuid)
returns public.meals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prev public.meals;
  m public.meals;
begin
  select * into prev from public.meals where id = p_id and user_id = uid and is_current for update;
  if not found then
    raise exception 'meal not found';
  end if;
  update public.meals set is_current = false where id = prev.id;
  insert into public.meals (
    user_id, root_id, version, supersedes_id, status, eaten_at, local_day, slot, title,
    input_method, template_id, recognition_id, confidence, is_labeled, kcal, protein_g,
    fat_g, carbs_g, satfat_g, sugar_g, note
  ) values (
    uid, prev.root_id, prev.version + 1, prev.id, 'deleted', prev.eaten_at, prev.local_day,
    prev.slot, prev.title, prev.input_method, prev.template_id, prev.recognition_id,
    prev.confidence, prev.is_labeled, prev.kcal, prev.protein_g, prev.fat_g, prev.carbs_g,
    prev.satfat_g, prev.sugar_g, prev.note
  ) returning * into m;
  return m;
end
$$;
