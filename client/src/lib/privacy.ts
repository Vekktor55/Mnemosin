/**
 * Приватность на клиенте (промпт 1.12, п.7; D126; SPEC_STAGE1 §10).
 *
 * Правило 1 — рендер текста: весь пользовательский и серверный текст
 * выводится через интерполяции Svelte ({text}) / textContent. innerHTML и
 * {@html} в client/ ЗАПРЕЩЕНЫ (проверяется код-ревью и grep в CI 1.13).
 * escapeHtml оставлен как утилита для редких случаев конкатенации строк,
 * которые затем всё равно попадают в textContent (двойная защита).
 *
 * Правило 2 — токены (D126): память + sessionStorage. localStorage —
 * НИКОГДА; в localStorage живёт только offline-очередь сообщений
 * (mnemosin:pending:<playerId>, net/offline-queue.ts). sessionStorage
 * переживает перезагрузку вкладки, но не «чужие» вкладки и загрузку страниц
 * с других сайтов — токены не покидают браузерную сессию игрока.
 */

/** Экранирование HTML-спецсимволов (защита при конкатенации; рендер — textContent). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Безопасная запись текста в DOM-узел (textContent, никогда innerHTML). */
export function setTextSafe(node: { textContent: string | null }, text: string): void {
  node.textContent = text;
}

// ---------------------------------------------------------------- identity

export type ClientRole = 'player' | 'gm';

/**
 * Идентичность вкладки: кто вошёл и с каким токеном. Хранится ТОЛЬКО в
 * sessionStorage (D126) + в памяти модуля. refreshToken — там же: он нужен
 * для POST /auth/refresh после AUTH_EXPIRED.
 */
export interface ClientIdentity {
  readonly role: ClientRole;
  readonly token: string;
  readonly refreshToken: string | null;
  readonly playerId: string | null;
  readonly sessionId: string | null;
  readonly displayName: string;
  readonly characterName: string | null;
}

const IDENTITY_KEY = 'mnemosin:identity';

let memoryIdentity: ClientIdentity | null = null;

function sessionStorageAvailable(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage !== null;
  } catch {
    return false;
  }
}

export function saveIdentity(identity: ClientIdentity): void {
  memoryIdentity = identity;
  if (sessionStorageAvailable()) {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  }
}

export function loadIdentity(): ClientIdentity | null {
  if (memoryIdentity !== null) return memoryIdentity;
  if (!sessionStorageAvailable()) return null;
  const raw = sessionStorage.getItem(IDENTITY_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClientIdentity>;
    if (typeof parsed.token !== 'string' || typeof parsed.role !== 'string') return null;
    const identity: ClientIdentity = {
      role: parsed.role === 'gm' ? 'gm' : 'player',
      token: parsed.token,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
      playerId: typeof parsed.playerId === 'string' ? parsed.playerId : null,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
      characterName: typeof parsed.characterName === 'string' ? parsed.characterName : null,
    };
    memoryIdentity = identity;
    return identity;
  } catch {
    return null;
  }
}

export function clearIdentity(): void {
  memoryIdentity = null;
  if (sessionStorageAvailable()) {
    sessionStorage.removeItem(IDENTITY_KEY);
  }
}

/**
 * Страховка D126: если токен когда-либо окажется в localStorage (чужой код,
 * отладка) — удаляем и предупреждаем. Вызывается при старте приложения.
 */
export function purgeTokensFromLocalStorage(): void {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return;
    for (const key of [IDENTITY_KEY, 'mnemosin:token', 'mnemosin:refreshToken']) {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        console.warn(`privacy: ключ ${key} удалён из localStorage (D126: токены — только sessionStorage/память)`);
      }
    }
  } catch {
    /* приватный режим браузера — storage недоступен, нечего чистить */
  }
}
