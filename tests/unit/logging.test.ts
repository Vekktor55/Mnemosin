import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { AppConfig } from '@mnemosin/config';
import { createLogger, newTraceId, redactPlayerText, withTrace } from '@mnemosin/logging';

/**
 * Логирование (v3 §VIII.4): traceId сквозь child-логгеры, redact секретов,
 * маскировка текста игроков (D163). Поднимает покрытие infrastructure/logging
 * до порога adapters ≥ 60% (промпт 1.13, п.7).
 */

function fakeConfig(env: Partial<{ NODE_ENV: string; LOG_LEVEL: string }> = {}): AppConfig {
  return {
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env },
    redactPaths: ['token', 'refreshToken', 'authorization'],
    version: '0.1.0',
  } as unknown as AppConfig;
}

describe('newTraceId', () => {
  it('uuid v4, уникальны', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('withTrace', () => {
  it('child-логгер несёт traceId и дополнительные bindings', () => {
    const lines: string[] = [];
    const base = pino({ level: 'info' }, { write: (line: string) => lines.push(line) } as never);
    const traced = withTrace(base, 'trace-1', { component: 'turn-engine' });
    traced.info({ event: 'test' }, 'test');
    const parsed = JSON.parse(lines[0] ?? '{}') as { traceId?: string; component?: string };
    expect(parsed.traceId).toBe('trace-1');
    expect(parsed.component).toBe('turn-engine');
  });
});

describe('createLogger', () => {
  it('test-окружение: JSON-логгер без pretty-transport, level из env', () => {
    const logger = createLogger({ config: fakeConfig({ LOG_LEVEL: 'error' }) });
    expect(logger.level).toBe('error');
  });

  it('development-окружение: конфигурация с pretty-transport собирается', () => {
    // Транспорт не активируем записью (silent) — проверяем ветку конфигурации.
    const logger = createLogger({ config: fakeConfig({ NODE_ENV: 'development', LOG_LEVEL: 'silent' }), name: 'http' });
    expect(logger.level).toBe('silent');
  });
});

describe('redactPlayerText (D163)', () => {
  const fields = ['rawText', 'text'];

  it('маскирует указанные поля на любом уровне вложенности', () => {
    const input = {
      rawText: 'секрет',
      nested: { text: 'ещё секрет', keep: 1 },
      list: [{ rawText: 'в массиве' }, 5, null],
    };
    const out = redactPlayerText(input, fields) as Record<string, unknown>;
    expect(out['rawText']).toBe('[REDACTED_PLAYER_TEXT]');
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['text']).toBe('[REDACTED_PLAYER_TEXT]');
    expect(nested['keep']).toBe(1);
    const list = out['list'] as unknown[];
    expect((list[0] as Record<string, unknown>)['rawText']).toBe('[REDACTED_PLAYER_TEXT]');
    expect(list[1]).toBe(5);
    expect(list[2]).toBeNull();
  });

  it('пустой список полей и скаляры — без изменений', () => {
    expect(redactPlayerText({ rawText: 'x' }, [])).toEqual({ rawText: 'x' });
    expect(redactPlayerText('строка', fields)).toBe('строка');
    expect(redactPlayerText(null, fields)).toBeNull();
  });
});
