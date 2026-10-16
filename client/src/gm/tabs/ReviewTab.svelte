<script lang="ts">
  /**
   * Review (промпт 1.12, п.5; A1.8; SPEC §5):
   * - item'ы resolution (сегменты, приватные сообщения, предложенные события,
   *   изменения объектов) с чекбоксами APPROVED/REJECTED и редактированием текста;
   * - diagnostics (provider, attempts, usage, durationMs), softRejects/warnings;
   * - Approve / Edit&Approve / Reject / Retry;
   * - Edit&Approve отправляет baseResolutionHash; при 409 VERSION_CONFLICT
   *   показывает актуальный resolution из meta (stores/handlers.ts) и баннер
   *   «черновик изменён, обновите».
   * GM_COMMIT_TURN — без оптимизма (v3 §VII.8): BUSY до GM_ACTION_ACK.
   */
  import type { ItemStatus, TurnResolution } from '@mnemosin/contracts';

  import { turnStore, sessionStore, uiStore } from '../../stores/index.js';
  import { acknowledgeDraftStale } from '../../stores/turn.js';
  import { gmCommand, retryGmOperation } from '../../app-context.js';
  import { fmtJson, fmtDateTime, shortId } from '../../lib/format.js';

  interface ItemEdit {
    text: string;
    status: ItemStatus;
    editedByGM: boolean;
  }

  interface EditModel {
    segments: ItemEdit[];
    privateMessages: ItemEdit[];
    proposedEvents: ItemEdit[];
    proposedObjectChanges: ItemEdit[];
  }

  let rejectReason = $state('');
  let showReject = $state(false);

  const draft = $derived($turnStore.draft);
  const summary = $derived($turnStore.draftSummary);
  const stale = $derived($turnStore.draftStale);
  const busy = $derived($uiStore.busyGmAction);
  const players = $derived($sessionStore.publicState?.players ?? []);

  /** Локальная копия правок; сбрасывается при смене версии черновика. */
  let edits = $state<EditModel | null>(null);
  let editsKey = $state<string | null>(null);

  $effect(() => {
    const current = draft;
    if (current === null) {
      edits = null;
      editsKey = null;
      return;
    }
    const key = `${current.turnId}:${current.resolutionHash ?? current.createdAt}`;
    if (key !== editsKey) {
      editsKey = key;
      edits = buildEdits(current);
    }
  });

  function buildEdits(resolution: TurnResolution): EditModel {
    const toItem = (item: { text?: string; status: ItemStatus; editedByGM?: boolean }): ItemEdit => ({
      text: item.text ?? '',
      status: item.status,
      editedByGM: item.editedByGM ?? false,
    });
    return {
      segments: resolution.segments.map(toItem),
      privateMessages: resolution.privateMessages.map(toItem),
      proposedEvents: resolution.proposedEvents.map((item) => ({ text: item.rationale, status: item.status, editedByGM: false })),
      proposedObjectChanges: resolution.proposedObjectChanges.map((item) => ({ text: item.rationale, status: item.status, editedByGM: false })),
    };
  }

  function playerName(playerId: string): string {
    return players.find((player) => player.playerId === playerId)?.displayName ?? shortId(playerId);
  }

  function audienceLabel(audience: TurnResolution['segments'][number]['audience']): string {
    switch (audience.kind) {
      case 'ALL':
        return 'всем';
      case 'GM':
        return 'GM';
      case 'PLAYER':
        return `лично: ${playerName(audience.playerId)}`;
      case 'PLAYERS':
        return `лично: ${audience.playerIds.map(playerName).join(', ')}`;
      default:
        return 'неизвестно';
    }
  }

  /** Последняя операция GM данного вида — для индикатора и retry. */
  function lastOp(action: string): { requestId: string; status: string; errorText: string | null } | null {
    const ops = Object.values($turnStore.gmOps)
      .filter((op) => op.action === action)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const op = ops[0];
    if (op === undefined) return null;
    return {
      requestId: op.requestId,
      status: op.status,
      errorText: op.error !== null ? `${op.error.code}: ${op.error.message} — ${op.error.hint}` : null,
    };
  }

  function approve(): void {
    if (draft === null) return;
    gmCommand('GM_COMMIT_TURN', { turnId: draft.turnId }, 'commitTurn');
  }

  function editAndApprove(): void {
    const current = draft;
    const model = edits;
    if (current === null || model === null || current.resolutionHash === null) return;
    const editedResolution = buildEditedResolution(current, model);
    gmCommand(
      'GM_EDIT_APPROVE',
      {
        turnId: current.turnId,
        editedResolution,
        baseResolutionHash: current.resolutionHash,
      },
      'editAndApprove',
    );
  }

  /**
   * Edit&Approve: сервер нормализует ВСЕ присланные item'ы в EDITED
   * (gm-review.editAndApprove), поэтому отклонённые (REJECTED) item'ы клиент
   * просто НЕ включает в editedResolution — GM курирует состав черновика:
   * чего нет в правке, того не применяет commitTurn (apply-resolution берёт
   * только APPROVED/EDITED). Так «REJECTED» получает наблюдаемый смысл:
   * отклонённый сегмент не попадает в нарратив, отклонённое изменение объекта
   * не меняет состояние (промпт 1.13, п.1).
   */
  function buildEditedResolution(resolution: TurnResolution, model: EditModel): Record<string, unknown> {
    return {
      ...resolution,
      source: 'AI_THEN_GM_EDIT',
      segments: resolution.segments
        .map((segment, index) => {
          const edit = model.segments[index];
          if (edit === undefined || edit.status === 'REJECTED') return null;
          return {
            ...segment,
            text: edit.text,
            status: edit.status,
            editedByGM: edit.editedByGM || segment.text !== edit.text,
          };
        })
        .filter((segment): segment is NonNullable<typeof segment> => segment !== null),
      privateMessages: resolution.privateMessages
        .map((message, index) => {
          const edit = model.privateMessages[index];
          if (edit === undefined || edit.status === 'REJECTED') return null;
          return {
            ...message,
            text: edit.text,
            status: edit.status,
            editedByGM: edit.editedByGM || message.text !== edit.text,
          };
        })
        .filter((message): message is NonNullable<typeof message> => message !== null),
      proposedEvents: resolution.proposedEvents.filter((_, index) => model.proposedEvents[index]?.status !== 'REJECTED'),
      proposedObjectChanges: resolution.proposedObjectChanges.filter(
        (_, index) => model.proposedObjectChanges[index]?.status !== 'REJECTED',
      ),
      editedAt: new Date().toISOString(),
    };
  }

  function reject(): void {
    if (draft === null || rejectReason.trim().length === 0) return;
    gmCommand('GM_REJECT_TURN', { turnId: draft.turnId, reason: rejectReason.trim() }, 'rejectTurn');
    showReject = false;
    rejectReason = '';
  }

  function retryAi(): void {
    if (draft === null) return;
    gmCommand('GM_RETRY_AI', { turnId: draft.turnId }, 'retryAi');
  }

  function retryAiTurn(turnId: string): void {
    gmCommand('GM_RETRY_AI', { turnId }, 'retryAi');
  }

  /**
   * Ход в FAILED без черновика (провайдер деградировал, reconcileOnBoot):
   * GM видит ошибку и Retry прямо в Review (промпт 1.13, п.3).
   */
  const failedTurn = $derived.by(() => {
    const failed = $turnStore.failed;
    if (failed !== null) return failed;
    const turn = $turnStore.turn;
    if (turn !== null && turn.failed !== null) {
      return { turnId: turn.turnId, errorCode: turn.failed.code, message: turn.failed.message };
    }
    return null;
  });
