import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ supabaseAdmin: () => ({ from: () => ({ insert: async () => ({}) }) }) }));
vi.mock('@/lib/llm/chatgpt', () => ({ getChatgptToken: async () => null }));

const { classifyError, callModel, LlmError, userMessageFor } = await import('@/lib/llm/router');
const { cleanTranscript } = await import('@/lib/llm/transcribe');

describe('ChatGPT-only model calls', () => {
  it('classifies the plan usage-limit error as quota', () => {
    const err = Object.assign(new Error('Too Many Requests'), { statusCode: 429, responseBody: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' });
    expect(classifyError(err).cls).toBe('quota');
  });

  it('classifies auth, rate, timeout and server errors', () => {
    expect(classifyError(Object.assign(new Error('Unauthorized'), { statusCode: 401 })).cls).toBe('auth');
    expect(classifyError(Object.assign(new Error('slow down'), { statusCode: 429 })).cls).toBe('rate');
    expect(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' })).cls).toBe('timeout');
    expect(classifyError(Object.assign(new Error('bad gateway'), { statusCode: 502 })).cls).toBe('server');
  });

  it('fails fast with a readable message when ChatGPT is not connected (no fallback provider)', async () => {
    const run = vi.fn();
    await expect(callModel({ model: 'gpt-6-luna', effort: 'low' }, { userId: 'u1', purpose: 'test' }, run)).rejects.toBeInstanceOf(LlmError);
    expect(run).not.toHaveBeenCalled();
    expect(userMessageFor(new LlmError('not_connected'))).toMatch(/ChatGPT не подключён/);
    expect(userMessageFor(new Error('boom'))).toMatch(/ChatGPT/);
  });
});

describe('speech-to-text cleanup', () => {
  it('drops Whisper silence hallucinations and keeps real speech', () => {
    expect(cleanTranscript('Продолжение следует...')).toBe('');
    expect(cleanTranscript('Субтитры сделал DimaTorzok')).toBe('');
    expect(cleanTranscript('  съел   200 г творога ')).toBe('съел 200 г творога');
  });
});
