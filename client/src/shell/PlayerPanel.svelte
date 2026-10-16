<script lang="ts">
  /**
   * PlayerPanel (SPEC §4): список игроков с presence, текущая локация
   * (описание, выходы, объекты), публичные флаги (D124), погода/время,
   * свой knowledge (STATE_PROJECTION_PRIVATE).
   */
  import { sessionStore } from '../stores/index.js';
  import { fmtScalar } from '../lib/format.js';

  const state = $derived($sessionStore);
  const players = $derived(state.publicState?.players ?? []);
  const location = $derived(state.publicState?.currentLocation ?? null);
  const flags = $derived(Object.entries(state.publicState?.storyFlags ?? {}));
  const knowledge = $derived(state.privateState?.knowledge ?? []);

  function presenceOf(playerId: string): string {
    return state.presence[playerId]?.status ?? players.find((p) => p.playerId === playerId)?.status ?? 'ACTIVE';
  }
</script>

<div class="panel">
  <h3 class="panel-title">Игроки</h3>
  <div class="player-list" data-testid="player-list">
    {#each players as player (player.playerId)}
      <div class="player-row">
        <span class="presence-dot {presenceOf(player.playerId)}"></span>
        <span>{player.displayName}</span>
        {#if player.characterName !== player.displayName}
          <span class="dim">({player.characterName})</span>
        {/if}
        {#if player.isGM}<span class="badge warn">GM</span>{/if}
        {#if player.playerId === state.myPlayerId}<span class="badge accent">вы</span>{/if}
      </div>
    {/each}
    {#if players.length === 0}
      <div class="faint">Список игроков появится после подключения.</div>
    {/if}
  </div>
</div>

<div class="panel location-card">
  <h3 class="panel-title">Сцена</h3>
  {#if location !== null}
    <div class="location-name" data-testid="location-name">{location.name}</div>
    <div class="location-desc">{location.description}</div>
    {#if state.publicState?.timeOfDay}
      <div class="dim">
        Время: {state.publicState.timeOfDay}{state.publicState.weather !== null ? ` · погода: ${state.publicState.weather}` : ''}
      </div>
    {/if}
    {#if location.exits.length > 0}
      <div class="panel-title" style="margin-top:8px">Выходы</div>
      <div class="exit-list">
        {#each location.exits as exit, index (index)}
          <span class="badge {exit.locked ? 'danger' : ''}" title={exit.description ?? ''}>
            {exit.label}{exit.locked ? ` — ${exit.lockReason ?? 'заперто'}` : ''}
          </span>
        {/each}
      </div>
    {/if}
    {#if location.objects.length > 0}
      <div class="panel-title" style="margin-top:8px">Объекты</div>
      <div class="object-list">
        {#each location.objects as object (object.objectId)}
          <span class="badge" title={object.description}>
            {object.name}{object.takeable ? ' · можно взять' : ''}{object.interactive ? ' · интерактивен' : ''}
          </span>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="faint">Локация ещё не загружена.</div>
  {/if}
</div>

{#if flags.length > 0}
  <div class="panel">
    <h3 class="panel-title">Флаги истории</h3>
    <div class="flag-chips" data-testid="story-flags">
      {#each flags as [key, value] (key)}
        <span class="flag-chip">{key} = {fmtScalar(value)}</span>
      {/each}
    </div>
  </div>
{/if}

{#if knowledge.length > 0}
  <div class="panel">
    <h3 class="panel-title">Ваши знания</h3>
    <div class="knowledge-list" data-testid="knowledge-list">
      {#each knowledge as entry (entry.key)}
        <div><span class="k-key">{entry.key}</span>: {fmtScalar(entry.value)} <span class="faint">({entry.source})</span></div>
      {/each}
    </div>
  </div>
{/if}
