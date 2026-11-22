<script lang="ts">
  /**
   * Точка входа /player (P05-B): экран входа → GameShell. Сессия вкладки
   * восстанавливается из sessionStorage (D126): перезагрузка не требует
   * повторного логина, токен не покидает вкладку.
   * Dev-only: ?session=<id>#token=<jwt> автологин через fragment (не уходит на сервер).
   */
  import GameShell from '../shell/GameShell.svelte';
  import LoginScreen from './LoginScreen.svelte';
  import { connectionStore } from '../stores/index.js';
  import { loadIdentity, saveIdentity, clearIdentity, type ClientIdentity } from '../lib/privacy.js';
  import { describeError, type DescribedError } from '../lib/errors.js';

  let phase = $state<'login' | 'game'>('login');
  let identity = $state<ClientIdentity | null>(null);
  let loginError = $state<DescribedError | null>(null);

  function enter(id: ClientIdentity): void {
    loginError = null;
    identity = id;
    phase = 'game';
  }

  // Dev-only автологин через URL fragment (#token=...) — fragment не уходит на сервер.
  function tryFragmentAutoLogin(): void {
    try {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const token = fragment.get('token');
      const session = new URLSearchParams(window.location.search).get('session');
      if (token && session && token.length > 10 && session.length > 10) {
        const id: ClientIdentity = {
          role: 'player',
          token,
          refreshToken: null,
          playerId: null,
          sessionId: session,
          displayName: 'dev-player',
          characterName: 'dev-player',
        };
        saveIdentity(id);
        identity = id;
        phase = 'game';
        // Убираем fragment из адресной строки (history.replaceState не триггерит reload).
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
      }
    } catch {
      // игнорируем некорректные URL
    }
  }

  // Восстановление вкладки + выход при auth-отказе/разлогине.
  $effect(() => {
    const status = $connectionStore.status;
    const reason = $connectionStore.reason;
    const restored = loadIdentity();

    if (phase === 'login') {
      tryFragmentAutoLogin();
      if (restored !== null && restored.role === 'player' && restored.token.length > 0) {
        identity = restored;
        phase = 'game';
        return;
      }
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
