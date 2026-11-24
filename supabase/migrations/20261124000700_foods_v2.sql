-- Foods v2: research-based corrections (docs/research/photo-accuracy.md) and coverage for
-- common foods found in the first eval run (olives were matched to olive oil — fixed in
-- code by a plausibility guard, and here by adding the missing foods).

-- Kazakh dishes: lab analyses of Almaty/Bishkek street food + Kyrgyz FCT 2022.
update public.foods set kcal_100g = 202, kcal_low_100g = 180, kcal_high_100g = 250, protein_100g = 7, fat_100g = 9.5, carbs_100g = 22.5,
  notes = 'Лаб. анализы стрит-фуда Алматы/Бишкека: ~202 ккал/100 г; масло — главный источник разброса'
  where user_id is null and source = 'kz' and source_ref = 'kz:plov';
update public.foods set kcal_100g = 185, kcal_low_100g = 150, kcal_high_100g = 250, protein_100g = 12, fat_100g = 9, carbs_100g = 14,
  notes = 'Без сорпы ~185 ккал/100 г; с бульоном ~124. Конина/баранина жирнее говядины'
  where user_id is null and source = 'kz' and source_ref = 'kz:beshbarmak';
update public.foods set kcal_100g = 360, kcal_low_100g = 300, kcal_high_100g = 380 where user_id is null and source = 'kz' and source_ref = 'kz:baursak';
update public.foods set kcal_100g = 128, kcal_low_100g = 115, kcal_high_100g = 140 where user_id is null and source = 'kz' and source_ref = 'kz:lagman_soup';
update public.foods set kcal_100g = 222, kcal_low_100g = 180, kcal_high_100g = 240, protein_100g = 8, fat_100g = 10, carbs_100g = 25 where user_id is null and source = 'kz' and source_ref = 'kz:lagman_fried';
update public.foods set kcal_100g = 210, kcal_low_100g = 183, kcal_high_100g = 240, protein_100g = 10, fat_100g = 10, carbs_100g = 20 where user_id is null and source = 'kz' and source_ref = 'kz:manty';
update public.foods set kcal_100g = 313, kcal_low_100g = 300, kcal_high_100g = 350 where user_id is null and source = 'kz' and source_ref = 'kz:samsa';

-- Cooking yields (cooked ÷ raw): USDA cooking yield tables.
update public.foods set yield_factor = 0.73 where user_id is null and source = 'usda_sr' and source_ref = '05064';
update public.foods set yield_factor = 0.77 where user_id is null and source = 'usda_sr' and source_ref = '05066';
update public.foods set kcal_100g = 110, protein_100g = 3.8, fat_100g = 0.9, carbs_100g = 23.8, fiber_100g = 3.3,
  kcal_low_100g = 92, kcal_high_100g = 145, yield_factor = 3.1,
  notes = 'USDA варёная (разварная) 92 ккал при приваре ×3.7; домашняя рассыпчатая суше (×2.4 → ~145). Точнее взвешивать сухую'
  where user_id is null and source = 'seed' and source_ref = 'seed:buckwheat_cooked';
update public.foods set yield_factor = 4.7 where user_id is null and source = 'usda_sr' and source_ref = '08121';

