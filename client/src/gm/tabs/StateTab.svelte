<script lang="ts">
  /**
   * State (промпт 1.12, п.5): projection view=gm (POST /gm/inspect/state —
   * флаги с setBy, объекты, knowledge игроков, локации с gmSecret) и
   * moveGroup: выбор игроков и локации с клиентской проверкой exits и locked
   * (сервер всё равно валидирует правилами — клиент лишь не даёт отправить
   * заведомо невозможный переход). setFlag — ручная правка флага (setBy='GM').
   */
  import type { GMStateView } from '@mnemosin/contracts';

  import { sessionStore, turnStore } from '../../stores/index.js';
  import { gmCommand } from '../../app-context.js';
  import { api, ApiError } from '../../net/http.js';
  import { pushFeed } from '../../stores/ui.js';
  import { loadIdentity } from '../../lib/privacy.js';
  import { fmtDateTime, fmtJson, fmtScalar, shortId } from '../../lib/format.js';

  let gmState = $state<GMStateView | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let movePlayerIds = $state<string[]>([]);
  let moveLocationId = $state<string>('');
  let flagKey = $state('');
  let flagValue = $state('');

  const sessionId = $derived($sessionStore.sessionId);
  const currentLocation = $derived($sessionStore.publicState?.currentLocation ?? null);
  const players = $derived($sessionStore.publicState?.players ?? []);
  const busy = $derived($turnStore.gmOps);

  async function refresh(): Promise<void> {
    if (sessionId === null) return;
    loading = true;
    loadError = null;
    try {
      gmState = await api<GMStateView>('POST', '/gm/inspect/state', {
        token: loadIdentity()?.token ?? '',
        body: { sessionId },
      });
      sessionStore.update((state) => Object.freeze({ ...state, gmState }));
    } catch (cause) {
      loadError =
        cause instanceof ApiError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : 'ошибка загрузки';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (sessionId !== null) void refresh();
  });

  /** Проверка exits/locked: цель достижима из текущей локации? */
  const moveCheck = $derived.by(() => {
    if (currentLocation === null || moveLocationId === '') return null;
    if (currentLocation.locationId === moveLocationId) return { ok: false, hint: 'группа уже в этой локации' };
    const exit = currentLocation.exits.find((item) => item.toLocationId === moveLocationId);
    if (exit === undefined) return { ok: false, hint: 'из текущей локации нет выхода в выбранную (проверьте скрытые выходы — они тоже считаются)' };
    if (exit.locked) return { ok: false, hint: `выход «${exit.label}» заблокирован: ${exit.lockReason ?? 'причина не указана'}` };
    return { ok: true, hint: `через выход «${exit.label}»${exit.oneWay ? ' (односторонний)' : ''}` };
  });

  const canMove = $derived(movePlayerIds.length > 0 && moveLocationId !== '' && moveCheck?.ok === true);

  function moveGroup(): void {
    if (sessionId === null || !canMove) return;
    gmCommand('GM_MOVE_GROUP', { sessionId, playerIds: movePlayerIds, toLocationId: moveLocationId }, 'moveGroup');
  }

  function setFlag(): void {
    if (sessionId === null || flagKey.trim().length === 0 || flagValue.trim().length === 0) return;
    const raw = flagValue.trim();
    const value: boolean | number | string =
      raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) && raw.length > 0 ? Number(raw) : raw;
    gmCommand('GM_SET_FLAG', { sessionId, key: flagKey.trim(), value }, 'setFlag');
    pushFeed({ kind: 'gm-ack', text: `Флаг ${flagKey.trim()} = ${fmtScalar(value)} отправлен (setBy=GM)` });
    flagKey = '';
    flagValue = '';
  }

  function togglePlayer(playerId: string): void {
    movePlayerIds = movePlayerIds.includes(playerId) ? movePlayerIds.filter((id) => id !== playerId) : [...movePlayerIds, playerId];
  }

  const lastOpStatus = $derived.by(() => {
    const ops = Object.values(busy).filter((op) => op.action === 'moveGroup' || op.action === 'setFlag');
    ops.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return ops[0] ?? null;
  });
</script>

