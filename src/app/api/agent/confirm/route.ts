import { z } from 'zod';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { confirmAction } from '@/lib/agent/confirm';

// Executes a dangerous action the agent proposed, only after the user pressed the button.
const Body = z.object({ message_id: z.string().uuid(), action_id: z.string().uuid(), decision: z.enum(['confirm', 'cancel']) });

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Некорректный запрос', 'validation');
  const r = await confirmAction(sb, userId, parsed.data.message_id, parsed.data.action_id, parsed.data.decision);
  if (!r.ok) throw new HttpError(r.status, r.message, r.code);
  return json({ ok: true, text: r.text });
});