insert into public.foods (
  source, source_ref, name_ru, name_en, aliases, category, state,
  kcal_100g, protein_100g, fat_100g, carbs_100g, fiber_100g, kcal_low_100g, kcal_high_100g, default_portion_g, portions, confidence, notes
) values
('usda_sr','09195','Оливки/маслины','Olives, ripe, canned',array['оливки','маслины','оливка'],'vegetables','as_is',115,0.84,10.68,6.26,3.2,null,null,30,'[]','high',null),
('usda_sr','11143','Сельдерей','Celery, raw',array['сельдерей'],'vegetables','raw',16,0.69,0.17,2.97,1.6,null,null,60,'[]','high',null),
('usda_sr','11098','Брюссельская капуста','Brussels sprouts, raw',array['брюссельская капуста'],'vegetables','raw',43,3.38,0.3,8.95,3.8,null,null,100,'[]','high',null),
('usda_sr','11147','Мангольд','Swiss chard, raw',array['мангольд','листовая свекла'],'vegetables','raw',19,1.8,0.2,3.74,1.6,null,null,60,'[]','high',null),
('usda_sr','11233','Кале (кудрявая капуста)','Kale, raw',array['кейл','кале','капуста кале'],'vegetables','raw',35,2.92,1.49,4.42,4.1,null,null,50,'[]','high',null),
('usda_sr','11959','Руккола','Arugula, raw',array['руккола','рукола'],'vegetables','raw',25,2.58,0.66,3.65,1.6,null,null,30,'[]','high',null),
('usda_sr','11251','Салат листовой (романо)','Lettuce, romaine, raw',array['салат листовой','айсберг','романо','листья салата'],'vegetables','raw',17,1.23,0.3,3.29,2.1,null,null,50,'[]','high',null),
('usda_sr','11011','Спаржа','Asparagus, raw',array['спаржа'],'vegetables','raw',20,2.2,0.12,3.88,2.1,null,null,100,'[]','high',null),
('usda_sr','11507','Батат','Sweet potato, raw',array['батат','сладкий картофель'],'vegetables','raw',86,1.57,0.05,20.12,3,null,null,150,'[]','high',null),
('seed','seed:potato_roasted','Картофель запечённый с маслом','Roasted potatoes with oil',array['картошка запечённая','картофель по-деревенски','жареная картошка'],'vegetables','cooked',150,2.5,6,21,2.2,120,190,150,'[]','medium','Масло сильно меняет калорийность'),
('seed','seed:veg_salad_fresh','Салат из свежих овощей (без заправки)','Fresh vegetable salad, no dressing',array['салат из помидоров и огурцов','салат овощной свежий','помидоры огурцы салат','греческий салат без сыра'],'vegetables','raw',17,0.8,0.15,3.7,1,15,22,200,'[]','high',null),
('seed','seed:veg_salad_oil','Салат из свежих овощей с маслом','Fresh vegetable salad with oil',array['салат с маслом','овощной салат заправленный'],'vegetables','raw',75,0.8,6.2,3.7,1,55,110,200,'[]','medium','≈1 ст.л. масла на 200 г'),
('seed','seed:veg_salad_smetana','Салат из овощей со сметаной','Vegetable salad with sour cream',array['салат со сметаной'],'vegetables','raw',55,1.1,3.8,4,1,40,80,200,'[]','medium',null),
('usda_sr','20137','Киноа варёная','Quinoa, cooked',array['киноа'],'grains','cooked',120,4.4,1.92,21.3,2.8,null,null,150,'[]','high',null),
('usda_sr','20029','Кускус варёный','Couscous, cooked',array['кускус'],'grains','cooked',112,3.79,0.16,23.22,1.4,null,null,150,'[]','high',null),
('usda_sr','16015','Чёрная фасоль варёная','Black beans, boiled',array['черная фасоль'],'legumes','cooked',132,8.86,0.54,23.71,8.7,null,null,150,'[]','high',null),
('usda_sr','16427','Тофу','Tofu, firm',array['тофу'],'legumes','as_is',144,17.27,8.72,2.78,2.3,null,null,100,'[]','high',null),
('usda_sr','15236','Лосось атлантический, сырой','Salmon, Atlantic, farmed, raw',array['лосось','семга','сёмга','форель'],'fish','raw',208,20.42,13.42,0,0,null,null,150,'[]','high',null),
('usda_sr','15270','Креветки, варёные','Shrimp, cooked',array['креветки'],'fish','cooked',99,23.98,0.28,0.2,0,null,null,100,'[]','high',null),
('usda_sr','10862','Бекон жареный','Bacon, pan-fried',array['бекон'],'meat','cooked',541,37.04,41.78,1.43,0,null,null,20,'[{"label":"1 ломтик","g":8}]','high',null),
('usda_sr','07028','Ветчина','Ham, sliced',array['ветчина'],'meat','as_is',145,20.9,5.5,1.5,0,null,null,50,'[]','medium',null),
('usda_sr','23584','Говядина (стейк), жареная','Beef steak, cooked',array['стейк','говядина жареная','говядина тушеная'],'meat','cooked',250,26.1,15.4,0,0,200,290,150,'[]','medium',null),
('usda_sr','10093','Свинина (корейка), жареная','Pork loin, cooked',array['свинина'],'meat','cooked',242,27.32,13.92,0,0,null,null,150,'[]','medium',null),
('usda_sr','01009','Сыр чеддер','Cheddar cheese',array['чеддер'],'dairy','as_is',403,24.9,33.1,1.3,0,null,null,30,'[]','high',null),
('usda_sr','01032','Пармезан','Parmesan',array['пармезан'],'dairy','as_is',392,35.75,25.83,3.22,0,null,null,10,'[]','high',null),
('usda_sr','01019','Сыр фета/брынза','Feta cheese',array['фета','брынза','сыр брынза'],'dairy','as_is',264,14.21,21.28,4.09,0,null,null,30,'[]','high',null),
('usda_sr','01132','Яичница-болтунья','Egg, scrambled',array['омлет','болтунья','скрэмбл'],'eggs','cooked',149,9.99,10.98,1.61,0,130,200,120,'[]','medium','С маслом/молоком калорийнее'),
('usda_sr','09037','Авокадо','Avocado',array['авокадо','гуакамоле'],'fruits','raw',160,2,14.66,8.53,6.7,null,null,70,'[]','high',null),
('seed','seed:hummus','Хумус','Hummus',array['хумус'],'legumes','as_is',177,7.9,9.6,14.3,6,160,250,50,'[]','medium',null),
('usda_sr','11549','Соус томатный (маринара)','Marinara sauce',array['томатный соус','маринара','соус для пасты'],'sauces','as_is',50,1.4,1.5,8,1.8,null,null,60,'[]','medium',null),
('usda_sr','04018','Майонез','Mayonnaise',array['майонез'],'sauces','as_is',680,1,75,0.6,0,620,700,15,'[{"label":"1 ст.л.","g":15}]','high','Лёгкий майонез ~300 ккал'),
('usda_sr','11935','Кетчуп','Ketchup',array['кетчуп'],'sauces','as_is',101,1.04,0.1,27.4,0.3,null,null,15,'[{"label":"1 ст.л.","g":15}]','high',null),
('usda_sr','16123','Соевый соус','Soy sauce',array['соевый соус'],'sauces','as_is',53,8.14,0.57,4.93,0.8,null,null,15,'[]','high',null),
('seed','seed:dressing','Заправка для салата (масляная)','Salad dressing, vinaigrette',array['заправка','винегретная заправка','заправка цезарь'],'sauces','as_is',400,0.5,42,6,0,250,480,15,'[]','medium',null),
('usda_sr','18254','Тортилья пшеничная','Flour tortilla',array['тортилья'],'bread','as_is',306,8.0,8.0,50,3.5,null,null,45,'[{"label":"1 шт","g":45}]','high',null),
('seed','seed:bun','Булочка (белая)','White bun',array['булка','булочка'],'bread','as_is',285,8.5,4.5,52,2,260,330,60,'[{"label":"1 шт","g":60}]','medium',null),
('usda_sr','08038','Гранола','Granola',array['гранола','мюсли'],'grains','dry',471,10.05,20.21,64.11,7.3,400,490,50,'[]','medium',null),
('usda_sr','09316','Клубника','Strawberries',array['клубника'],'fruits','raw',32,0.67,0.3,7.68,2,null,null,150,'[]','high',null),
('usda_sr','09050','Голубика/черника','Blueberries',array['черника','голубика'],'fruits','raw',57,0.74,0.33,14.49,2.4,null,null,100,'[]','high',null),
('usda_sr','09302','Малина','Raspberries',array['малина'],'fruits','raw',52,1.2,0.65,11.94,6.5,null,null,100,'[]','high',null),
('usda_sr','09266','Ананас','Pineapple',array['ананас'],'fruits','raw',50,0.54,0.12,13.12,1.4,null,null,150,'[]','high',null),
('usda_sr','09176','Манго','Mango',array['манго'],'fruits','raw',60,0.82,0.38,14.98,1.6,null,null,150,'[]','high',null),
('usda_sr','09089','Инжир','Figs',array['инжир'],'fruits','raw',74,0.75,0.3,19.18,2.9,null,null,50,'[]','high',null),
('seed','seed:noodles_cooked','Лапша/спагетти варёные','Noodles, cooked',array['лапша','лапша варёная','удон'],'grains','cooked',138,4.5,2,25,1.2,110,160,200,'[]','medium',null),
('seed','seed:sausage_grill','Колбаски гриль','Grilled sausages',array['колбаски','сардельки'],'meat','cooked',300,13,26,2,0,250,340,100,'[]','medium',null)
on conflict do nothing;
