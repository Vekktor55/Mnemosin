<script lang="ts">
  /**
   * SystemFeed (SPEC §4): системные сообщения (CHAT_SYSTEM), нарратив после
   * commit (TURN_COMMITTED), приватные результаты хода (TURN_PRIVATE_RESOLUTION,
   * дедупликация по turnId — D269), ошибки с кодом и clientAction из
   * ERROR_TABLE, CAPABILITY_CHANGED, статусы сессии, TURN_FAILED, бюджет (GM).
   *
   * Весь текст рендерится интерполяцией Svelte (textContent) — никогда
   * innerHTML/{@html} (промпт 1.12, п.7; D126).
   */
  import { uiStore, chatStore, type FeedEntry } from '../stores/index.js';
  import { fmtTime } from '../lib/format.js';

  interface MergedEntry {
    readonly id: string;
    readonly at: string;
    readonly kind: FeedEntry['kind'] | 'system-chat';
    readonly text: string | null;
    readonly segments: readonly { readonly segmentId: string; readonly text: string }[] | null;
    readonly error: FeedEntry['error'];
    readonly author: string | null;
  }

  const merged = $derived.by<MergedEntry[]>(() => {
    const fromChat: MergedEntry[] = $chatStore.messages
      .filter((message) => message.visibility === 'SYSTEM')
      .map((message) => ({
        id: message.messageId,
        at: message.createdAt,
        kind: 'system-chat' as const,
        text: message.text,
        segments: null,
        error: null,
        author: message.fromDisplayName,
      }));
    const fromFeed: MergedEntry[] = $uiStore.feed.map((entry) => ({
      id: entry.id,
      at: entry.at,
      kind: entry.kind,
      text: entry.text,
      segments: entry.segments,
      error: entry.error,
      author: null,
    }));
    return [...fromFeed, ...fromChat].sort((a, b) => b.at.localeCompare(a.at));
  });
</script>

<div class="panel" style="flex:1; display:flex; flex-direction:column; min-height:0;">
  <h3 class="panel-title">Лента</h3>
  <div class="system-feed" data-testid="system-feed">
    {#if merged.length === 0}
      <div class="faint">Пока тихо. Системные сообщения и нарратив появятся здесь.</div>
    {/if}
    {#each merged as entry (entry.id)}
      <div class="feed-entry {entry.kind}" data-feed-kind={entry.kind}>
        <span class="feed-time">{fmtTime(entry.at)}</span>
        {#if entry.kind === 'narrative' && entry.segments !== null}
          {#each entry.segments as segment (segment.segmentId)}
            <p>{segment.text}</p>
          {/each}
        {:else if entry.kind === 'private'}
          <span>Вам лично: {entry.text}</span>
        {:else if entry.kind === 'turn-failed' && entry.error !== null}
          <span class="error-code">{entry.error.code}</span>
          <span>{entry.text}</span>
          <span class="error-hint">Действие: {entry.error.hint}</span>
        {:else if entry.kind === 'error' && entry.error !== null}
          <span class="error-code">{entry.error.code}</span>
          <span>{entry.error.message}</span>
          <span class="error-hint">Действие: {entry.error.hint}{entry.error.clientAction !== null ? ` (${entry.error.clientAction})` : ''}</span>
        {:else}
          {#if entry.author !== null}<span class="dim">{entry.author}: </span>{/if}
          <span>{entry.text}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>
