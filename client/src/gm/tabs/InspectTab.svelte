<script lang="ts">
  /**
   * Inspect (промпт 1.12, п.5): AI context (view=ai —
   * GET /state/projection/gm?view=ai) и журнал по ходу
   * (POST /gm/inspect/journal). Только GM (403 для игроков — A1.7).
   */
  import type { DirectorContext, JournalEntryView } from '@mnemosin/contracts';

  import { turnStore, sessionStore } from '../../stores/index.js';
  import { setAiContext } from '../../stores/turn.js';
  import { api, ApiError } from '../../net/http.js';
  import { pushFeed } from '../../stores/ui.js';
  import { describeError } from '../../lib/errors.js';
  import { loadIdentity } from '../../lib/privacy.js';
  import { fmtDateTime, fmtJson } from '../../lib/format.js';

  let turnIdInput = $state('');
  let journal = $state<JournalEntryView[] | null>(null);
  let context = $state<DirectorContext | null>(null);
  let loading = $state(false);

  const sessionId = $derived($sessionStore.sessionId);
  const currentTurnId = $derived($turnStore.turn?.turnId ?? '');

  $effect(() => {
    if (turnIdInput === '' && currentTurnId !== '') turnIdInput = currentTurnId;
  });

  function token(): string {
    return loadIdentity()?.token ?? '';
  }

  function fail(cause: unknown): void {
    const described =
      cause instanceof ApiError ? cause.described : describeError('NETWORK', cause instanceof Error ? cause.message : 'сеть недоступна');
    pushFeed({ kind: 'error', error: described });
  }

  async function loadContext(): Promise<void> {
    if (sessionId === null || turnIdInput.trim().length === 0) return;
    loading = true;
    try {
      context = await api<DirectorContext>('GET', '/state/projection/gm', {
        token: token(),
        query: { sessionId, view: 'ai' },
      });
      setAiContext(context);
      journal = null;
    } catch (cause) {
      fail(cause);
    } finally {
      loading = false;
    }
  }

  async function loadJournal(): Promise<void> {
    if (turnIdInput.trim().length === 0) return;
    loading = true;
    try {
      journal = await api<JournalEntryView[]>('POST', '/gm/inspect/journal', {
        token: token(),
        body: { turnId: turnIdInput.trim() },
      });
      context = null;
    } catch (cause) {
      fail(cause);
    } finally {
      loading = false;
    }
  }
</script>

<div class="panel">
  <h3 class="panel-title">Инспекция хода</h3>
  <div class="form-row">
    <label class="dim" for="inspect-turn">turnId:</label>
    <input id="inspect-turn" data-testid="inspect-turn" type="text" size="38" class="mono" bind:value={turnIdInput} placeholder={currentTurnId !== '' ? currentTurnId : 'uuid хода'} />
    <button data-testid="inspect-context" onclick={() => void loadContext()} disabled={loading || sessionId === null}>AI context (view=ai)</button>
    <button data-testid="inspect-journal" onclick={() => void loadJournal()} disabled={loading || turnIdInput.trim().length === 0}>Журнал хода</button>
  </div>
  <div class="form-hint">AI context — что видит модель (локация AI-вида, действия, флаги, разрешённые события). Журнал — append-only лента хода.</div>
</div>

{#if context !== null}
  <div class="panel">
    <h3 class="panel-title">DirectorContext · ход #{context.turnNumber}</h3>
    <div class="form-hint">
      локация: {context.currentLocation.name} · действий: {context.visiblePlayerActions.length} ·
      разрешено событий: {context.allowedEventIds.length} · timeOfDay: {context.relevantState.timeOfDay}
    </div>
    <pre class="inspect-json" data-testid="ai-context-json">{fmtJson(context)}</pre>
  </div>
{/if}

{#if journal !== null}
  <div class="panel">
    <h3 class="panel-title">Журнал ({journal.length} записей)</h3>
    {#if journal.length === 0}
      <div class="faint">пусто</div>
    {:else}
      <table class="gm-table" data-testid="journal-table">
        <thead><tr><th>#</th><th>kind</th><th>traceId</th><th>время</th><th>payload</th></tr></thead>
        <tbody>
          {#each journal as entry (entry.id)}
            <tr>
              <td>{entry.id}</td>
              <td class="mono">{entry.kind}</td>
              <td class="mono">{entry.traceId.slice(0, 8)}…</td>
              <td>{fmtDateTime(entry.createdAt)}</td>
              <td><pre class="journal-payload">{fmtJson(entry.payload)}</pre></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}
