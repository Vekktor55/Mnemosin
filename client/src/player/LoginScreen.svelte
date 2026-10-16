<script lang="ts">
  /**
   * Экран входа игрока (промпт 1.12, п.4): displayName + characterName (D157)
   * → POST /sessions/:id/join → токен в sessionStorage (D126) → WS connect.
   * sessionId — от ведущего (ссылка /player/?session=<id> предзаполняет поле).
   */
  import { api, ApiError } from '../net/http.js';
  import { describeError, type DescribedError } from '../lib/errors.js';
  import { saveIdentity, type ClientIdentity } from '../lib/privacy.js';

  interface Props {
    onLogin: (identity: ClientIdentity) => void;
    initialError?: DescribedError | null;
  }

  let { onLogin, initialError = null }: Props = $props();

  interface JoinResult {
    playerId: string;
    characterId: string;
    token: string;
    refreshToken: string;
  }

  const urlSession = new URLSearchParams(window.location.search).get('session') ?? '';

  let sessionId = $state(urlSession);
  let displayName = $state('');
  let characterName = $state('');
  let busy = $state(false);
  // Начальное значение пропа — осознанная инициализация (не реактивный источник).
  // svelte-ignore state_referenced_locally
  let error = $state<DescribedError | null>(initialError);

  async function submit(): Promise<void> {
    const sid = sessionId.trim();
    const name = displayName.trim();
    const character = characterName.trim().length > 0 ? characterName.trim() : name;
    if (sid.length === 0 || name.length === 0) {
      error = describeError('VALIDATION', 'Укажите код сессии и имя');
      return;
    }
    busy = true;
    error = null;
    try {
      const result = await api<JoinResult>('POST', `/sessions/${encodeURIComponent(sid)}/join`, {
        body: { displayName: name, characterName: character },
      });
      const identity: ClientIdentity = {
        role: 'player',
        token: result.token,
        refreshToken: result.refreshToken,
        playerId: result.playerId,
        sessionId: sid,
        displayName: name,
        characterName: character,
      };
      saveIdentity(identity); // sessionStorage — никогда localStorage (D126)
      onLogin(identity);
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.described
          : describeError('NETWORK', cause instanceof Error ? cause.message : 'неизвестная ошибка');
    } finally {
      busy = false;
    }
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <h1>Мнемосин</h1>
    <div class="subtitle">Вход игрока — код сессии выдаёт ведущий (GM)</div>

    <label for="session-id">Код сессии</label>
    <input id="session-id" data-testid="login-session" type="text" bind:value={sessionId} placeholder="xxxxxxxx-xxxx-…" />

    <label for="display-name">Ваше имя (displayName)</label>
    <input id="display-name" data-testid="login-display-name" type="text" maxlength="60" bind:value={displayName} placeholder="Как к вам обращаться" />

    <label for="character-name">Имя персонажа (characterName)</label>
    <input id="character-name" data-testid="login-character-name" type="text" maxlength="60" bind:value={characterName} placeholder="По умолчанию — ваше имя" />

    <div class="submit-row">
      <button class="primary" data-testid="login-submit" onclick={() => void submit()} disabled={busy}>
        {busy ? 'Подключение…' : 'Войти в игру'}
      </button>
    </div>

    {#if error !== null}
      <div class="login-error" data-testid="login-error">
        <strong>{error.code}</strong>: {error.message}
        <span class="hint">Действие: {error.hint}</span>
      </div>
    {/if}
  </div>
</div>
