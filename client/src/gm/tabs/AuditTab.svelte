<script lang="ts">
  /**
   * Audit (промпт 1.12, п.5): лента gm_audit (GET /gm/audit?sessionId=…).
   * append-only реестр всех GM-действий (Repudiation-защита, SPEC §10).
   */
  import type { GmAuditEntryView } from '@mnemosin/contracts';

  import { sessionStore } from '../../stores/index.js';
  import { api, ApiError } from '../../net/http.js';
  import { pushFeed } from '../../stores/ui.js';
  import { describeError } from '../../lib/errors.js';
  import { loadIdentity } from '../../lib/privacy.js';
  import { fmtDateTime, fmtJson, shortId } from '../../lib/format.js';

  let entries = $state<GmAuditEntryView[] | null>(null);
  let loading = $state(false);

  const sessionId = $derived($sessionStore.sessionId);

  async function refresh(): Promise<void> {
    if (sessionId === null) return;
    loading = true;
    try {
      // limit НЕ передаём: query-параметры приходят строками, а схема маршрута
      // ждёт number без coercion (400 VALIDATION); серверный дефолт — 200.
      entries = await api<GmAuditEntryView[]>('GET', '/gm/audit', {
        token: loadIdentity()?.token ?? '',
        query: { sessionId },
      });
    } catch (cause) {
      const described =
        cause instanceof ApiError ? cause.described : describeError('NETWORK', cause instanceof Error ? cause.message : 'сеть недоступна');
      pushFeed({ kind: 'error', error: described });
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (sessionId !== null) void refresh();
  });
</script>

<div class="panel">
  <div class="review-header">
    <h3 class="panel-title" style="margin:0">Аудит GM-действий</h3>
    <div class="review-actions">
      <button data-testid="audit-refresh" onclick={() => void refresh()} disabled={loading}>{loading ? 'Загрузка…' : 'Обновить'}</button>
    </div>
  </div>
  {#if entries === null}
    <div class="faint">Загрузка…</div>
  {:else if entries.length === 0}
    <div class="faint" data-testid="audit-empty">Записей пока нет.</div>
  {:else}
    <table class="gm-table" data-testid="audit-table">
      <thead><tr><th>#</th><th>действие</th><th>GM</th><th>время</th><th>meta</th></tr></thead>
      <tbody>
        {#each entries as entry (entry.auditId)}
          <tr>
            <td>{entry.auditId}</td>
            <td class="mono">{entry.action}</td>
            <td class="mono">{shortId(entry.gmPlayerId)}</td>
            <td>{fmtDateTime(entry.at)}</td>
            <td><pre class="journal-payload">{fmtJson(entry.meta)}</pre></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
