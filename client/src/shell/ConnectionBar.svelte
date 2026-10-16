<script lang="ts">
  /**
   * Индикатор соединения и фазы реконнекта (промпт 1.12, п.4; F-6.10):
   * статус, попытка N/maxAttempts, обратный отсчёт до следующего ретрая,
   * при FAILED — причина и кнопка «Подключиться снова»; при auth-отказе —
   * «Войти заново» (clientAction REAUTH из ERROR_TABLE).
   */
  import { connectionStore } from '../stores/connection.js';
  import { reconnectNow, logout } from '../app-context.js';

  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 500);
    return () => clearInterval(timer);
  });

  const snap = $derived($connectionStore);
  const secondsToRetry = $derived(
    snap.nextRetryAt !== null ? Math.max(0, Math.ceil((snap.nextRetryAt - now) / 1000)) : null,
  );
  const isAuthFailure = $derived(
    snap.status === 'FAILED' && (snap.reason === 'AUTH_INVALID' || snap.reason === 'AUTH_EXPIRED' || snap.reason === 'AUTH_FORBIDDEN'),
  );
  const statusText = $derived.by(() => {
    switch (snap.status) {
      case 'CONNECTED':
        return 'на связи';
      case 'CONNECTING':
        return snap.attempt > 0 ? `подключение… (попытка ${snap.attempt}/${snap.maxAttempts})` : 'подключение…';
      case 'RECONNECTING':
        return `переподключение… попытка ${snap.attempt}/${snap.maxAttempts}${secondsToRetry !== null ? `, следующая через ${secondsToRetry} с` : ''}`;
      case 'FAILED':
        return isAuthFailure ? 'вход недействителен' : 'соединение потеряно';
      case 'CLOSED':
        return 'отключено';
      default:
        return 'не подключено';
    }
  });
</script>

<div class="connection-bar" data-testid="connection-bar" data-status={snap.status}>
  <span class="connection-dot {snap.status}"></span>
  <span class="connection-status">{statusText}</span>
  {#if snap.status === 'FAILED' && snap.reason !== null && !isAuthFailure}
    <span class="dim">({snap.reason})</span>
    <button data-testid="reconnect-button" onclick={() => reconnectNow()}>Подключиться снова</button>
  {/if}
  {#if isAuthFailure}
    <span class="dim">({snap.reason})</span>
    <button data-testid="reauth-button" onclick={() => logout()}>Войти заново</button>
  {/if}
</div>
