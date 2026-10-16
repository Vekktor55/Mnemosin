<script lang="ts">
  /**
   * TurnControls (SPEC §5): Open next / Lock / Unlock / Cancel.
   * Open/Lock/Unlock — WS-команды GM_OPEN_TURN/GM_LOCK_TURN/GM_UNLOCK_TURN
   * (без оптимизма: состояние меняет серверный TURN_UPDATE); Cancel — HTTP
   * POST /turns/:id/cancel {reason, idempotencyKey}.
   */
  import { turnStore, sessionStore, uiStore } from '../stores/index.js';
  import { gmCommand } from '../app-context.js';
  import { api, ApiError } from '../net/http.js';
  import { pushFeed } from '../stores/ui.js';
  import { describeError } from '../lib/errors.js';
  import { newIdempotencyKey } from '../lib/ids.js';
  import { loadIdentity } from '../lib/privacy.js';

  let cancelReason = $state('');
  let showCancel = $state(false);
  let cancelBusy = $state(false);

  const turn = $derived($turnStore.turn);
  const sessionId = $derived($sessionStore.sessionId);
  const busy = $derived($uiStore.busyGmAction);

  const canOpen = $derived(sessionId !== null && (turn === null || turn.status === 'COMMITTED' || turn.status === 'FAILED'));
  const canLock = $derived(turn !== null && turn.status === 'OPEN');
  const canUnlock = $derived(turn !== null && turn.status === 'LOCKED');
  const canCancel = $derived(turn !== null && turn.status === 'OPEN');

  function openNext(): void {
    if (sessionId === null) return;
    gmCommand('GM_OPEN_TURN', { sessionId }, 'openTurn');
  }

  function lock(): void {
    if (turn === null) return;
    gmCommand('GM_LOCK_TURN', { turnId: turn.turnId }, 'lockTurn');
  }

  function unlock(): void {
    if (turn === null) return;
    gmCommand('GM_UNLOCK_TURN', { turnId: turn.turnId }, 'unlockTurn');
  }

  async function cancelTurn(): Promise<void> {
    const current = turn;
    const reason = cancelReason.trim();
    if (current === null || reason.length === 0) return;
    cancelBusy = true;
    try {
      const token = loadIdentity()?.token ?? '';
      await api('POST', `/turns/${current.turnId}/cancel`, {
        token,
        body: { reason, idempotencyKey: newIdempotencyKey('cancel') },
      });
      pushFeed({ kind: 'gm-ack', text: `Ход ${current.number} отменён: ${reason}` });
      showCancel = false;
      cancelReason = '';
    } catch (cause) {
      const described =
        cause instanceof ApiError ? cause.described : describeError('NETWORK', cause instanceof Error ? cause.message : 'сеть недоступна');
      pushFeed({ kind: 'error', error: described });
    } finally {
      cancelBusy = false;
    }
  }
</script>

<div class="turn-controls" data-testid="turn-controls">
  <button class="primary" data-testid="gm-open-turn" onclick={openNext} disabled={!canOpen || busy !== null}>
    {busy === 'openTurn' ? '…' : 'Open next'}
  </button>
  <button data-testid="gm-lock-turn" onclick={lock} disabled={!canLock || busy !== null}>
    {busy === 'lockTurn' ? '…' : 'Lock'}
  </button>
  <button data-testid="gm-unlock-turn" onclick={unlock} disabled={!canUnlock || busy !== null}>
    {busy === 'unlockTurn' ? '…' : 'Unlock'}
  </button>
  <button class="danger" data-testid="gm-cancel-turn" onclick={() => (showCancel = !showCancel)} disabled={!canCancel || busy !== null}>
    Cancel…
  </button>
  {#if showCancel && canCancel}
    <span class="form-row">
      <input data-testid="cancel-reason" type="text" maxlength="1000" placeholder="причина отмены" bind:value={cancelReason} />
      <button class="danger" data-testid="cancel-confirm" onclick={() => void cancelTurn()} disabled={cancelBusy || cancelReason.trim().length === 0}>
        {cancelBusy ? '…' : 'Отменить ход'}
      </button>
    </span>
  {/if}
</div>
