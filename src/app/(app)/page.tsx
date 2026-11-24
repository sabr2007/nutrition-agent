import { Suspense } from 'react';
import { TodayView } from '@/components/today/TodayView';

export default function TodayPage() {
  return (
    <Suspense fallback={<div className="p-6"><span className="ascii text-ink-3 blink">загрузка</span></div>}>
      <TodayView />
    </Suspense>
  );
}
