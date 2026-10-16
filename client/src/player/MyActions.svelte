<script lang="ts">
  /**
   * MyActions (SPEC §4): свои действия текущего хода с sequenceId.
   * Серверная часть — turn.myActions (TURN_UPDATE); локальная — оптимистичные
   * submittedActions (PENDING/ACKED/FAILED). ACKED дедуплицируется по actionId
   * с серверным списком; FAILED — откат с кодом, clientAction и кнопкой повтора.
   */
  import { turnStore } from '../stores/index.js';
  import { retryAction } from '../app-context.js';
  import { fmtTime } from '../lib/format.js';

  interface Row {
    readonly key: string;
    readonly sequenceId: number | null;
    readonly rawText: string;
    readonly createdAt: string;
    readonly status: 'SERVER' | 'PENDING' | 'ACKED' | 'FAILED';
    readonly requestId: string | null;
    readonly errorCode: string | null;
    readonly errorHint: string | null;
  }

  const rows = $derived.by<Row[]>(() => {
    const turn = $turnStore.turn;
    const server: Row[] = (turn?.myActions ?? []).map((action) => ({
      key: `srv-${action.actionId}`,
      sequenceId: action.sequenceId,
      rawText: action.rawText,
      createdAt: action.createdAt,
      status: 'SERVER',
      requestId: null,
      errorCode: null,
      errorHint: null,
    }));
    const serverActionIds = new Set((turn?.myActions ?? []).map((action) => action.actionId));
    const local: Row[] = Object.values($turnStore.submittedActions)
      .filter((item) => !(item.status === 'ACKED' && item.actionId !== null && serverActionIds.has(item.actionId)))
      .filter((item) => item.turnId === (turn?.turnId ?? item.turnId))
      .map((item) => ({
        key: `loc-${item.requestId}`,
        sequenceId: item.sequenceId,
        rawText: item.rawText,
        createdAt: item.sentAt,
        status: item.status,
        requestId: item.requestId,
        errorCode: item.error?.code ?? null,
        errorHint: item.error?.hint ?? null,
      }));
    return [...server, ...local].sort((a, b) => {
      const sa = a.sequenceId ?? Number.MAX_SAFE_INTEGER;
      const sb = b.sequenceId ?? Number.MAX_SAFE_INTEGER;
      return sa === sb ? a.createdAt.localeCompare(b.createdAt) : sa - sb;
    });
  });
</script>

{#if rows.length > 0}
  <div class="my-actions" data-testid="my-actions">
    {#each rows as row (row.key)}
      <!-- SERVER-строки (TURN_UPDATE после реконнекта) = подтверждённые: ACKED. -->
      <div
        class="my-action {row.status === 'PENDING' ? 'pending' : ''} {row.status === 'FAILED' ? 'failed' : ''}"
        data-action-status={row.status === 'SERVER' ? 'ACKED' : row.status}
      >
        <span class="seq">{row.sequenceId !== null ? `#${row.sequenceId}` : '⏳'}</span>
        <span>
          {row.rawText}
          {#if row.status === 'FAILED'}
            <span class="reason">
              отклонено: {row.errorCode} — {row.errorHint}
              {#if row.requestId !== null}
                <button data-testid="action-retry" onclick={() => row.requestId !== null && retryAction(row.requestId)}>повторить</button>
              {/if}
            </span>
          {/if}
        </span>
        <span class="faint" style="margin-left:auto">{fmtTime(row.createdAt)}</span>
      </div>
    {/each}
  </div>
{/if}
