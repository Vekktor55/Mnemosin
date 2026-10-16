/**
 * Клиентские идентификаторы (промпт 1.12, п.4; SPEC §6).
 *
 * idempotencyKey: crypto.randomUUID (36 символов ≥ 16 — схема IdempotencyKey),
 * генерируется ОДИН раз на операцию и переиспользуется при ретраях той же
 * операции (SPEC §5: «повтор с тем же idempotencyKey безопасен»).
 * requestId: envelope-корреляция ack/ERROR (8–64 символа, RequestIdSchema).
 *
 * Fallback Math.random — только для сред без crypto.randomUUID (старые
 * WebView); формат сохраняет длину ≥16 и уникальность.
 */

function uuid(): string {
  const c: Crypto | undefined = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback: 128 бит энтропии из Math.random (не криптографично, но ≥16 символов).
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Новый ключ идемпотентности операции (≥16 символов, бренд IdempotencyKey совместим). */
export function newIdempotencyKey(prefix: string): string {
  return `cl-${prefix}-${uuid()}`;
}

/** Новый requestId сообщения (корреляция ack/ERROR; ≥8 символов). */
export function newRequestId(): string {
  return `req-${uuid()}`;
}