</script>

{#if stale}
  <div class="stale-banner" data-testid="stale-banner">
    <span>Черновик изменён после начала редактирования — панель обновлена актуальной версией из meta. Повторите правку.</span>
    <button data-testid="stale-ack" onclick={() => acknowledgeDraftStale()}>Понятно</button>
  </div>
{/if}

{#if draft === null}
  <div class="panel">
    <h3 class="panel-title">Ревью черновика</h3>
    {#if failedTurn !== null}
      <div class="stale-banner" style="border-color: var(--mn-danger); color: var(--mn-danger)" data-testid="turn-failed-card">
        <span>
          Ход провален: <strong>{failedTurn.errorCode}</strong> — {failedTurn.message}
        </span>
        <button data-testid="gm-retry-ai" onclick={() => retryAiTurn(failedTurn.turnId)} disabled={busy !== null}>
          {busy === 'retryAi' ? '…' : 'Retry AI'}
        </button>
      </div>
    {/if}
    {#if summary !== null}
      <p class="dim" data-testid="draft-summary">
        Черновик {shortId(summary.turnId)}: source={summary.source}, item'ов APPROVED/PROPOSED/REJECTED =
        {summary.counts['APPROVED'] ?? 0}/{summary.counts['PROPOSED'] ?? 0}/{summary.counts['REJECTED'] ?? 0},
        requiresGM={String(summary.requiresGM)}, provider={summary.providerId}
      </p>
    {:else}
      <p class="faint" data-testid="no-draft">Черновик появится, когда ход дойдёт до REVIEW (LOCK → AI-Директор → TURN_DRAFT_READY).</p>
    {/if}
  </div>
{:else if edits !== null}
  {@const diagnostics = draft.diagnostics}
  <div class="panel">
    <div class="review-header">
      <h3 class="panel-title" style="margin:0">Ревью · ход {shortId(draft.turnId)}</h3>
      <span class="badge {diagnostics.requiresGM ? 'warn' : 'ok'}">{diagnostics.requiresGM ? 'requiresGM' : 'авто-приемлемо'}</span>
      <span class="badge">{draft.source}</span>
      {#if draft.resolutionHash !== null}<span class="faint mono">hash {draft.resolutionHash.slice(0, 8)}…</span>{/if}
      <span class="faint">{fmtDateTime(draft.createdAt)}</span>
      <div class="review-actions">
        <button class="primary" data-testid="gm-approve" onclick={approve} disabled={busy !== null}>
          {busy === 'commitTurn' ? 'Коммит…' : 'Approve'}
        </button>
        <button data-testid="gm-edit-approve" onclick={editAndApprove} disabled={busy !== null || draft.resolutionHash === null} title={draft.resolutionHash === null ? 'resolutionHash отсутствует — Edit&Approve недоступен' : ''}>
          {busy === 'editAndApprove' ? 'Отправка…' : 'Edit & Approve'}
        </button>
        <button data-testid="gm-retry-ai" onclick={retryAi} disabled={busy !== null}>
          {busy === 'retryAi' ? '…' : 'Retry AI'}
        </button>
        <button class="danger" data-testid="gm-reject" onclick={() => (showReject = !showReject)} disabled={busy !== null}>Reject…</button>
      </div>
    </div>

    {#if showReject}
      <div class="form-row" style="margin-top:8px">
        <input data-testid="reject-reason" type="text" maxlength="1000" placeholder="причина отклонения (увидят игроки)" bind:value={rejectReason} />
        <button class="danger" data-testid="reject-confirm" onclick={reject} disabled={rejectReason.trim().length === 0}>Отклонить ход</button>
      </div>
    {/if}

    {#each ['commitTurn', 'editAndApprove', 'rejectTurn', 'retryAi'] as action (action)}
      {@const op = lastOp(action)}
      {#if op !== null && op.status !== 'BUSY'}
        <div class="form-hint {op.status === 'ERROR' ? 'warn' : ''}" data-testid="op-status-{action}">
          {action}: {op.status === 'OK' ? 'OK' : op.errorText}
          {#if op.status === 'ERROR'}
            <button onclick={() => retryGmOperation(op.requestId)}>повторить (тот же idempotencyKey)</button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="panel">
    <h3 class="panel-title">Diagnostics</h3>
    <div class="diagnostics-grid" data-testid="diagnostics">
      <span class="dg-item"><span class="dg-key">provider</span><span class="dg-value">{diagnostics.providerId}</span></span>
      <span class="dg-item"><span class="dg-key">model</span><span class="dg-value">{diagnostics.model ?? '—'}</span></span>
      <span class="dg-item"><span class="dg-key">attempts</span><span class="dg-value">{diagnostics.attempts}</span></span>
      <span class="dg-item"><span class="dg-key">schemaRepair</span><span class="dg-value">{diagnostics.schemaRepairAttempts}</span></span>
      <span class="dg-item"><span class="dg-key">usage in/out</span><span class="dg-value">{diagnostics.usage !== null ? `${diagnostics.usage.inputTokens}/${diagnostics.usage.outputTokens}` : '—'}</span></span>
      <span class="dg-item"><span class="dg-key">durationMs</span><span class="dg-value">{diagnostics.durationMs ?? '—'}</span></span>
      <span class="dg-item"><span class="dg-key">costUsd</span><span class="dg-value">{diagnostics.costUsd ?? '—'}</span></span>
      <span class="dg-item"><span class="dg-key">violations</span><span class="dg-value">{diagnostics.violations.length}</span></span>
    </div>
    {#if diagnostics.softRejects.length > 0 || diagnostics.warnings.length > 0}
      <div class="rules-list" style="margin-top:6px" data-testid="soft-rejects">
        {#each diagnostics.softRejects as rule, index (index)}
          <div class="rule-fail">softReject: {rule.checkId} — {rule.outcome}{rule.message !== null ? ` — ${rule.message}` : ''}</div>
        {/each}
        {#each diagnostics.warnings as rule, index (index)}
          <div>warning: {rule.checkId} — {rule.outcome}{rule.message !== null ? ` — ${rule.message}` : ''}</div>
        {/each}
      </div>
    {/if}
    {#if diagnostics.violations.length > 0}
      <div class="rules-list" style="margin-top:6px" data-testid="violations">
        {#each diagnostics.violations as violation, index (index)}
          <div class="rule-fail">violation: {violation.kind} — {violation.message}{violation.path !== null ? ` (${violation.path})` : ''}</div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="panel">
    <h3 class="panel-title">Сегменты нарратива ({draft.segments.length})</h3>
    {#each draft.segments as segment, index (segment.segmentId)}
      {@const edit = edits.segments[index]}
      {#if edit !== undefined}
        <div class="review-item {edit.status === 'REJECTED' ? 'rejected' : ''}" data-testid="segment-{index}">
          <div class="review-item-head">
            <span class="badge {segment.audience.kind === 'ALL' ? 'accent' : 'private'}">{audienceLabel(segment.audience)}</span>
            {#if edit.editedByGM || segment.text !== edit.text}<span class="badge warn">правится GM</span>{/if}
            <span class="status-toggle">
              <label class={edit.status === 'APPROVED' || edit.status === 'EDITED' || edit.status === 'APPLIED' ? 'checked-approve' : ''} onclick={() => (edit.status = 'APPROVED')}>
                <input type="radio" name="seg-{index}" checked={edit.status !== 'REJECTED'} tabindex="-1" /> APPROVED
              </label>
              <label class={edit.status === 'REJECTED' ? 'checked-reject' : ''} onclick={() => (edit.status = 'REJECTED')}>
                <input type="radio" name="seg-{index}" checked={edit.status === 'REJECTED'} tabindex="-1" /> REJECTED
              </label>
            </span>
          </div>
          <textarea data-testid="segment-text-{index}" bind:value={edit.text} maxlength="2000"></textarea>
        </div>
      {/if}
    {/each}
  </div>

  <div class="panel">
    <h3 class="panel-title">Приватные сообщения ({draft.privateMessages.length})</h3>
    {#if draft.privateMessages.length === 0}<div class="faint">нет</div>{/if}
    {#each draft.privateMessages as message, index (index)}
      {@const edit = edits.privateMessages[index]}
      {#if edit !== undefined}
        <div class="review-item {edit.status === 'REJECTED' ? 'rejected' : ''}" data-testid="private-{index}">
          <div class="review-item-head">
            <span class="badge private">→ {playerName(message.playerId)}</span>
            <span class="status-toggle">
              <label class={edit.status !== 'REJECTED' ? 'checked-approve' : ''} onclick={() => (edit.status = 'APPROVED')}>
                <input type="radio" name="pm-{index}" checked={edit.status !== 'REJECTED'} tabindex="-1" /> APPROVED
              </label>
              <label class={edit.status === 'REJECTED' ? 'checked-reject' : ''} onclick={() => (edit.status = 'REJECTED')}>
                <input type="radio" name="pm-{index}" checked={edit.status === 'REJECTED'} tabindex="-1" /> REJECTED
              </label>
            </span>
          </div>
          <textarea data-testid="private-text-{index}" bind:value={edit.text} maxlength="1500"></textarea>
        </div>
      {/if}
    {/each}
  </div>

  <div class="panel">
    <h3 class="panel-title">Предложенные события ({draft.proposedEvents.length})</h3>
    {#if draft.proposedEvents.length === 0}<div class="faint">нет</div>{/if}
    {#each draft.proposedEvents as event, index (index)}
      {@const edit = edits.proposedEvents[index]}
      {#if edit !== undefined}
        <div class="review-item {edit.status === 'REJECTED' ? 'rejected' : ''}" data-testid="event-{index}">
          <div class="review-item-head">
            <span class="badge">{shortId(event.eventId)}</span>
            <span class="dim">{event.rationale}</span>
            <span class="status-toggle">
              <label class={edit.status !== 'REJECTED' ? 'checked-approve' : ''} onclick={() => (edit.status = 'APPROVED')}>
                <input type="radio" name="ev-{index}" checked={edit.status !== 'REJECTED'} tabindex="-1" /> APPROVED
              </label>
              <label class={edit.status === 'REJECTED' ? 'checked-reject' : ''} onclick={() => (edit.status = 'REJECTED')}>
                <input type="radio" name="ev-{index}" checked={edit.status === 'REJECTED'} tabindex="-1" /> REJECTED
              </label>
            </span>
          </div>
          <div class="faint">эффектов: {event.effects.length}{event.ruleResults.length > 0 ? ` · rules: ${event.ruleResults.map((r) => `${r.checkId}=${r.outcome}`).join(', ')}` : ''}</div>
        </div>
      {/if}
    {/each}
  </div>

  <div class="panel">
    <h3 class="panel-title">Изменения объектов ({draft.proposedObjectChanges.length})</h3>
    {#if draft.proposedObjectChanges.length === 0}<div class="faint">нет</div>{/if}
    {#each draft.proposedObjectChanges as change, index (index)}
      {@const edit = edits.proposedObjectChanges[index]}
      {#if edit !== undefined}
        <div class="review-item {edit.status === 'REJECTED' ? 'rejected' : ''}" data-testid="object-change-{index}">
          <div class="review-item-head">
            <span class="badge">{shortId(change.objectId)}</span>
            <span class="dim">{change.rationale}</span>
            <span class="status-toggle">
              <label class={edit.status !== 'REJECTED' ? 'checked-approve' : ''} onclick={() => (edit.status = 'APPROVED')}>
                <input type="radio" name="oc-{index}" checked={edit.status !== 'REJECTED'} tabindex="-1" /> APPROVED
              </label>
              <label class={edit.status === 'REJECTED' ? 'checked-reject' : ''} onclick={() => (edit.status = 'REJECTED')}>
                <input type="radio" name="oc-{index}" checked={edit.status === 'REJECTED'} tabindex="-1" /> REJECTED
              </label>
            </span>
          </div>
          <pre class="journal-payload">{fmtJson(change.patch)}</pre>
        </div>
      {/if}
    {/each}
  </div>

  {#if draft.visualScene !== null}
    <div class="panel">
      <h3 class="panel-title">Визуальная сцена (этап 2)</h3>
      <div class="dim">{draft.visualScene.mood} · {draft.visualScene.subjects.join(', ')}</div>
      <div class="faint">{draft.visualScene.style}</div>
    </div>
  {/if}
{/if}
