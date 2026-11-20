import type { SpatialWorldPack } from '@mnemosin/contracts';
import { validateWorldPack, WorldPackValidationError } from './validator.js';

/**
 * Загрузчик World Pack (P03). Принимает сырой JSON-текст и возвращает
 * валидированный `SpatialWorldPack`.
 *
 * Граница слоя: core НЕ читает файловую систему (D221). Файловый ввод-вывод
 * остаётся в вызывающем коде (тесты, composition root, будущий инфраструктурный
 * адаптер), а этот модуль — чистая функция над строкой.
 */
export function parseWorldPack(jsonText: string): SpatialWorldPack {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (cause) {
    throw new WorldPackValidationError([
      { path: '(json)', message: `некорректный JSON: ${cause instanceof Error ? cause.message : String(cause)}` },
    ]);
  }
  return validateWorldPack(raw);
}
