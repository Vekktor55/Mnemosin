import { z } from 'zod';

/**
 * Сборка discriminated union из карты payload-схем.
 *
 * Zod-типы `.map()`-результата (`ZodObject<ZodRawShape>`) не присваиваются
 * `ZodDiscriminatedUnionOption<'type'>` без явного приведения: TS теряет
 * информацию о литеральном поле `type`. Приведение локальное и безопасное —
 * форма объекта гарантирована кодом ниже, а содержимое проверяется Zod
 * (инвариант 16: каждый payload проходит схему).
 *
 * contracts 0.3.1 (D213): возвращаемый тип — `z.ZodType<EnvelopeOf<T, Extra>>`
 * с явно ВЫЧИСЛЕННЫМ output. Прежний `z.ZodDiscriminatedUnion<'type', EnvelopeOptions>`
 * в d.ts терял литеральную карту payload'ов, и `z.infer` между пакетами (tsc -b)
 * вырождал `type`/`payload` в `unknown`: `DomainEvent['type']` переставал быть
 * `EventName`. Runtime не изменился — это по-прежнему `z.discriminatedUnion`.
 */
export type EnvelopeOptions = [z.ZodDiscriminatedUnionOption<'type'>, ...z.ZodDiscriminatedUnionOption<'type'>[]];

/** Точный output конверта: `{type: K; payload: infer<T[K]>} & extra` по каждому ключу карты. */
export type EnvelopeOf<T extends Record<string, z.ZodTypeAny>, Extra extends z.ZodRawShape> = {
  [K in keyof T]: { type: K } & { payload: z.infer<T[K]> } & z.infer<z.ZodObject<Extra>>;
}[keyof T];

export function buildEnvelopeUnion<T extends Record<string, z.ZodTypeAny>, Extra extends z.ZodRawShape>(
  payloads: T,
  extra: Extra,
): z.ZodType<EnvelopeOf<T, Extra>, z.ZodTypeDef, unknown> {
  const options = Object.keys(payloads).map((type) =>
    z.object({
      type: z.literal(type),
      payload: payloads[type] as z.ZodTypeAny,
      ...extra,
    }),
  ) as unknown as EnvelopeOptions;
  return z.discriminatedUnion('type', options) as unknown as z.ZodType<EnvelopeOf<T, Extra>, z.ZodTypeDef, unknown>;
}
