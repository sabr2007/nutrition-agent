import { Suspense } from 'react';
import { LogView } from '@/components/log/LogView';

export default function LogPage() {
  return (
    <Suspense fallback={<div className="p-6"><span className="ascii text-ink-3 blink">загрузка</span></div>}>
      <LogView />
    </Suspense>
  );
}
