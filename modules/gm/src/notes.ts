import { nowIso, type DomainEvent, type GMNote, type NoteId } from '@mnemosin/contracts';
import { appendOutbox, createEvent, newTraceId, runCommand } from '@mnemosin/core';

import { AddNoteInputSchema, AddNoteOutputSchema, type AddNoteInput, type AddNoteOutput } from './contract.js';
import type { GmServiceDeps } from './deps.js';
import { noteIdFromKey, publicNoteMessageId } from './ids.js';
import { assertGmPlayer } from './access.js';

/**
 * GM-заметки (промпт 1.9, п.6; v3 §IV.8; F-3.8).
 *
 * addNote: gm_notes + GM_NOTE_ADDED{sessionId, noteId, visibility} +
 * GM_ACTION_PERFORMED{addNote} — одной транзакцией под идемпотентным ключом;
 * noteId детерминирован из ключа (D247) — повтор не создаёт вторую заметку.
 *
 * TURN_COMMITTED (подписка, boot в modules-registry): заметки
 * visibility='PUBLIC_AFTER_COMMIT' публикуются в чат СИСТЕМНЫМИ сообщениями.
 * Ровно один раз (F-3.8): messageId детерминирован из noteId — повторная
 * доставка события упирается в уже существующее сообщение (chat-дедупликация).
 */

export async function addNote(deps: GmServiceDeps, rawInput: AddNoteInput): Promise<AddNoteOutput> {
  const input = AddNoteInputSchema.parse(rawInput);
  const traceId = input.traceId ?? newTraceId();
  const turnId = input.turnId ?? null;
  await assertGmPlayer(deps.uow, input.sessionId, input.gmPlayerId);
  const noteId: NoteId = noteIdFromKey(String(input.idempotencyKey));

  const result = await runCommand(
    deps.guard,
    { key: String(input.idempotencyKey), command: 'addNote', sessionId: input.sessionId, turnId, traceId },
    async (scope) => {
      // Дедупликация по детерминированному noteId (страховка от гонки ключей).
      const existing = await scope.repos.gmNotes.findById(noteId);
      if (existing !== null) return { noteId };

      const note: GMNote = {
        noteId,
        sessionId: input.sessionId,
        turnId,
        visibility: input.visibility,
        text: input.text.trim(),
        createdAt: nowIso(),
      };
      await scope.repos.gmNotes.insert(note);
      await appendOutbox(
        [
          createEvent('GM_NOTE_ADDED', { sessionId: input.sessionId, noteId, visibility: input.visibility }, traceId),
          createEvent(
            'GM_ACTION_PERFORMED',
            {
              sessionId: input.sessionId,
              gmPlayerId: input.gmPlayerId,
              action: 'addNote',
              meta: { noteId, visibility: input.visibility, turnId },
              idempotencyKey: input.idempotencyKey,
            },
            traceId,
          ),
        ],
        scope,
      );
      return { noteId };
    },
  );
  return AddNoteOutputSchema.parse({ noteId: result.value.noteId, replayed: result.replayed });
}

/** Обработчик TURN_COMMITTED: публикация PUBLIC_AFTER_COMMIT-заметок (F-3.8). */
export async function onTurnCommittedNotes(deps: GmServiceDeps, event: DomainEvent): Promise<void> {
  if (event.type !== 'TURN_COMMITTED') return;
  const { sessionId, turnId } = event.payload;
  const notes = await deps.uow.repos().gmNotes.listBySession(sessionId, 500);
  const pending = notes
    .filter((note) => note.visibility === 'PUBLIC_AFTER_COMMIT')
    // listBySession отдаёт новые сверху — публикуем в хронологическом порядке.
    .reverse();
  for (const note of pending) {
    // messageId детерминирован из noteId: chat-сервис пропускает повтор (ровно один раз).
    await deps.chat.sendSystemMessage({
      sessionId,
      text: note.text,
      turnId,
      messageId: publicNoteMessageId(note.noteId),
      traceId: event.traceId,
    });
  }
}
