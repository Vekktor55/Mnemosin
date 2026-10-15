import type { MessageId, NoteId } from '@mnemosin/contracts';
import { deterministicUuidFromSeed } from '@mnemosin/core';

/**
 * Детерминированные идентификаторы модуля gm (D247): из клиентского
 * idempotencyKey / noteId — стабильные uuid, поэтому повтор команды или
 * повторная доставка события не создают дублей.
 */

export function noteIdFromKey(idempotencyKey: string): NoteId {
  return deterministicUuidFromSeed(`gm-note:${idempotencyKey}`) as NoteId;
}

export function systemMessageIdFromKey(idempotencyKey: string): MessageId {
  return deterministicUuidFromSeed(`gm-sys:${idempotencyKey}`) as MessageId;
}

export function publicNoteMessageId(noteId: NoteId): MessageId {
  return deterministicUuidFromSeed(`note-public:${noteId}`) as MessageId;
}
