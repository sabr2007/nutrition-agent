'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, TODAY_REFRESH } from './api';
import { readDay, writeDay } from './day-cache';

// «Сегодня» data without SWR (D31: SWR alone is ~5 KB of the first screen). What it does:
//  * shows the day it already knows at once (this session's memory, then the device cache);
//  * refetches on mount, on return to the app (visibility/focus) and on TODAY_REFRESH — no polling;
//  * one request per day at a time; neighbouring days can be fetched ahead (preloadDay);
//  * optimistic local edits (setLocal) with a refetch after the write.

const memory = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

function load<T>(key: string): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = api<T>(key).then((d) => { memory.set(key, d); writeDay(key, d); return d; }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export function preloadDay(key: string): void {
  if (!memory.has(key)) void load(key).catch(() => undefined);
}

const known = <T,>(key: string): T | undefined => (memory.get(key) as T | undefined) ?? readDay<T>(key);

type State<T> = { key: string; data?: T; error?: Error };

export function useDay<T>(key: string) {
  const [state, setState] = useState<State<T>>(() => ({ key, data: known<T>(key) }));
  // A new day: show what is known for it right away, keep the last screen until it arrives.
  if (state.key !== key) setState({ key, data: known<T>(key) ?? state.data });

  const revalidate = useCallback(async () => {
    try {
      const data = await load<T>(key);
      setState((s) => (s.key === key ? { key, data } : s));
    } catch (e) {
      setState((s) => (s.key === key ? { ...s, error: e as Error } : s));
    }
  }, [key]);

  useEffect(() => {
    void revalidate();
    const onVisible = () => { if (document.visibilityState === 'visible') void revalidate(); };
    const onRefresh = () => { void revalidate(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener(TODAY_REFRESH, onRefresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener(TODAY_REFRESH, onRefresh);
    };
  }, [revalidate]);

  const setLocal = useCallback((fn: (d: T) => T) => setState((s) => (s.data ? { ...s, data: fn(s.data) } : s)), []);

  return { data: state.data, error: state.data ? undefined : state.error, isLoading: !state.data && !state.error, revalidate, setLocal };
}
