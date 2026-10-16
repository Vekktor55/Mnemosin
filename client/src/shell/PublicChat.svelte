<script lang="ts">
  /**
   * PublicChat (SPEC §4): лента публичных сообщений, optimistic-отправка
   * (статусы delivered/failed), reconcile по CHAT_ACK (requestId → messageId).
   * maxMessageLen = 1000 (config/limits.yaml).
   */
  import { chatStore, sessionStore } from '../stores/index.js';
  import { sendPublicChat, retryChat } from '../app-context.js';
  import { fmtTime } from '../lib/format.js';

  const MAX_LEN = 1000;

  let text = $state('');

  const myPlayerId = $derived($sessionStore.myPlayerId);
  const messages = $derived($chatStore.messages.filter((message) => message.visibility === 'PUBLIC'));
  const pending = $derived($chatStore.pending.filter((item) => item.visibility === 'PUBLIC'));

  function submit(): void {
    const value = text.trim();
    if (value.length === 0 || value.length > MAX_LEN) return;
    sendPublicChat(value);
    text = '';
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="panel chat-panel">
  <h3 class="panel-title">Общий чат</h3>
  <div class="chat-messages" data-testid="public-chat">
    {#each messages as message (message.messageId)}
      <div class="chat-message" data-message-id={message.messageId}>
        <span class="time">{fmtTime(message.createdAt)}</span>
        <span class="author">{message.fromDisplayName ?? 'Гость'}{message.fromPlayerId !== null && message.fromPlayerId === myPlayerId ? ' (вы)' : ''}:</span>
        <span>{message.text}</span>
      </div>
    {/each}
    {#each pending as item (item.requestId)}
      <div class="chat-message pending {item.status === 'FAILED' ? 'failed' : ''}" data-pending-id={item.requestId}>
        <span class="time">{fmtTime(item.sentAt)}</span>
        <span class="author">вы:</span>
        <span>{item.text}</span>
        <span class="chat-status">{item.status === 'SENDING' ? '⏳ отправка…' : '✗ не доставлено'}</span>
        {#if item.status === 'FAILED' && item.error !== null}
          <span class="chat-status error-text">{item.error.code}: {item.error.hint}</span>
          <button onclick={() => retryChat(item.requestId)}>повторить</button>
        {/if}
      </div>
    {/each}
  </div>
  <div class="chat-input">
    <input
      type="text"
      data-testid="public-chat-input"
      placeholder="Сообщение всем…"
      maxlength={MAX_LEN}
      bind:value={text}
      onkeydown={onKeydown}
    />
    <button class="primary" data-testid="public-chat-send" onclick={submit} disabled={text.trim().length === 0}>Отправить</button>
  </div>
</div>
