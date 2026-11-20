import { z } from 'zod';

/**
 * Сборка discriminated union из карты payload-схем.
 *
 * Массив вариантов приводится к параметру `z.discriminatedUnion` локально:
 * TypeScript теряет информацию о литеральном поле `type` у `.map()`-результата.
 * Форма объектов гарантирована кодом ниже, содержимое проверяется Zod
 * (инвариант 16: каждый payload проходит схему).
 *
 * Возвращаемый тип — `z.ZodType<EnvelopeOf<T, Extra>, unknown>` с явно
 * ВЫЧИСЛЕННЫМ output: литеральная карта payload'ов сохраняется между пакетами
 * (tsc -b), `DomainEvent['type']` остаётся `EventName`. Runtime — `z.discriminatedUnion`.
 */
/** Точный output конверта: `{type: K; payload: infer<T[K]>} & extra` по каждому ключу карты. */
export type EnvelopeOf<T extends Record<string, z.ZodTypeAny>, Extra extends z.ZodRawShape> = {
  [K in keyof T]: { type: K } & { payload: z.infer<T[K]> } & z.infer<z.ZodObject<Extra>>;
}[keyof T];

export function buildEnvelopeUnion<T extends Record<string, z.ZodTypeAny>, Extra extends z.ZodRawShape>(
  payloads: T,
  extra: Extra,
): z.ZodType<EnvelopeOf<T, Extra>, unknown> {
  const options = Object.keys(payloads).map((type) =>
    z.object({
      type: z.literal(type),
      payload: payloads[type] as z.ZodTypeAny,
      ...extra,
    }),
  ) as unknown as Parameters<typeof z.discriminatedUnion>[1];
  return z.discriminatedUnion('type', options) as unknown as z.ZodType<EnvelopeOf<T, Extra>, unknown>;
}
