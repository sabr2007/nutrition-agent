'use client';

import { useCallback, useSyncExternalStore } from 'react';

// «Думать дольше» is a per-device preference, like the toggle in ChatGPT's "+" menu.
const KEY = 'ryadom:deep';
const listeners = new Set<() => void>();
let fallback = false; // when storage is unavailable (private mode, blocked site data)

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return fallback;
  }
}

function write(value: boolean): void {
  fallback = value;
  try {
    localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // keep the in-memory value
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useDeepMode(): [boolean, () => void] {
  const deep = useSyncExternalStore(subscribe, read, () => false);
  const toggle = useCallback(() => write(!read()), []);
  return [deep, toggle];
}
