<script lang="ts">
  /**
   * Turn (промпт 1.12, п.5): lock/unlock/open next/cancel + лента действий с
   * sequenceId. Состояние хода — только из серверных TURN_UPDATE (без оптимизма).
   * Полный список действий хода GM добирает из журнала (вкладка Inspect):
   * TURN_UPDATE в broadcast не содержит чужих rawText (D268).
   */
  import { turnStore, sessionStore } from '../../stores/index.js';
  import TurnControls from '../TurnControls.svelte';
  import { fmtDateTime } from '../../lib/format.js';

  const turn = $derived($turnStore.turn);
  const session = $derived($sessionStore);
  const gmOps = $derived(Object.values($turnStore.gmOps).filter((op) => ['openTurn', 'lockTurn', 'unlockTurn'].includes(op.action)));
</script>

<div class="panel">
  <h3 class="panel-title">Управление ходом</h3>
  <div class="turn-card-line" data-testid="gm-turn-card">
    {#if turn !== null}
      <strong>Ход #{turn.number}</strong>
      <span class="badge {turn.status === 'OPEN' ? 'ok' : turn.status === 'REVIEW' ? 'accent' : turn.status === 'FAILED' ? 'danger' : 'warn'}">{turn.status}</span>
      <span class="dim">действий: {turn.actionCount}</span>
      <span class="faint mono">{turn.turnId}</span>
      {#if turn.lockedAt !== null}<span class="faint">locked: {fmtDateTime(turn.lockedAt)}</span>{/if}
      {#if turn.committedAt !== null}<span class="faint">committed: {fmtDateTime(turn.committedAt)}</span>{/if}
      {#if turn.failed !== null}<span class="error-text">failed: {turn.failed.code} — {turn.failed.message}</span>{/if}
    {:else}
      <span class="faint">Ход не открыт. Сессия: {session.status ?? '…'} — нажмите «Open next».</span>
    {/if}
  </div>
  <div style="margin-top:8px">
    <TurnControls />
  </div>
  {#each gmOps as op (op.requestId)}
    {#if op.status !== 'BUSY'}
      <div class="form-hint {op.status === 'ERROR' ? 'warn' : ''}">{op.action}: {op.status === 'OK' ? 'OK' : op.error?.code ?? 'ERROR'}</div>
    {/if}
  {/each}
</div>

<div class="panel">
  <h3 class="panel-title">Лента действий (sequenceId)</h3>
  <div class="actions-feed" data-testid="actions-feed">
    {#if turn === null || turn.myActions.length === 0}
      <div class="faint">Действий пока нет. Свои действия GM видны здесь; полный список — во вкладке Inspect (журнал хода).</div>
    {:else}
      {#each turn.myActions as action (action.actionId)}
        <div class="action-row">
          <span class="seq">#{action.sequenceId}</span>
          <span>{action.rawText}</span>
          <span class="faint" style="margin-left:auto">{fmtDateTime(action.createdAt)}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>
