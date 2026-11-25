import { describe, expect, test } from 'vitest';
import { escapeHtml, stripHtml, toTelegramHtml, toTelegramMessages, visibleLength } from '@/lib/telegram/format';
import { draftText } from '@/lib/telegram/stream';

describe('Markdown → Telegram HTML', () => {
  test('escapes <, > and &', () => {
    expect(toTelegramHtml('белок < 40 г & жиры > 50')).toBe('белок &lt; 40 г &amp; жиры &gt; 50');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
  test('bold, italic, strike, links', () => {
    expect(toTelegramHtml('**250 ккал** и *примерно*')).toBe('<b>250 ккал</b> и <i>примерно</i>');
    expect(toTelegramHtml('~~было~~ стало')).toBe('<s>было</s> стало');
    expect(toTelegramHtml('[OFF](https://world.openfoodfacts.org/product/1?a=1&b=2)')).toBe('<a href="https://world.openfoodfacts.org/product/1?a=1&amp;b=2">OFF</a>');
  });
  test('math asterisks and snake_case stay as they are', () => {
    expect(toTelegramHtml('2*3 = 6, food_id и kcal_100g')).toBe('2*3 = 6, food_id и kcal_100g');
  });
  test('headings become bold, lists become bullets, rules disappear', () => {
    expect(toTelegramHtml('## Итог дня\n- белок 150 г\n* жиры 45 г\n1. первое\n---')).toBe('<b>Итог дня</b>\n• белок 150 г\n• жиры 45 г\n1. первое');
  });
  test('code spans and blocks are escaped, never formatted', () => {
    expect(toTelegramHtml('вызови `log_meal(**x**)`')).toBe('вызови <code>log_meal(**x**)</code>');
    expect(toTelegramHtml('```json\n{"a": "<1>"}\n```')).toBe('<pre><code class="language-json">{"a": "&lt;1&gt;"}</code></pre>');
  });
  test('quotes and tables', () => {
    expect(toTelegramHtml('> важно\n> два')).toBe('<blockquote>важно\nдва</blockquote>');
    expect(toTelegramHtml('| продукт | ккал |\n|---|---|\n| гречка | 110 |')).toBe('продукт · ккал\nгречка · 110');
  });
  test('unbalanced markers stay literal', () => {
    expect(toTelegramHtml('**не закрыто')).toBe('**не закрыто');
  });
  test('plain-text fallback and drafts', () => {
    expect(stripHtml('<b>a</b> &lt;b&gt; &amp;')).toBe('a <b> &');
    expect(draftText('## Итог\n**250** ккал\n- белок')).toBe('Итог\n250 ккал\n• белок');
    expect(visibleLength('<b>ab</b>&amp;')).toBe(3);
  });
});

describe('splitting long replies', () => {
  test('short text is one message', () => {
    expect(toTelegramMessages('коротко')).toEqual(['коротко']);
  });
  test('long text splits at paragraphs, every part within the limit, tags never cross parts', () => {
    const para = (i: number) => `**Абзац ${i}.** ${'слово '.repeat(60)}`.trim();
    const md = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n');
    const parts = toTelegramMessages(md, 1000);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000);
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length);
    }
    expect(parts.join('\n\n')).toContain('<b>Абзац 29.</b>');
  });
  test('a single huge paragraph is cut by words', () => {
    const parts = toTelegramMessages('а '.repeat(3000), 500);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.length).toBeGreaterThan(10);
  });
});
