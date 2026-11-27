<script lang="ts">
  /**
   * GameShell (P05-B): чистый DOM overlay поверх PixiJS canvas. Legacy TurnPanel,
   * чаты, PlayerPanel и GM-панель удалены вместе с v3-протоколом.
   */
  import ConnectionBar from './ConnectionBar.svelte';
  import VisualPanel from './VisualPanel.svelte';
  import type { ClientIdentity } from '../lib/privacy.js';

  interface Props {
    identity: ClientIdentity;
  }

  let { identity }: Props = $props();
</script>

<div class="game-shell" data-testid="game-shell">
  <header class="game-header">
    <div class="game-title">МНЕМО<em>СИН</em></div>
    <ConnectionBar />
  </header>
  <VisualPanel {identity} />
</div>

<style>
  .game-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #0a0a10;
    color: #c9c9d8;
  }
  .game-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 14px;
    border-bottom: 1px solid #26263a;
    background: #10101a;
  }
  .game-title {
    font-size: 18px;
    letter-spacing: 2px;
  }
  .game-title em {
    font-style: normal;
    color: #7f4f9b;
  }
</style>
