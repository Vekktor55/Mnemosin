<script lang="ts">
  /**
   * Точка входа /player (промпт 1.12, п.1, п.4): экран входа → GameShell.
   * Сессия вкладки восстанавливается из sessionStorage (D126): перезагрузка
   * страницы не требует повторного логина, токен не покидает вкладку.
   */
  import GameShell from '../shell/GameShell.svelte';
  import LoginScreen from './LoginScreen.svelte';
  import TurnPanel from './TurnPanel.svelte';
  import { connectionStore } from '../stores/index.js';
  import { startConnection } from '../app-context.js';
  import { loadIdentity, type ClientIdentity } from '../lib/privacy.js';
  import { describeError, type DescribedError } from '../lib/errors.js';

  let phase = $state<'login' | 'game'>('login');
  let loginError = $state<DescribedError | null>(null);

  function enter(identity: ClientIdentity): void {
    loginError = null;
    startConnection({ identity });
    phase = 'game';
  }

  // Восстановление вкладки + выход при auth-отказе/разлогине.
  $effect(() => {
    const identity = loadIdentity();
    if (phase === 'login' && identity !== null && identity.role === 'player' && identity.token.length > 0) {
      startConnection({ identity });
      phase = 'game';
      return;
    }
    const status = $connectionStore.status;
    const reason = $connectionStore.reason;
    if (phase === 'game' && status === 'FAILED' && (reason === 'AUTH_INVALID' || reason === 'AUTH_EXPIRED' || reason === 'AUTH_FORBIDDEN')) {
      phase = 'login';
      loginError = describeError(reason, 'Токен недействителен или истёк — войдите заново');
      return;
    }
    if (phase === 'game' && (status === 'CLOSED' || status === 'IDLE') && loadIdentity() === null) {
      phase = 'login';
    }
  });
</script>

{#if phase === 'game'}
  <GameShell role="player">
    {#snippet center()}
      <TurnPanel />
    {/snippet}
  </GameShell>
{:else}
  <LoginScreen onLogin={enter} initialError={loginError} />
{/if}
