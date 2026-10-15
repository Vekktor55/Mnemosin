import type {
  CapabilityAvailability,
  ChatMessageView,
  DirectorContext,
  FlagKey,
  Scalar,
  GmAuditEntry,
  GMStateView,
  JournalEntry,
  PlayerId,
  PublicGameStateView,
  Session,
  SessionId,
  SessionView,
  Turn,
  TurnId,
  TurnView,
} from '@mnemosin/contracts';
import type { EventBus, PlayerRepository } from '@mnemosin/core/domain/ports';

/**
 * Зависимости WS-шлюза (промпт 1.11). Как и в HTTP-шлюзе (D227): gateway не
 * импортирует модули и инфраструктуру — сервисы объявлены структурными
 * consumer-side интерфейсами, всё inject'ится из wiring (apps/server).
 * Инвариант 14: транспорт не содержит игровой логики; приватность — только
 * через projections.ts + WS_PRIVACY_POLICY (B-10, патч аудита §8.4).
 */

/** Структурный порт JwtService (gateways/http/auth/jwt.ts) — D252. */
export interface WsJwtVerifier {
  verify(
    token: string,
    expectedType: 'access',
  ): Promise<{ readonly sub: string; readonly sid: string; readonly gm: boolean; readonly iat: number }>;
}

export interface WsSessionOps {
  leaveSession(input: {
    sessionId: SessionId;
    playerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ playerId: PlayerId; replayed: boolean }>;
  getSession(sessionId: SessionId): Promise<Session>;
}

export interface WsTurnActionMeta {
  targetObjectId?: string | null | undefined;
  targetPlayerId?: string | null | undefined;
  intent?: string | null | undefined;
  customLabel?: string | null | undefined;
}

export interface WsTurnOps {
  submitAction(input: {
    turnId: TurnId;
    playerId: PlayerId;
    rawText: string;
    meta?: WsTurnActionMeta | undefined;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ actionId: string; sequenceId: number }>;
  getTurn(turnId: TurnId): Promise<Turn>;
  getTurnView(turnId: TurnId, viewerPlayerId: PlayerId | null): Promise<TurnView>;
}

export interface WsSendMessageOutput {
  messageId: string;
  sequenceId: number;
  replayed: boolean;
}

export interface WsChatOps {
  sendPublicMessage(input: {
    sessionId: SessionId;
    playerId: PlayerId;
    text: string;
    idempotencyKey?: string | undefined;
    traceId?: string | undefined;
  }): Promise<WsSendMessageOutput>;
  sendPrivateMessage(input: {
    sessionId: SessionId;
    fromPlayerId: PlayerId;
    toPlayerId: PlayerId;
    text: string;
    idempotencyKey?: string | undefined;
    traceId?: string | undefined;
  }): Promise<WsSendMessageOutput>;
  /**
   * Лента с учётом видимости вызывающего (listForPlayer: PUBLIC/SYSTEM всем,
   * PRIVATE — адресату и отправителю, GM — ведущему).
   */
  history(input: {
    sessionId: SessionId;
    playerId?: PlayerId | undefined;
    since?: string | undefined;
    limit?: number | undefined;
  }): Promise<ChatMessageView[]>;
  /** D271: построение ChatMessageView для доставки CHAT_MESSAGE_*-событий. */
  getMessage(messageId: string): Promise<ChatMessageView | null>;
}

export interface WsGmOps {
  startSession(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; replayed: boolean }>;
  pauseSession(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ status: string; replayed: boolean }>;
  resumeSession(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ status: string; replayed: boolean }>;
  endSession(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    reason: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ status: string; replayed: boolean }>;
  kickPlayer(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    playerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ replayed: boolean }>;
  moveGroup(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    playerIds: PlayerId[];
    toLocationId: string;
    idempotencyKey?: string | undefined;
    traceId?: string | undefined;
  }): Promise<{ version: number; replayed: boolean }>;
  openTurn(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; number: number; replayed: boolean }>;
  lockTurn(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; replayed: boolean }>;
  unlockTurn(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; replayed: boolean }>;
  sendSystemMessage(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    text: string;
    turnId?: TurnId | null | undefined;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ messageId: string; replayed: boolean }>;
  addNote(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    turnId?: TurnId | null | undefined;
    visibility: string;
    text: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ noteId: string; replayed: boolean }>;
  activateEvent(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    eventId: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<never>;
  inspectState(input: { sessionId: SessionId }): Promise<GMStateView>;
  inspectAIContext(input: { turnId: TurnId }): Promise<DirectorContext>;
  inspectJournal(input: { turnId: TurnId }): Promise<JournalEntry[]>;
  listAudit(input: { sessionId: SessionId; since?: string | undefined; limit?: number }): Promise<GmAuditEntry[]>;
}

export interface WsGmReviewOps {
  approve(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; sessionId: SessionId; version: number; replayed: boolean }>;
  reject(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    reason: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; status: string; replayed: boolean }>;
  retry(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; status: string; createdNewTurn: boolean; replayed: boolean }>;
  editAndApprove(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    editedResolution: unknown;
    baseResolutionHash: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; version: number; replayed: boolean }>;
}

/** story.setFlag — GM_SET_FLAG / GM_SET_NAME_REMEMBERED (D274). */
export interface WsStoryOps {
  setFlag(input: {
    sessionId: SessionId;
    key: FlagKey;
    value: Scalar;
    setBy: 'AI_APPROVED' | 'GM' | 'ENGINE';
    turnId?: TurnId | null | undefined;
    traceId?: string | undefined;
  }): Promise<{ sessionId: SessionId; version: number; changedKeys: string[]; replayed: boolean }>;
}

/** Проекции состояния (K11) — собирает wiring из репозиториев и core/views. */
export interface WsProjectionProvider {
  sessionView(sessionId: SessionId): Promise<SessionView>;
  publicGameState(sessionId: SessionId): Promise<PublicGameStateView>;
  playerGameState(
    sessionId: SessionId,
    playerId: PlayerId,
  ): Promise<{ playerId: PlayerId; version: number; knowledge: unknown[] }>;
}

export interface WsGatewayLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

/** WS-лимиты из config/limits.yaml (v3 §VI.10). */
export interface WsLimits {
  readonly wsAuthTimeoutMs: number;
  readonly wsMaxConnectionsPerIp: number;
  readonly wsMaxConnectionsPerPlayer: number;
  readonly wsMaxPayloadBytes: number;
  readonly heartbeat: { readonly intervalMs: number; readonly idleTimeoutMs: number };
  readonly wsRatePerConnection: {
    readonly ACTION_SUBMIT: number;
    readonly CHAT_PUBLIC: number;
    readonly DEFAULT: number;
  };
  readonly dedupeTtlMs: number;
}

export interface WsGatewayDeps {
  readonly jwt: WsJwtVerifier;
  readonly players: PlayerRepository;
  /** Доменная шина: broadcast.ts подписывается на события (через wiring). */
  readonly bus: EventBus;
  readonly serverVersion: string;
  /** Срез CapabilityRegistry для HELLO и CAPABILITY_CHANGED. */
  readonly getCapabilities: () => CapabilityAvailability[];
  readonly sessions: WsSessionOps;
  readonly turns: WsTurnOps;
  readonly chat: WsChatOps;
  readonly gm: WsGmOps;
  readonly gmReview: WsGmReviewOps;
  readonly story: WsStoryOps;
  readonly projections: WsProjectionProvider;
  readonly limits: WsLimits;
  readonly logger?: WsGatewayLog;
}
