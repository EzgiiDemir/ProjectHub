'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; text: string; tone: 'info' | 'bad' };
const Ctx = createContext<(text: string, tone?: 'info' | 'bad') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'info' | 'bad' = 'info') => {
    const id = Date.now() + Math.random();
    setItems((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3800);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
