<script lang="ts">
  /** TurnStatus (SPEC §4): номер хода, статус, сколько действий принято. */
  import { turnStore, sessionStore } from '../stores/index.js';

  const turn = $derived($turnStore.turn);
  const sessionStatus = $derived($sessionStore.status);

  const statusBadge = $derived.by(() => {
    if (turn === null) return { cls: '', label: 'ход не открыт' };
    switch (turn.status) {
      case 'OPEN':
        return { cls: 'ok', label: 'OPEN — можно действовать' };
      case 'LOCKED':
        return { cls: 'warn', label: 'LOCKED — действия принимаются до обработки' };
      case 'PROCESSING':
        return { cls: 'warn', label: 'PROCESSING — AI-Директор собирает сцену' };
      case 'REVIEW':
        return { cls: 'accent', label: 'REVIEW — у ведущего на ревью' };
      case 'COMMITTED':
        return { cls: 'accent', label: 'COMMITTED — ход завершён' };
      case 'FAILED':
        return { cls: 'danger', label: 'FAILED — ход провалился' };
      default:
        return { cls: '', label: String(turn.status) };
    }
  });
</script>

<div class="turn-status-line" data-testid="turn-status">
  {#if turn !== null}
    <span class="turn-number">Ход #{turn.number}</span>
    <span class="badge {statusBadge.cls}">{statusBadge.label}</span>
    <span class="dim">принято действий: {turn.actionCount}</span>
    {#if turn.lockedAt !== null}<span class="faint">заблокирован: {turn.lockedAt.slice(11, 19)}</span>{/if}
  {:else}
    <span class="turn-number">Ход не открыт</span>
    <span class="badge">сессия: {sessionStatus ?? '…'}</span>
    <span class="dim">ждём, когда ведущий откроет ход</span>
  {/if}
  {#if turn?.failed}
    <span class="error-text">ошибка хода: {turn.failed.code} — {turn.failed.message}</span>
  {/if}
</div>
