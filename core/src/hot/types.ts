import type {
  InputSequence,
  InputStreamId,
  MovementInput,
  ParticipantId,
  SceneInputAckMessage,
  SceneInputMessage,
  SimulationTick,
  WorldPosition,
} from '@mnemosin/contracts';

/** Все численные значения здесь — PROTOTYPE-ONLY, а не игровой баланс. */
export interface HotRuntimeConfig {
  readonly movementSpeedCellsPerSecond: number;
  readonly entityRadius: number;
  readonly collisionEpsilon: number;
  /** Число логических тиков без свежего input до автоматической остановки. */
  readonly inputLeaseTicks: number;
}

export interface HotPlayerState {
  readonly participantId: ParticipantId;
  readonly position: WorldPosition;
  readonly direction: MovementInput;
  /** Фактическое перемещение за последний завершённый тик, делённое на FIXED_DT. */
  readonly velocity: WorldPosition;
  readonly activeInputStreamId: InputStreamId | null;
  readonly lastProcessedInputSequence: InputSequence | null;
  readonly lastInputTick: SimulationTick | null;
}

export interface HotSimulationState {
  readonly simulationTick: SimulationTick;
  /** Всегда отсортировано по participantId для стабильного порядка сущностей. */
  readonly players: readonly HotPlayerState[];
}

export interface HotQueuedInput {
  readonly arrivalSequence: number;
  readonly participantId: ParticipantId;
  readonly message: SceneInputMessage;
}

export interface HotStepResult {
  readonly state: HotSimulationState;
  /** Один cumulative ACK на игрока за тик, в стабильном порядке игроков. */
  readonly acknowledgements: readonly SceneInputAckMessage[];
}

export interface HotTickDiagnostics {
  readonly simulationTick: SimulationTick;
  readonly durationMs: number;
  readonly overrun: boolean;
  readonly coldRevisionsApplied: number;
  readonly awaitingColdRevision: number | null;
}

export interface HotTickResult {
  readonly acknowledgements: readonly SceneInputAckMessage[];
  readonly diagnostics: HotTickDiagnostics;
}

export type HotInputRejectionReason = 'invalid_message' | 'unknown_player' | 'inactive_stream' | 'stale_sequence';

export type HotInputReceipt =
  | { readonly accepted: true; readonly arrivalSequence: number }
  | { readonly accepted: false; readonly reason: HotInputRejectionReason };
