<script lang="ts">
  /**
   * Notes (промпт 1.12, п.5): добавление заметок с visibility
   * (GM_ONLY | AI_DIRECTOR | PUBLIC_AFTER_COMMIT) через WS GM_ADD_NOTE →
   * GM_NOTE_ACK; список — из GMStateView.notes (POST /gm/inspect/state).
   */
  import type { GMNoteVisibility } from '@mnemosin/contracts';

  import { sessionStore, turnStore } from '../../stores/index.js';
  import { gmAddNote } from '../../app-context.js';
  import { fmtDateTime } from '../../lib/format.js';

  const VISIBILITIES: readonly { readonly value: GMNoteVisibility; readonly label: string }[] = Object.freeze([
    { value: 'GM_ONLY', label: 'GM_ONLY (только ведущий)' },
    { value: 'AI_DIRECTOR', label: 'AI_DIRECTOR (видит модель)' },
    { value: 'PUBLIC_AFTER_COMMIT', label: 'PUBLIC_AFTER_COMMIT (игроки после коммита)' },
  ]);

  let visibility = $state<GMNoteVisibility>('GM_ONLY');
  let text = $state('');
  let attachTurn = $state(true);

  const sessionId = $derived($sessionStore.sessionId);
  const currentTurnId = $derived($turnStore.turn?.turnId ?? null);
  const notes = $derived($sessionStore.gmState?.notes ?? []);
  const noteOp = $derived.by(() => {
    const ops = Object.values($turnStore.gmOps).filter((op) => op.action === 'addNote');
    ops.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return ops[0] ?? null;
  });

  function submit(): void {
    if (sessionId === null || text.trim().length === 0) return;
    gmAddNote({
      sessionId,
      turnId: attachTurn ? currentTurnId : null,
      visibility,
      text: text.trim(),
    });
    text = '';
  }
</script>

<div class="panel notes-form">
  <h3 class="panel-title">Заметки GM</h3>
  <div class="form-row">
    <label class="dim" for="note-visibility">visibility:</label>
    <select id="note-visibility" data-testid="note-visibility" bind:value={visibility}>
      {#each VISIBILITIES as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <label class="dim">
      <input type="checkbox" data-testid="note-attach-turn" bind:checked={attachTurn} disabled={currentTurnId === null} />
      привязать к текущему ходу {currentTurnId !== null ? '' : '(хода нет)'}
    </label>
  </div>
  <textarea data-testid="note-text" maxlength="4000" placeholder="Текст заметки…" bind:value={text}></textarea>
  <div class="form-row">
    <button class="primary" data-testid="note-submit" onclick={submit} disabled={sessionId === null || text.trim().length === 0 || noteOp?.status === 'BUSY'}>
      {noteOp?.status === 'BUSY' ? 'Отправка…' : 'Добавить заметку'}
    </button>
    {#if noteOp !== null && noteOp.status === 'OK'}
      <span class="ok-text form-hint">заметка сохранена</span>
    {:else if noteOp !== null && noteOp.status === 'ERROR' && noteOp.error !== null}
      <span class="error-text form-hint">{noteOp.error.code}: {noteOp.error.hint}</span>
    {/if}
  </div>
</div>

<div class="panel">
  <h3 class="panel-title">Сохранённые заметки ({notes.length})</h3>
  {#if notes.length === 0}
    <div class="faint">Заметок нет. Список обновляется вкладкой State (POST /gm/inspect/state) или после перезахода.</div>
  {:else}
    {#each notes as note (note.noteId)}
      <div class="note-item" data-testid="note-item">
        <span class="badge">{note.visibility}</span>
        <span>{note.text}</span>
        <div class="note-meta">{fmtDateTime(note.createdAt)}</div>
      </div>
    {/each}
  {/if}
</div>
