'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Toast = { id: number; text: string; action?: { label: string; onClick: () => void }; tone?: 'default' | 'error' };
const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++seq.current;
    setToasts((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.action ? 6000 : 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[calc(12px+var(--safe-top))] z-50 mx-auto flex max-w-md flex-col gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className={`fade-in pointer-events-auto flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm shadow-[var(--shadow-float)] ${t.tone === 'error' ? 'bg-over text-white' : 'bg-ink text-linen'}`}>
            <span>{t.text}</span>
            {t.action && (
              <button onClick={() => { t.action!.onClick(); setToasts((xs) => xs.filter((x) => x.id !== t.id)); }} className="press shrink-0 rounded-full border border-current px-3 py-1 font-mono text-xs">
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
