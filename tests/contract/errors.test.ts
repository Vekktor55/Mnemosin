import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toErrorCode, zodIssuesToMeta } from '@mnemosin/contracts';
import { zodIssuesToMeta as httpZodIssuesToMeta } from '@mnemosin/gateway-http';

function validationError(schema: z.ZodTypeAny, input: unknown): z.ZodError {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('ожидалась ошибка валидации');
  return result.error;
}

describe('Zod 4 → стабильный формат ошибок HTTP/WS', () => {
  it('публикует только path/code/message без внутренних полей Zod', () => {
    const error = validationError(z.object({ name: z.string().min(3) }), { name: 'x' });
    const meta = zodIssuesToMeta(error);

    expect(meta.issues).toHaveLength(1);
    expect(meta.issues[0]).toEqual({
      path: 'name',
      code: 'too_small',
      message: expect.any(String),
    });
    expect(Object.keys(meta.issues[0]!).sort()).toEqual(['code', 'message', 'path']);
    expect(meta.issues[0]).not.toHaveProperty('expected');
    expect(meta.issues[0]).not.toHaveProperty('received');
    expect(meta.issues[0]).not.toHaveProperty('format');
    expect(meta.issues[0]).not.toHaveProperty('pattern');
  });

  it('HTTP-адаптер использует тот же формат, что и общий contracts-helper', () => {
    const error = validationError(z.object({ count: z.number().int() }), { count: 1.5 });
    expect(httpZodIssuesToMeta(error)).toEqual(zodIssuesToMeta(error));
  });

  it('ограничивает список десятью issues и сообщение восемьюдесятью символами', () => {
    const manyIssues = validationError(
      z.array(z.string().min(2)),
      Array.from({ length: 15 }, () => ''),
    );
    expect(zodIssuesToMeta(manyIssues).issues).toHaveLength(10);

    const longMessage = validationError(
      z.string().refine(() => false, { message: 'x'.repeat(200) }),
      'value',
    );
    expect(zodIssuesToMeta(longMessage).issues[0]?.message).toHaveLength(80);
  });

  it('маппит ZodError в публичный VALIDATION', () => {
    const error = validationError(z.string(), null);
    expect(toErrorCode(error)).toBe('VALIDATION');
  });
});
