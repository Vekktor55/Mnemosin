<script lang="ts">
  /**
   * Точка входа /gm (промпт 1.12, п.1, п.5): экран входа → GameShell + GMPanel.
   */
  import GameShell from '../shell/GameShell.svelte';
  import GmLogin from './GmLogin.svelte';
  import GMPanel from './GMPanel.svelte';
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

  $effect(() => {
    const identity = loadIdentity();
    if (phase === 'login' && identity !== null && identity.role === 'gm' && identity.token.length > 0) {
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
  <GameShell role="gm">
    {#snippet center()}
      <GMPanel />
    {/snippet}
  </GameShell>
{:else}
  <GmLogin onLogin={enter} initialError={loginError} />
{/if}
