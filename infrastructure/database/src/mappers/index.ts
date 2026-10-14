import type { z } from 'zod';

/**
 * Мапперы «строка БД ↔ доменный объект» (промпт 1.4).
 *
 * Правило D199: доменный объект хранится ЦЕЛИКОМ в body_json, а в отдельных колонках —
 * только то, по чему идут запросы. Поэтому маппер = Zod-валидация body_json + сверка
 * дублирующих колонок с телом (если разошлись — это порча данных, падаем сразу,
 * а не отдаём клиенту два разных мнения об одном объекте).
 */

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, ctx: string): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`[database] ${ctx}: body_json не проходит валидацию контракта — ${issues}`);
  }
  return result.data;
}

/** Сверка «колонка vs тело»: расхождение = порча, молча продолжать нельзя. */
export function assertMatches(column: string, columnValue: unknown, bodyValue: unknown, ctx: string): void {
  const a = columnValue === null || columnValue === undefined ? null : String(columnValue);
  const b = bodyValue === null || bodyValue === undefined ? null : String(bodyValue);
  if (a !== b) {
    throw new Error(`[database] ${ctx}: колонка ${column}=${a} расходится с body_json=${b}`);
  }
}

/** Контрольная сумма для снапшотов: детерминированный JSON + sha256. */
export async function checksumOf(value: unknown): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** JSON с отсортированными ключами — чтобы хеш не зависел от порядка полей. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** rowsAffected из libsql может прийти bigint — приводим к number. */
export function rowsAffectedOf(result: unknown): number {
  const value = (result as { rowsAffected?: number | bigint } | null)?.rowsAffected;
  if (value === undefined || value === null) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

export type Json = Record<string, unknown>;

/** Приводит body_json к объекту (drizzle отдаёт unknown для json-колонок). */
export function asJson(value: unknown, ctx: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[database] ${ctx}: ожидался JSON-объект, получено ${typeof value}`);
  }
  return value as Json;
}
