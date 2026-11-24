import { Suspense } from 'react';
import { CoachView } from '@/components/coach/CoachView';

export default function CoachPage() {
  return (
    <Suspense fallback={<div className="p-6"><span className="ascii text-ink-3 blink">загрузка</span></div>}>
      <CoachView />
    </Suspense>
  );
}
