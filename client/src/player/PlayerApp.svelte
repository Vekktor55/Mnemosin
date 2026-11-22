<script lang="ts">
  /**
   * Точка входа /player (P05-B): экран входа → GameShell. Сессия вкладки
   * восстанавливается из sessionStorage (D126): перезагрузка не требует
   * повторного логина, токен не покидает вкладку.
   */
  import GameShell from '../shell/GameShell.svelte';
  import LoginScreen from './LoginScreen.svelte';
  import { connectionStore } from '../stores/index.js';
  import { loadIdentity, clearIdentity, type ClientIdentity } from '../lib/privacy.js';
  import { describeError, type DescribedError } from '../lib/errors.js';

  let phase = $state<'login' | 'game'>('login');
  let identity = $state<ClientIdentity | null>(null);
  let loginError = $state<DescribedError | null>(null);

  function enter(id: ClientIdentity): void {
    loginError = null;
    identity = id;
    phase = 'game';
  }

  // Восстановление вкладки + выход при auth-отказе/разлогине.
  $effect(() => {
    const status = $connectionStore.status;
    const reason = $connectionStore.reason;
    const restored = loadIdentity();

    if (phase === 'login' && restored !== null && restored.role === 'player' && restored.token.length > 0) {
      identity = restored;
      phase = 'game';
      return;
    }
    if (phase === 'game' && restored === null) {
      identity = null;
      phase = 'login';
      return;
    }
    if (
      phase === 'game' &&
      status === 'FAILED' &&
      (reason === 'AUTH_INVALID' || reason === 'AUTH_EXPIRED' || reason === 'AUTH_FORBIDDEN')
    ) {
      clearIdentity();
      identity = null;
      phase = 'login';
      loginError = describeError(reason, 'Токен недействителен или истёк — войдите заново');
    }
  });
</script>

{#if phase === 'game' && identity !== null}
  <GameShell {identity} />
{:else}
  <LoginScreen onLogin={enter} initialError={loginError} />
{/if}
