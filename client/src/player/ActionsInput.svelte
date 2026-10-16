<script lang="ts">
  /**
   * ActionsInput (SPEC §4): текст + intent + счётчик оставшихся действий
   * (5/ход — actionsPerPlayerPerTurn, config/limits.yaml; сервер enforce'ит,
   * клиент лишь не даёт отправить сверх лимита). Отправка — оптимистичная,
   * с idempotencyKey (crypto.randomUUID, ≥16 символов).
   */
  import type { ActionIntent } from '@mnemosin/contracts';

  import { turnStore, sessionStore, connectionStore } from '../stores/index.js';
  import { submitAction } from '../app-context.js';
  import { pluralActions } from '../lib/format.js';

  /** Зеркало config/limits.yaml actionsPerPlayerPerTurn (этап 1). */
  const ACTIONS_PER_TURN = 5;

  const INTENTS: readonly { readonly value: ActionIntent | ''; readonly label: string }[] = Object.freeze([
    { value: '', label: 'свободно' },
    { value: 'SPEAK', label: 'сказать' },
    { value: 'ACT', label: 'действовать' },
    { value: 'MOVE', label: 'переместиться' },
    { value: 'USE', label: 'использовать' },
    { value: 'OBSERVE', label: 'осмотреть' },
    { value: 'WAIT', label: 'ждать' },
    { value: 'CUSTOM', label: 'особое…' },
  ]);

  let text = $state('');
  let intent = $state<ActionIntent | ''>('');
  let customLabel = $state('');

  const turn = $derived($turnStore.turn);
  const connectionStatus = $derived($connectionStore.status);
  /**
   * Отправка разрешена и БЕЗ соединения (CONNECTING/RECONNECTING): сообщение
   * уходит в offline-очередь и переотправляется после реконнекта (A1.9,
   * SPEC §6.4). Блокировка — только FAILED/CLOSED/IDLE.
   */
  const canQueue = $derived(
    connectionStatus === 'CONNECTED' || connectionStatus === 'CONNECTING' || connectionStatus === 'RECONNECTING',
  );
  /**
   * Принято за ход: серверные myActions + локальные PENDING/ACKED, которых ещё
   * нет в myActions (TURN_UPDATE приходит только на события жизненного цикла
   * хода — не на каждое действие).
   */
  const acceptedCount = $derived.by(() => {
    const turn = $turnStore.turn;
    const serverIds = new Set((turn?.myActions ?? []).map((action) => action.actionId));
    const locals = Object.values($turnStore.submittedActions).filter(
      (item) => item.status === 'PENDING' || (item.status === 'ACKED' && (item.actionId === null || !serverIds.has(item.actionId))),
    );
    return (turn?.myActions.length ?? 0) + locals.length;
  });
  const actionsLeft = $derived(Math.max(0, ACTIONS_PER_TURN - acceptedCount));
  const canSubmit = $derived(
    canQueue && turn !== null && turn.status === 'OPEN' && actionsLeft > 0 && text.trim().length > 0 && text.length <= 4000,
  );
  const blockReason = $derived.by(() => {
    if (!canQueue) return 'соединение не установлено — действие нельзя поставить в очередь';
    if (turn === null) return 'ход ещё не открыт';
    if (turn.status !== 'OPEN') return `ход в статусе ${turn.status} — действия не принимаются`;
    if (actionsLeft <= 0) return 'лимит действий на ход исчерпан';
    return null;
  });

  function submit(): void {
    if (!canSubmit || turn === null) return;
    submitAction(turn.turnId, text.trim(), intent === '' ? undefined : {
      intent,
      customLabel: intent === 'CUSTOM' && customLabel.trim().length > 0 ? customLabel.trim() : null,
    });
    text = '';
    customLabel = '';
  }

  function onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  }

  const sessionActive = $derived($sessionStore.status === 'ACTIVE' || $sessionStore.status === null);
</script>

<div class="actions-input">
  <textarea
    data-testid="action-input"
    placeholder={sessionActive ? 'Что делает ваш персонаж? (Ctrl+Enter — отправить)' : 'Сессия не активна'}
    maxlength="4000"
    bind:value={text}
    onkeydown={onKeydown}
    disabled={!sessionActive}
  ></textarea>
  <div class="input-row">
    <select data-testid="action-intent" bind:value={intent} aria-label="Тип действия">
      {#each INTENTS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    {#if intent === 'CUSTOM'}
      <input data-testid="action-custom-label" type="text" maxlength="80" placeholder="уточнение (customLabel)" bind:value={customLabel} />
    {/if}
    <button class="primary" data-testid="action-submit" onclick={submit} disabled={!canSubmit}>Действовать</button>
    <span class="actions-counter" data-testid="actions-left">
      осталось: {actionsLeft} / {ACTIONS_PER_TURN} ({pluralActions(actionsLeft)})
    </span>
  </div>
  {#if blockReason !== null && text.trim().length > 0}
    <div class="form-hint warn">{blockReason}</div>
  {/if}
</div>
