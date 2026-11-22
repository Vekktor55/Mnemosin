<script lang="ts">
  /**
   * VisualPanel (P05-B): контейнер PixiJS canvas + DOM HUD. Кадровый цикл и
   * ввод принадлежат GameWorld; сюда выводится только throttled-метрика.
   */
  import { gameStore } from '../stores/index.js';
  import { startGame } from '../app-context.js';
  import type { ClientIdentity } from '../lib/privacy.js';

  interface Props {
    identity: ClientIdentity;
  }

  let { identity }: Props = $props();

  let canvasHost = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const host = canvasHost;
    if (host === null) return;
    return startGame({ identity, parent: host });
  });

  const hud = $derived($gameStore);
</script>

<div class="visual-panel" data-testid="visual-panel">
  <div class="game-stage" bind:this={canvasHost} data-testid="game-stage"></div>
  <footer class="game-hud" data-testid="game-hud">
    <span class="hud-item">FPS {hud.fps}</span>
    <span class="hud-item">frame {hud.frameTimeMs} ms</span>
    <span class="hud-item">input→visual {hud.inputToVisualMs} ms</span>
    {#if hud.rttMs !== null}<span class="hud-item">RTT {hud.rttMs} ms</span>{/if}
    <span class="hud-item">players {hud.playerCount}</span>
  </footer>
</div>

<style>
  .visual-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .game-stage {
    flex: 1;
    position: relative;
    min-height: 0;
    background: #0a0a10;
  }
  .game-stage :global(canvas) {
    display: block;
  }
  .game-hud {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 6px 12px;
    font: 12px ui-monospace, monospace;
    color: #9a9ab0;
    background: #10101a;
    border-top: 1px solid #26263a;
  }
  .hud-item {
    white-space: nowrap;
  }
</style>