<div class="panel">
  <div class="review-header">
    <h3 class="panel-title" style="margin:0">Состояние (view=gm)</h3>
    <div class="review-actions">
      <button data-testid="state-refresh" onclick={() => void refresh()} disabled={loading}>{loading ? 'Загрузка…' : 'Обновить'}</button>
    </div>
  </div>
  {#if loadError !== null}
    <div class="error-text">{loadError}</div>
  {/if}
</div>

<div class="panel move-form">
  <h3 class="panel-title">Переместить группу (moveGroup)</h3>
  <div class="player-picks">
    {#each players as player (player.playerId)}
      {#if !player.isGM}
        <label>
          <input type="checkbox" data-testid="move-player-{player.displayName}" checked={movePlayerIds.includes(player.playerId)} onchange={() => togglePlayer(player.playerId)} />
          {player.displayName}
        </label>
      {/if}
    {/each}
  </div>
  <div class="form-row">
    <label class="dim" for="move-target">Куда:</label>
    <select id="move-target" data-testid="move-target" bind:value={moveLocationId}>
      <option value="">— выберите локацию —</option>
      {#each gmState?.locations ?? [] as location (location.locationId)}
        <option value={location.locationId}>{location.name}</option>
      {/each}
    </select>
  </div>
  {#if moveCheck !== null}
    <div class="form-hint {moveCheck.ok ? '' : 'warn'}" data-testid="move-check">{moveCheck.hint}</div>
  {/if}
  <div class="form-row">
    <button class="primary" data-testid="move-submit" onclick={moveGroup} disabled={!canMove}>Переместить</button>
    {#if lastOpStatus !== null && lastOpStatus.status !== 'BUSY'}
      <span class="form-hint {lastOpStatus.status === 'ERROR' ? 'warn' : ''}">{lastOpStatus.action}: {lastOpStatus.status === 'OK' ? 'OK' : lastOpStatus.error?.code ?? 'ERROR'}</span>
    {/if}
  </div>
</div>

<div class="panel flag-form">
  <h3 class="panel-title">Флаг вручную (setBy=GM)</h3>
  <div class="form-row">
    <input data-testid="flag-key" type="text" maxlength="80" placeholder="ключ (snake_case или room.flag)" bind:value={flagKey} />
    <input data-testid="flag-value" type="text" maxlength="500" placeholder="значение: true/false/число/строка" bind:value={flagValue} />
    <button data-testid="flag-submit" onclick={setFlag} disabled={flagKey.trim().length === 0 || flagValue.trim().length === 0}>GM_SET_FLAG</button>
  </div>
</div>

{#if gmState !== null}
  <div class="state-columns">
    <div class="panel">
      <h3 class="panel-title">Флаги ({gmState.flagsDetail.length})</h3>
      <table class="gm-table" data-testid="flags-table">
        <thead><tr><th>key</th><th>value</th><th>setBy</th><th>turn</th></tr></thead>
        <tbody>
          {#each gmState.flagsDetail as flag (flag.key)}
            <tr><td class="mono">{flag.key}</td><td>{fmtScalar(flag.value)}</td><td>{flag.setBy}</td><td>{flag.setAtTurnId !== null ? shortId(flag.setAtTurnId) : '—'}</td></tr>
          {/each}
        </tbody>
      </table>
      <h3 class="panel-title" style="margin-top:10px">Объекты</h3>
      <table class="gm-table">
        <thead><tr><th>objectId</th><th>visible</th><th>taken</th></tr></thead>
        <tbody>
          {#each gmState.session.objectStates as object (object.objectId)}
            <tr><td class="mono">{shortId(object.objectId)}</td><td>{String(object.visible)}</td><td>{String(object.taken)}</td></tr>
          {/each}
        </tbody>
      </table>
      <h3 class="panel-title" style="margin-top:10px">Отложенные эффекты</h3>
      {#if gmState.deferredEffects.length === 0}
        <div class="faint">нет</div>
      {:else}
        {#each gmState.deferredEffects as effect (effect.id)}
          <div class="form-hint">#{effect.id}: {effect.reason} (на ход {effect.applyAtTurnNumber})</div>
        {/each}
      {/if}
      <h3 class="panel-title" style="margin-top:10px">Ожидают ревью</h3>
      <div class="faint">{gmState.pendingReviews.length === 0 ? 'нет' : gmState.pendingReviews.map(shortId).join(', ')}</div>
    </div>

    <div class="panel">
      <h3 class="panel-title">Знания игроков (knowledge)</h3>
      {#each Object.entries(gmState.knowledgeByPlayer) as [playerId, entries] (playerId)}
        <div class="knowledge-block">
          <strong>{players.find((p) => p.playerId === playerId)?.displayName ?? shortId(playerId)}</strong>
          {#if entries.length === 0}
            <div class="faint">пусто</div>
          {:else}
            {#each entries as entry (entry.key)}
              <div><span class="k-key mono">{entry.key}</span>: {fmtScalar(entry.value)} <span class="faint">({entry.source})</span></div>
            {/each}
          {/if}
        </div>
      {/each}
      <h3 class="panel-title" style="margin-top:10px">Заметки ({gmState.notes.length})</h3>
      {#each gmState.notes as note (note.noteId)}
        <div class="note-item">
          <span class="badge">{note.visibility}</span> {note.text}
          <div class="note-meta">{fmtDateTime(note.createdAt)}</div>
        </div>
      {/each}
    </div>
  </div>

  <div class="panel">
    <h3 class="panel-title">Локации (GM-вид: скрытые выходы, невидимые объекты, gmSecret)</h3>
    {#each gmState.locations as location (location.locationId)}
      <details class="location-block">
        <summary>{location.name} {location.locationId === currentLocation?.locationId ? '· группа здесь' : ''}</summary>
        <div class="dim" style="margin:4px 0">{location.description}</div>
        {#if location.atmosphere.length > 0}<div class="faint">{location.atmosphere}</div>{/if}
        <div class="form-hint">
          выходы: {location.exits.map((exit) => `${exit.label}${exit.locked ? ' (заперт)' : ''}`).join(', ') || '—'}
          {location.hiddenExits.length > 0 ? ` · скрытые: ${location.hiddenExits.length}` : ''}
        </div>
        <div class="form-hint">
          объекты: {location.allObjects.map((object) => `${object.name}${object.visible ? '' : ' (невидим)'}`).join(', ') || '—'}
        </div>
        {#if location.gmSecret !== null}
          <div class="gm-secret" data-testid="gm-secret">GM-секрет: <pre class="journal-payload" style="margin:4px 0 0">{fmtJson(location.gmSecret)}</pre></div>
        {/if}
        {#if location.narrativeNotes.length > 0}
          <div class="form-hint">narrativeNotes: {location.narrativeNotes.slice(0, 300)}{location.narrativeNotes.length > 300 ? '…' : ''}</div>
        {/if}
      </details>
    {/each}
  </div>
{:else if !loading}
  <div class="panel faint">Нет данных — нажмите «Обновить».</div>
{/if}
