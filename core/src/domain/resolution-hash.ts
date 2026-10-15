import { createHash } from 'node:crypto';

import type { TurnResolution } from '@mnemosin/contracts';

/**
 * Канонические хэши черновика решения (промпт 1.8; F-3.2: защита от lost update
 * в editAndApprove). Живут в core, а не в контрактах: contracts не импортирует
 * node:crypto для хэширования (в контрактах объявлен только формат —
 * RESOLUTION_HASH_LENGTH), и не в отдельных модулях: одинаковый алгоритм нужен
 * И turn engine (запись resolutionHash при draftReady), И gm-review (проверка
 * baseResolutionHash) — модули не импортируют друг друга (D161), общая функция
 * доступна обоим через barrel ядра.
 */

/** Канонический JSON: ключи отсортированы рекурсивно — хэш стабилен между прогонами. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Детерминированный UUID (v4-форма) из sha256 сида — основа идемпотентности
 * обработчиков событий (промпт 1.9, D247): повторная доставка at-least-once
 * упирается в тот же messageId/noteId и пропускается. Живёт в core: нужен
 * И chat, И gm, а модули не импортируют друг друга (D161).
 */
export function deterministicUuidFromSeed(seed: string): string {
  const hex = sha256Hex(seed).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Хэш TurnResolution: sha256 от канонического JSON БЕЗ самого поля resolutionHash
 * (иначе самоопределение). Считается при сохранении черновика (draftReady) и
 * пересчитывается после правки GM (editAndApprove).
 */
export function resolutionHashOf(resolution: TurnResolution): string {
  const { resolutionHash: _excluded, ...rest } = resolution;
  return sha256Hex(stableStringify(rest));
}
