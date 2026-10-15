import type {
  ChatMessageView,
  CharacterId,
  DirectorContext,
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
import type { PlayerRepository } from '@mnemosin/core/domain/ports';

import type { JwtService } from './auth/jwt.js';

/**
 * Зависимости HTTP-шлюза (промпт 1.10). Всё — ИНЪЕКЦИИ из wiring (apps/server):
 * gateway не импортирует модули и инфраструктуру (инвариант 14, правило 1.3 —
 * из монорепо доступны только @mnemosin/contracts и @mnemosin/core/domain/ports).
 * Сервисы модулей объявлены структурными consumer-side интерфейсами (D227).
 */

export interface SessionOps {
  createSession(input: {
    title: string;
    gmDisplayName: string;
    characterName?: string | undefined;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ sessionId: SessionId; gmPlayerId: PlayerId; gmCharacterId: CharacterId; replayed: boolean }>;
  joinSession(input: {
    sessionId: SessionId;
    displayName: string;
    characterName?: string | undefined;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ playerId: PlayerId; characterId: CharacterId; replayed: boolean }>;
  leaveSession(input: {
    sessionId: SessionId;
    playerId: PlayerId;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ playerId: PlayerId; replayed: boolean }>;
  getSession(sessionId: SessionId): Promise<Session>;
}

export interface TurnActionMeta {
  targetObjectId?: string | null | undefined;
  targetPlayerId?: string | null | undefined;
  intent?: string | null | undefined;
  customLabel?: string | null | undefined;
}

export interface TurnOps {
  submitAction(input: {
    turnId: TurnId;
    playerId: PlayerId;
    rawText: string;
    meta?: TurnActionMeta | undefined;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ actionId: string; sequenceId: number }>;
  getTurn(turnId: TurnId): Promise<Turn>;
  getTurnView(turnId: TurnId, viewerPlayerId: PlayerId | null): Promise<TurnView>;
}

export interface ChatOps {
  history(input: {
    sessionId: SessionId;
    playerId?: PlayerId | undefined;
    since?: string | undefined;
    visibility?: string | undefined;
    limit?: number | undefined;
  }): Promise<ChatMessageView[]>;
}

export interface GmOps {
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
  cancelTurn(input: {
    turnId: TurnId;
    gmPlayerId: PlayerId;
    reason: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ turnId: TurnId; replayed: boolean }>;
  addNote(input: {
    sessionId: SessionId;
    gmPlayerId: PlayerId;
    turnId?: TurnId | null | undefined;
    visibility: string;
    text: string;
    idempotencyKey: string;
    traceId?: string | undefined;
  }): Promise<{ noteId: string; replayed: boolean }>;
  inspectState(input: { sessionId: SessionId }): Promise<GMStateView>;
  inspectAIContext(input: { turnId: TurnId }): Promise<DirectorContext>;
  inspectJournal(input: { turnId: TurnId }): Promise<JournalEntry[]>;
  listAudit(input: { sessionId: SessionId; since?: string | undefined; limit?: number }): Promise<GmAuditEntry[]>;
}

export interface GmReviewOps {
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

/** Проекции (K11): собирает wiring (apps/server) из репозиториев и core/views. */
export interface ProjectionProvider {
  sessionView(sessionId: SessionId): Promise<SessionView>;
  publicGameState(sessionId: SessionId): Promise<PublicGameStateView>;
  playerGameState(
    sessionId: SessionId,
    playerId: PlayerId,
  ): Promise<{ playerId: PlayerId; version: number; knowledge: unknown[] }>;
}

export interface GatewayLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface HttpGatewayDeps {
  readonly jwt: JwtService;
  readonly players: PlayerRepository;
  readonly isProduction: boolean;
  readonly sessions: SessionOps;
  readonly turns: TurnOps;
  readonly chat: ChatOps;
  readonly gm: GmOps;
  readonly gmReview: GmReviewOps;
  readonly projections: ProjectionProvider;
  /** GET /metrics: текстовый срез метрик (в dev открыт, в prod — loopback, D146). */
  readonly getMetricsText: () => string;
  /** Каталог media-файлов (этап 2 наполняет); /media/files/* — auth player. */
  readonly mediaDir: string;
  readonly limits: {
    readonly authPerIpPerMin: number;
    readonly tokenPerMinute: number;
    readonly mutatingTurnPerMinute: number;
  };
  readonly logger?: GatewayLog;
}
