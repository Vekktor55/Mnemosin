import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { SessionId, TurnId } from '@mnemosin/contracts';
import { appendOutbox, createEvent } from '@mnemosin/core';
import { bootstrapDatabase } from '@mnemosin/database';

/**
 * tools/dev/inject-outbox-event.ts — dev-утилита (промпт 1.5).
 *
 * Кладёт тестовое событие TURN_OPENED в event_outbox указанной БД (одной
 * транзакцией, как это делает доменный код). Если сервер запущен на той же БД,
 * его outbox-публикатор поднимет событие в течение outboxPollMs (250 мс) и
 * опубликует в шину — в логе сервера появится `outbox_poll`.
 *
 * Зачем: живая проверка цикла публикации без HTTP/WS-слоя (их ещё нет, промпты
 * 1.10–1.11). Обработчиков на TURN_OPENED в этапе 1.5 нет — событие просто
 * помечается PUBLISHED (dispatched=0).
 *
 * Запуск: npx tsx --conditions=development tools/dev/inject-outbox-event.ts [DATABASE_URL]
 * (по умолчанию file:./data/mnemosin.sqlite)
 */

const url = process.argv[2] ?? 'file:./data/mnemosin.sqlite';

const boot = await bootstrapDatabase({ url, seed: false, migrate: false });
const event = createEvent(
  'TURN_OPENED',
  {
    sessionId: randomUUID() as SessionId,
    turnId: randomUUID() as TurnId,
    number: 1,
  },
  `dev-inject-${randomUUID().slice(0, 8)}`,
);
const [record] = await boot.uow.runInTx((scope) => appendOutbox([event], scope));
await boot.close();

process.stdout.write(`injected outbox id=${String(record?.id)} traceId=${event.traceId} url=${url}\n`);
