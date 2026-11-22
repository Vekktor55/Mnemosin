/**
 * Централизованные сетевые настройки первого realtime-среза.
 * Все числа PROTOTYPE-ONLY: NET-03…NET-15 не становятся игровыми правилами.
 */
export interface RealtimeNetworkConfig {
  readonly wsAuthTimeoutMs: number;
  readonly wsMaxConnectionsPerIp: number;
  readonly wsMaxConnectionsPerPlayer: number;
  readonly wsMaxPayloadBytes: number;
  readonly heartbeat: { readonly intervalMs: number; readonly idleTimeoutMs: number };
  /** Отдельно от heartbeat: P04 FIXED_DT = 50 ms, backlog догоняется быстрее real-time. */
  readonly schedulerRecoveryIntervalMs: number;
  readonly inputRatePerSecond: number;
  readonly maxBufferedBytes: number;
  readonly maxQueuedMessages: number;
  readonly sceneCoalesceWindowMs: number;
  readonly singleController: boolean;
  readonly replayInputsAfterReconnect: false;
  readonly sameTestRoomVisibility: true;
}

export const PROTOTYPE_REALTIME_NETWORK: RealtimeNetworkConfig = Object.freeze({
  wsAuthTimeoutMs: 5_000,
  wsMaxConnectionsPerIp: 20,
  wsMaxConnectionsPerPlayer: 1, // NET-03: single-controller только для prototype.
  wsMaxPayloadBytes: 16 * 1024,
  heartbeat: Object.freeze({ intervalMs: 10_000, idleTimeoutMs: 30_000 }),
  schedulerRecoveryIntervalMs: 50,
  inputRatePerSecond: 40,
  maxBufferedBytes: 64 * 1024,
  maxQueuedMessages: 64,
  sceneCoalesceWindowMs: 0,
  singleController: true,
  replayInputsAfterReconnect: false,
  sameTestRoomVisibility: true,
});

export function realtimeNetworkConfig(overrides: Partial<RealtimeNetworkConfig> = {}): RealtimeNetworkConfig {
  const result = { ...PROTOTYPE_REALTIME_NETWORK, ...overrides };
  if (result.singleController !== true || result.replayInputsAfterReconnect !== false) {
    throw new Error('P05-A поддерживает только single-controller и запрет replay входов');
  }
  if (result.maxQueuedMessages < 2 || result.maxBufferedBytes < 0 || result.inputRatePerSecond <= 0) {
    throw new Error('Некорректные prototype network limits');
  }
  if (
    !Number.isInteger(result.schedulerRecoveryIntervalMs) ||
    result.schedulerRecoveryIntervalMs <= 0 ||
    result.schedulerRecoveryIntervalMs > 50
  ) {
    throw new Error('Scheduler recovery interval must be in 1..50 ms');
  }
  return Object.freeze(result);
}
