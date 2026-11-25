import type { SupabaseClient } from '@supabase/supabase-js';
import type { Profile } from '@/lib/data/profile';
import type { AgentAction, LoggedMeal } from '@/lib/chat/protocol';
import type { DryWorld } from './dry-world';

export type ToolCtx = {
  sb: SupabaseClient;
  userId: string;
  profile: Profile;
  runId: string;
  trigger: 'chat' | 'cron' | 'event' | 'rule' | 'eval' | 'system';
  /** Collected UI side effects (buttons, proposed memories, confirmations, sent messages). */
  ui: AgentUi;
  /** In eval mode writes are simulated. */
  dryRun?: boolean;
  /** Simulated foods and meals of a dry run (evals): writes land here instead of the database. */
  dry?: DryWorld;
  /** Photos attached to the current chat message: meals logged from them keep the link. */
  photo?: { mediaIds: string[]; model: string };
};

export type PendingAction = { id: string; kind: 'update_goal' | 'delete_meal'; summary: string; params: Record<string, unknown> };

export type AgentUi = {
  choices?: { question: string; options: string[] };
  proposedMemories: { id: string; content: string }[];
  pendingActions: PendingAction[];
  sentMessages: string[];
  loggedMeals: LoggedMeal[];
  /** Other writes (weight, checklist, reminders…) shown as chips under the reply. */
  actions: AgentAction[];
};

export function emptyUi(): AgentUi {
  return { proposedMemories: [], pendingActions: [], sentMessages: [], loggedMeals: [], actions: [] };
}
