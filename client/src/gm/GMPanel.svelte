<script lang="ts">
  /**
   * GMPanel (SPEC §5): SessionCard + вкладки Review / Turn / State / Inspect /
   * Notes / Audit. Содержимое вкладок — отдельные компоненты (gm/tabs/*).
   */
  import { sessionStore, uiStore, turnStore, GM_TABS } from '../stores/index.js';
  import { setGmTab, pushFeed } from '../stores/ui.js';
  import { api, ApiError } from '../net/http.js';
  import { describeError } from '../lib/errors.js';
  import { loadIdentity } from '../lib/privacy.js';
  import { newIdempotencyKey } from '../lib/ids.js';
  import ReviewTab from './tabs/ReviewTab.svelte';
  import TurnTab from './tabs/TurnTab.svelte';
  import StateTab from './tabs/StateTab.svelte';
  import InspectTab from './tabs/InspectTab.svelte';
  import NotesTab from './tabs/NotesTab.svelte';
  import AuditTab from './tabs/AuditTab.svelte';

  const session = $derived($sessionStore);
  const tab = $derived($uiStore.gmTab);
  const draftReady = $derived($turnStore.draft !== null || $turnStore.draftSummary !== null);

  const joinLink = $derived(
    session.sessionId !== null ? `${window.location.origin}/player/?session=${session.sessionId}` : null,
  );

  let startBusy = $state(false);

  /** LOBBY → ACTIVE: POST /sessions/:id/start (HTTP, idempotencyKey). */
  async function startSession(): Promise<void> {
    const sid = session.sessionId;
    if (sid === null || startBusy) return;
    startBusy = true;
    try {
      await api('POST', `/sessions/${sid}/start`, {
        token: loadIdentity()?.token ?? '',
        body: { idempotencyKey: newIdempotencyKey('start') },
      });
      pushFeed({ kind: 'gm-ack', text: 'Сессия стартовала: ход откройте кнопкой «Open next»' });
    } catch (cause) {
      const described =
        cause instanceof ApiError ? cause.described : describeError('NETWORK', cause instanceof Error ? cause.message : 'сеть недоступна');
      pushFeed({ kind: 'error', error: described });
    } finally {
      startBusy = false;
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard недоступен — поле readonly позволяет скопировать вручную */
    }
  }
</script>

<div class="panel session-card" data-testid="session-card">
  <strong>Сессия:</strong>
  <input readonly data-testid="session-id" value={session.sessionId ?? '…'} onclick={(event) => void copy((event.target as HTMLInputElement).value)} title="клик — скопировать" />
  <span class="badge {session.status === 'ACTIVE' ? 'ok' : ''}">{session.status ?? '…'}</span>
  {#if joinLink !== null}
    <input readonly data-testid="join-link" value={joinLink} onclick={(event) => void copy((event.target as HTMLInputElement).value)} title="ссылка входа игроков — клик копирует" />
  {/if}
  {#if session.status === 'LOBBY'}
    <button class="primary" data-testid="gm-start-session" onclick={() => void startSession()} disabled={startBusy}>
      {startBusy ? '…' : 'Старт сессии'}
    </button>
  {/if}
  {#if session.serverVersion !== null}
    <span class="faint">server {session.serverVersion} · contracts {session.contractsVersion}</span>
  {/if}
</div>

<div class="gm-tabs" role="tablist">
  {#each GM_TABS as item (item.id)}
    <button
      role="tab"
      class={tab === item.id ? 'active' : ''}
      data-testid="tab-{item.id}"
      aria-selected={tab === item.id}
      onclick={() => setGmTab(item.id)}
    >
      {item.label}{item.id === 'review' && draftReady ? ' ●' : ''}
    </button>
  {/each}
</div>

<div class="gm-tab-body">
  {#if tab === 'review'}
    <ReviewTab />
  {:else if tab === 'turn'}
    <TurnTab />
  {:else if tab === 'state'}
    <StateTab />
  {:else if tab === 'inspect'}
    <InspectTab />
  {:else if tab === 'notes'}
    <NotesTab />
  {:else if tab === 'audit'}
    <AuditTab />
  {/if}
</div>
