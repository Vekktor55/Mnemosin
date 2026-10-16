/**
 * Сторы клиента (промпт 1.12, п.3; v3 §VII.2; D125).
 *
 * D125: выбраны immutable-сторы на `svelte/store` (writable), НЕ runes-сторы:
 * - обработчики WS живут ВНЕ компонент (stores/handlers.ts, net/ws-client.ts) —
 *   writable-сторы обновляются из любого модуля без компонентного контекста;
 * - Svelte 5 полностью поддерживает svelte/store ($-автоподписка в компонентах),
 *   смешивания механизмов нет: ОБЩИЕ сторы — только svelte/store, локальное
 *   состояние компонентов — runes ($state/$derived);
 * - каждый update() создаёт новый замороженный снимок (immutable-правило §VII.2).
 *
 * Правило §VII.8: сторы обновляются ТОЛЬКО обработчиками WS-сообщений
 * (stores/handlers.ts) и локальными optimistic-операциями (app-context.ts)
 * с последующим reconcile по ack. GM_COMMIT_TURN — без оптимизма.
 */
import { writable } from 'svelte/store';

import { IDLE_SNAPSHOT, type ConnectionSnapshot } from '../net/ws-client.js';

/** Состояние соединения (v3 §VII.3): статус + attempt + nextRetryAt + причина. */
export const connectionStore = writable<ConnectionSnapshot>(IDLE_SNAPSHOT);
