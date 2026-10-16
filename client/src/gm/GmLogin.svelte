<script lang="ts">
  /**
   * Экран входа GM (промпт 1.12, п.5): «создать сессию» (POST /auth/session —
   * D122: создаёт сессию И GM-игрока, выдаёт оба токена) или «войти по токену»
   * (существующая сессия; sessionId придёт в AUTH_OK). Токен — только
   * sessionStorage/память (D126).
   */
  import { api, ApiError } from '../net/http.js';
  import { describeError, type DescribedError } from '../lib/errors.js';
  import { saveIdentity, type ClientIdentity } from '../lib/privacy.js';

  interface Props {
    onLogin: (identity: ClientIdentity) => void;
    initialError?: DescribedError | null;
  }

  let { onLogin, initialError = null }: Props = $props();

  interface CreateSessionResult {
    sessionId: string;
    playerId: string;
    token: string;
    refreshToken: string;
  }

  let mode = $state<'create' | 'token'>('create');
  let displayName = $state('Ведущий');
  let characterName = $state('Архивариус');
  let title = $state('Партия МНЕМОСИН');
  let tokenInput = $state('');
  let busy = $state(false);
  // Начальное значение пропа — осознанная инициализация (не реактивный источник).
  // svelte-ignore state_referenced_locally
  let error = $state<DescribedError | null>(initialError);

  async function createSession(): Promise<void> {
    busy = true;
    error = null;
    try {
      const result = await api<CreateSessionResult>('POST', '/auth/session', {
        body: {
          displayName: displayName.trim(),
          characterName: characterName.trim().length > 0 ? characterName.trim() : displayName.trim(),
          ...(title.trim().length > 0 ? { title: title.trim() } : {}),
        },
      });
      const identity: ClientIdentity = {
        role: 'gm',
        token: result.token,
        refreshToken: result.refreshToken,
        playerId: result.playerId,
        sessionId: result.sessionId,
        displayName: displayName.trim(),
        characterName: characterName.trim(),
      };
      saveIdentity(identity);
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

  function loginByToken(): void {
    const token = tokenInput.trim();
    if (token.length < 16) {
      error = describeError('VALIDATION', 'Вставьте access-токен GM (выдан при создании сессии)');
      return;
    }
    error = null;
    const identity: ClientIdentity = {
      role: 'gm',
      token,
      refreshToken: null,
      playerId: null,
      sessionId: null, // придёт в AUTH_OK (F-10.6)
      displayName: 'Ведущий',
      characterName: null,
    };
    saveIdentity(identity);
    onLogin(identity);
  }
</script>

<div class="gm-login">
  <div class="login-card">
    <h1>Мнемосин · GM</h1>
    <div class="subtitle">Пульт ведущего — создание партии и ревью хода</div>

    <div class="mode-switch">
      <button class={mode === 'create' ? 'active' : ''} data-testid="mode-create" onclick={() => (mode = 'create')}>Создать сессию</button>
      <button class={mode === 'token' ? 'active' : ''} data-testid="mode-token" onclick={() => (mode = 'token')}>Войти по токену</button>
    </div>

    {#if mode === 'create'}
      <label for="gm-display-name">Имя ведущего (displayName)</label>
      <input id="gm-display-name" data-testid="gm-display-name" type="text" maxlength="60" bind:value={displayName} />

      <label for="gm-character-name">Имя персонажа GM</label>
      <input id="gm-character-name" data-testid="gm-character-name" type="text" maxlength="60" bind:value={characterName} />

      <label for="gm-title">Название партии</label>
      <input id="gm-title" data-testid="gm-title" type="text" maxlength="120" bind:value={title} />

      <div class="submit-row">
        <button class="primary" data-testid="gm-create-submit" onclick={() => void createSession()} disabled={busy || displayName.trim().length === 0}>
          {busy ? 'Создание…' : 'Создать сессию и войти'}
        </button>
      </div>
    {:else}
      <label for="gm-token">Access-токен GM</label>
      <input id="gm-token" data-testid="gm-token" type="password" bind:value={tokenInput} placeholder="eyJhbGci…" />
      <div class="submit-row">
        <button class="primary" data-testid="gm-token-submit" onclick={loginByToken} disabled={tokenInput.trim().length < 16}>Подключиться</button>
      </div>
    {/if}

    {#if error !== null}
      <div class="login-error" data-testid="login-error">
        <strong>{error.code}</strong>: {error.message}
        <span class="hint">Действие: {error.hint}</span>
      </div>
    {/if}
  </div>
</div>
