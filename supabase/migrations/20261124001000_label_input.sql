-- Nutrition-label photos: a recognition kind of their own and a meal input method.
-- The label is read by a vision model, the user confirms the numbers, and the product is
-- stored as a personal food (source 'label') that search, templates and the agent can use.

alter table public.recognitions drop constraint if exists recognitions_kind_check;
alter table public.recognitions add constraint recognitions_kind_check
  check (kind in ('photo', 'voice', 'text', 'barcode', 'scale', 'label'));

alter table public.meals drop constraint if exists meals_input_method_check;
alter table public.meals add constraint meals_input_method_check check (input_method in (
  'template', 'text', 'photo', 'voice', 'barcode', 'repeat', 'manual', 'agent', 'scale', 'import', 'label'));
