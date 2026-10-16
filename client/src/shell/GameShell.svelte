<script lang="ts">
  /**
   * GameShell — общий shell двух точек входа (промпт 1.12, п.1; SPEC §4–§5).
   * role='player': центр — TurnPanel игрока; role='gm': центр — GMPanel.
   * Колонки: слева PlayerPanel+VisualPanel, справа чаты, в центре лента.
   */
  import type { Snippet } from 'svelte';

  import ConnectionBar from './ConnectionBar.svelte';
  import SystemFeed from './SystemFeed.svelte';
  import PublicChat from './PublicChat.svelte';
  import PrivateChat from './PrivateChat.svelte';
  import PlayerPanel from './PlayerPanel.svelte';
  import VisualPanel from './VisualPanel.svelte';
  import { sessionStore } from '../stores/index.js';
  import { logout } from '../app-context.js';

  interface Props {
    role: 'player' | 'gm';
    /** Ролевое содержимое центра (TurnPanel игрока / GMPanel). */
    center: Snippet;
  }

  let { role, center }: Props = $props();

  const session = $derived($sessionStore);
  const who = $derived(session.myPlayerId ?? '');
</script>

<div class={role === 'gm' ? 'gm-shell' : 'player-shell'} data-testid="game-shell" data-role={role}>
  <header class={role === 'gm' ? 'gm-header' : 'player-header'}>
    <div class={role === 'gm' ? 'gm-title' : 'player-title'}>
      МНЕМО<em>СИН</em>
      {#if role === 'gm'}<span class="badge warn" style="margin-left:10px">ведущий</span>{/if}
    </div>
    <ConnectionBar />
    <div class="dim" style="display:flex; gap:10px; align-items:center;">
      <span data-testid="who-am-i">{session.publicState?.players.find((p) => p.playerId === who)?.displayName ?? '…'}</span>
      <button data-testid="logout-button" onclick={() => logout()}>Выйти</button>
    </div>
  </header>

  <div class={role === 'gm' ? 'gm-left' : 'player-left'}>
    <PlayerPanel />
    <VisualPanel />
  </div>

  <div class={role === 'gm' ? 'gm-center' : 'player-center'}>
    {@render center()}
    <SystemFeed />
  </div>

  <div class={role === 'gm' ? 'gm-right' : 'player-right'}>
    <PublicChat />
    <PrivateChat />
  </div>
</div>
