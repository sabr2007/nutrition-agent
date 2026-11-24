import { Suspense } from 'react';
import { ChatView } from '@/components/chat/ChatView';

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="p-6"><span className="ascii text-ink-3 blink">загрузка</span></div>}>
      <ChatView />
    </Suspense>
  );
}
