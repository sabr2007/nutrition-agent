'use client';

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { CameraIcon, CheckIcon, ChevronLeftIcon, GaugeIcon, PhotoIcon, SkillsIcon } from '@/components/ui/icons';

export type Skill = { label: string; text: string; skill?: string };

export const SKILLS: Skill[] = [
  { label: 'Что съесть сейчас', text: 'Что мне съесть сейчас, чтобы добрать белок?' },
  { label: 'Закрыть день', text: 'Давай закроем день.', skill: 'close_day' },
  { label: 'План на завтра', text: 'Составь план питания на завтра.', skill: 'plan_tomorrow' },
  { label: 'Список покупок', text: 'Список покупок на 3 дня.', skill: 'shopping_list' },
  { label: 'Разбор недели', text: 'Сделай разбор недели.', skill: 'weekly_review' },
  { label: 'Рецепт из курицы', text: 'Придумай бюджетный рецепт из курицы под мой остаток.', skill: 'recipe' },
  { label: 'Я сорвался', text: 'Я сорвался, давай разберём.' },
];

type Props = {
  deep: boolean;
  onCamera: () => void;
  onPhotos: () => void;
  onSkill: (s: Skill) => void;
  onToggleDeep: () => void;
  onClose: () => void;
};

/** The ChatGPT-style "+" menu: grows from the button, closes on outside tap or Escape. */
export function PlusMenu({ deep, onCamera, onPhotos, onSkill, onToggleDeep, onClose }: Props) {
  const [view, setView] = useState<'main' | 'skills'>('main');
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, view]);

  return (
    <>
      <button type="button" aria-label="Закрыть меню" tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={onClose} />
      <div role="menu" aria-label={view === 'main' ? 'Добавить' : 'Навыки'}
        className="menu-pop absolute bottom-[calc(100%+10px)] left-0 z-40 w-[min(272px,calc(100vw-32px))] rounded-[26px] border border-rule/60 bg-card/95 p-2 shadow-[var(--shadow-menu)] backdrop-blur-xl">
        {view === 'main' ? (
          <>
            <MenuItem ref={first} icon={<CameraIcon />} label="Камера" onClick={() => { onClose(); onCamera(); }} />
            <MenuItem icon={<PhotoIcon />} label="Фото" onClick={() => { onClose(); onPhotos(); }} />
            <MenuItem icon={<SkillsIcon />} label="Навыки" trailing={<span className="font-mono text-ink-3">›</span>} onClick={() => setView('skills')} />
            <MenuItem icon={<GaugeIcon />} label="Думать дольше" role="menuitemcheckbox" checked={deep}
              trailing={deep ? <CheckIcon size={20} /> : null} onClick={onToggleDeep} />
          </>
        ) : (
          <>
            <button ref={first} type="button" onClick={() => setView('main')} className="press flex w-full items-center gap-2 rounded-2xl px-2 py-2 text-sm text-ink-2">
              <ChevronLeftIcon size={18} /> Навыки
            </button>
            <div className="max-h-[50dvh] overflow-y-auto">
              {SKILLS.map((s) => (
                <button key={s.label} type="button" role="menuitem" onClick={() => { onClose(); onSkill(s); }}
                  className="press flex w-full items-center rounded-2xl px-3 py-3 text-left text-[16px] hover:bg-linen focus-visible:bg-linen">
                  {s.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

type ItemProps = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  trailing?: ReactNode;
  role?: 'menuitem' | 'menuitemcheckbox';
  checked?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

function MenuItem({ icon, label, onClick, trailing, role = 'menuitem', checked, ref }: ItemProps) {
  return (
    <button ref={ref} type="button" role={role} aria-checked={role === 'menuitemcheckbox' ? checked : undefined} onClick={onClick}
      className="press flex w-full items-center gap-3.5 rounded-2xl px-2 py-1.5 text-left hover:bg-linen focus-visible:bg-linen">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linen text-ink">{icon}</span>
      <span className="flex-1 text-[16.5px]">{label}</span>
      {trailing && <span className="pr-2 text-ink">{trailing}</span>}
    </button>
  );
}
