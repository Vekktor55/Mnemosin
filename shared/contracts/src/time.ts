import { z } from 'zod';

/**
 * Единый тип даты/времени (устраняет F-1.21: точность и таймзона не были зафиксированы).
 * UTC, миллисекунды, без смещения — совпадает с тем, что пишет SQLite-слой и outbox.
 */
export const IsoDateTime = z.string().datetime({ offset: false, precision: 3 });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export function nowIso(): IsoDateTime {
  return new Date().toISOString() as IsoDateTime;
}

export function plusMs(from: IsoDateTime | string, ms: number): IsoDateTime {
  return new Date(new Date(from).getTime() + ms).toISOString() as IsoDateTime;
}
