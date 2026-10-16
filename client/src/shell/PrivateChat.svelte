<script lang="ts">
  /**
   * PrivateChat (SPEC §4): только свои приватные сообщения (сервер шлёт
   * CHAT_PRIVATE адресату TARGETED — чужих здесь не может быть по построению;
   * приватность обеспечивает сервер, клиент «не отображает лишнего»).
   */
  import { chatStore, sessionStore } from '../stores/index.js';
  import { sendPrivateChat, retryChat } from '../app-context.js';
  import { fmtTime } from '../lib/format.js';

  const MAX_LEN = 1000;

  let text = $state('');
  let toPlayerId = $state<string>('');

  const myPlayerId = $derived($sessionStore.myPlayerId);
  const players = $derived(($sessionStore.publicState?.players ?? []).filter((player) => player.playerId !== myPlayerId));

  $effect(() => {
    if (toPlayerId === '' && players.length > 0) {
      const first = players[0];
      if (first !== undefined) toPlayerId = first.playerId;
    }
  });

  const thread = $derived(
    $chatStore.messages.filter(
      (message) =>
        message.visibility === 'PRIVATE' &&
        (message.toPlayerId === toPlayerId || message.fromPlayerId === toPlayerId),
    ),
  );
  const pending = $derived($chatStore.pending.filter((item) => item.visibility === 'PRIVATE' && item.toPlayerId === toPlayerId));

  function nameOf(playerId: string | null): string {
    if (playerId === null) return 'Гость';
    if (playerId === myPlayerId) return 'вы';
    return players.find((player) => player.playerId === playerId)?.displayName ?? 'игрок';
  }

  function submit(): void {
    const value = text.trim();
    if (value.length === 0 || value.length > MAX_LEN || toPlayerId === '') return;
    sendPrivateChat(toPlayerId, value);
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
  <h3 class="panel-title">Приватные сообщения</h3>
  <div class="form-row">
    <label class="dim" for="private-target">Кому:</label>
    <select id="private-target" data-testid="private-target" bind:value={toPlayerId}>
      {#each players as player (player.playerId)}
        <option value={player.playerId}>{player.displayName}{player.isGM ? ' (GM)' : ''}</option>
      {/each}
    </select>
  </div>
  <div class="chat-messages" data-testid="private-chat">
    {#if toPlayerId === ''}
      <div class="faint">Нет других игроков в сессии.</div>
    {/if}
    {#each thread as message (message.messageId)}
      <div class="chat-message private-msg" data-message-id={message.messageId}>
        <span class="time">{fmtTime(message.createdAt)}</span>
        <span class="author">{nameOf(message.fromPlayerId)} → {nameOf(message.toPlayerId)}:</span>
        <span>{message.text}</span>
      </div>
    {/each}
    {#each pending as item (item.requestId)}
      <div class="chat-message pending private-msg {item.status === 'FAILED' ? 'failed' : ''}" data-pending-id={item.requestId}>
        <span class="time">{fmtTime(item.sentAt)}</span>
        <span class="author">вы → {nameOf(item.toPlayerId)}:</span>
        <span>{item.text}</span>
        <span class="chat-status">{item.status === 'SENDING' ? '⏳ отправка…' : '✗ не доставлено'}</span>
        {#if item.status === 'FAILED' && item.error !== null}
          <button onclick={() => retryChat(item.requestId)}>повторить</button>
        {/if}
      </div>
    {/each}
  </div>
  <div class="chat-input">
    <input
      type="text"
      data-testid="private-chat-input"
      placeholder="Только адресату…"
      maxlength={MAX_LEN}
      bind:value={text}
      onkeydown={onKeydown}
      disabled={toPlayerId === ''}
    />
    <button class="primary" data-testid="private-chat-send" onclick={submit} disabled={text.trim().length === 0 || toPlayerId === ''}>Отправить</button>
  </div>
</div>
