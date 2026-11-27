import type {
  EventId,
  HotGameplayEventEnvelope,
  HotSnapshot,
  MatchId,
  SessionId,
  SimulationTick,
} from '@mnemosin/contracts';
import type { SnapshotRepository } from '../domain/ports/index.js';
import type { JournalService } from '../turns/index.js';
import type { ColdGameplayEventProcessor } from './gameplay-event-processor.js';
import type { SnapshotRecoveryOrchestrator } from './snapshot-recovery.js';
import { PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT } from './snapshot-recovery.js';

export interface CrashWindow {
  readonly afterEventCreated: boolean;
  readonly afterColdCommit: boolean;
  readonly afterAckSent: boolean;
  readonly afterSnapshotWritten: boolean;
}

export interface CrashSimulationResult {
  readonly window: CrashWindow;
  readonly recoveredSnapshot: HotSnapshot | null;
  /**
   * Число событий, ПРЕДЪЯВЛЕННЫХ идемпотентному processor в ходе recovery.
   *
   * В success-ветке это точное число обработанных событий (commit + replay).
   * В failure-ветке recovery упал до подтверждения результата, поэтому факт
   * предъявления событий процессору неизвестен — значение отражает durable-
   * состояние COLD на момент измерения, а не число вызовов processor'а.
   */
  readonly replayedEvents: number;
  /** Число событий, получивших НОВЫЙ durable-эффект (commit) в COLD. */
  readonly committedEvents: number;
  /** Число событий, которые были durable УЖЕ (повтор не создал эффекта). */
  readonly deduplicatedEvents: number;
  readonly pendingEventsBeforeCrash: number;
  readonly pendingEventsAfterRecovery: number;
  readonly committedBeforeCrash: number;
  readonly acknowledgedBeforeCrash: number;
  readonly lostTransientEventIds: readonly EventId[];
  readonly transientStateRollback: boolean;
  /**
   * Число HOT-тиков, откатываемых при восстановлении: разница между тиком
   * падения и recovery point снапшота.
   */
  readonly transientTicksLost: number;
  /**
   * Откуда взят тик падения:
   *  - `explicit-crash-tick` — задан явно через `recordCrashTick()` (точный тик падения);
   *  - `last-durable-event-tick` — оценка по тику последнего durable-события;
   *  - `no-snapshot` — снапшота нет, окно отката не измеряется.
   */
  readonly transientTicksLostSource: 'explicit-crash-tick' | 'last-durable-event-tick' | 'no-snapshot';
  readonly recoveryOrder: readonly string[];
  readonly recoveryError: string | null;
}

export interface CrashRestartHarnessDeps {
  /** Processor «старого» процесса; выполняет pre-crash commit. */
  readonly processor: ColdGameplayEventProcessor;
  /** Recovery с НОВЫМ processor над той же БД — моделирует restart. */
  readonly recovery: SnapshotRecoveryOrchestrator;
  readonly snapshotRepo?: SnapshotRepository;
  /**
   * Durable-журнал той же сессии. ОБЯЗАТЕЛЕН: без него при ошибке recovery
   * невозможно отличить уже зафиксированное в COLD событие от потерянного,
   * и измерение окна потерь было бы ложным. Поэтому harness не принимает
   * конфигурацию без журнала.
   */
  readonly journal: JournalService;
}

/**
 * Fault-injection harness, а НЕ production durability guarantee (HC-06…HC-10).
 *
 * (a) afterEventCreated && !afterColdCommit: событие существует только в
 *     test-only recovery log и передаётся recovery как pending;
 * (b) afterColdCommit && !afterAckSent: старый processor реально коммитит,
 *     но harness не считает ACK доставленным; новый processor делает replay;
 * (c) afterSnapshotWritten: snapshot сохраняется до последующих событий,
 *     transientTicksLost показывает измеренную границу отката HOT по
 *     наблюдаемым durable событиям (не «тик падения» — он неизвестен).
 *
 * При ошибке recovery уже зафиксированные в COLD события не считаются
 * потерянными: прогресс читается из durable journal, который поэтому
 * обязателен. В failure-ветке счётчики означают текущее durable-состояние
 * («сколько событий зафиксировано сейчас» / «из них — уже было durable до
 * падения»), а не результат конкретного processor-вызова.
 */
export class CrashRestartHarness {
  private readonly processor: ColdGameplayEventProcessor;
  private readonly recovery: SnapshotRecoveryOrchestrator;
  private readonly snapshotRepo: SnapshotRepository | undefined;
  private readonly journal: JournalService;
  private events: HotGameplayEventEnvelope[] = [];
  private snapshots: HotSnapshot[] = [];
  private coldCommits = 0;
  /**
   * PROTOTYPE-ONLY: тик HOT, на котором моделируется падение процесса.
   * Если не задан — используется тик последнего durable события (оценка).
   */
  private crashTick: SimulationTick | null = null;

  constructor(deps: CrashRestartHarnessDeps) {
    this.processor = deps.processor;
    this.recovery = deps.recovery;
    this.snapshotRepo = deps.snapshotRepo;
    this.journal = deps.journal;
  }

  /** Явно задать тик падения — точная точка отката transient HOT state. */
  recordCrashTick(tick: SimulationTick): void {
    this.crashTick = tick;
  }

  recordEventCreated(event: HotGameplayEventEnvelope): void {
    this.events.push(event);
  }

  recordSnapshotWritten(snapshot: HotSnapshot): void {
    this.snapshots.push(snapshot);
  }

  async simulateCrashAndRestart(
    sessionId: SessionId,
    matchId: MatchId,
    window: CrashWindow,
  ): Promise<CrashSimulationResult> {
    validateWindow(window);
    const events = window.afterEventCreated ? [...this.events] : [];
    const snapshot = window.afterSnapshotWritten ? (this.snapshots[this.snapshots.length - 1] ?? null) : null;
    if (window.afterSnapshotWritten && snapshot === null) {
      throw new Error('Crash harness: afterSnapshotWritten requires recordSnapshotWritten()');
    }
    if (snapshot !== null && this.snapshotRepo !== undefined) {
      const existing = await this.snapshotRepo.findById(snapshot.id);
      if (existing === null) await this.snapshotRepo.insert(snapshot);
    }

    let committedBeforeCrash = 0;
    const committedBeforeCrashIds = new Set<EventId>();
    if (window.afterColdCommit) {
      for (const event of events) {
        await this.processor.process({ event, sessionId });
        committedBeforeCrash += 1;
        committedBeforeCrashIds.add(event.eventId);
        this.coldCommits += 1;
      }
    }
    const acknowledgedBeforeCrash = window.afterAckSent ? committedBeforeCrash : 0;
    const transientPending = window.afterColdCommit ? [] : events;
    const pendingEventsBeforeCrash = transientPending.length;

    // Crash: вся RAM-очередь harness теряется; recovery получает только явный test log.
    // Тик падения захватывается ДО сброса — иначе метрика отката его потеряла бы.
    const crashTick = this.crashTick;
    this.events = [];
    this.snapshots = [];
    this.crashTick = null;

    if (snapshot === null) {
      return {
        window,
        recoveredSnapshot: null,
        replayedEvents: 0,
        committedEvents: 0,
        deduplicatedEvents: 0,
        pendingEventsBeforeCrash,
        pendingEventsAfterRecovery: pendingEventsBeforeCrash,
        committedBeforeCrash,
        acknowledgedBeforeCrash,
        lostTransientEventIds: transientPending.map((event) => event.eventId),
        transientStateRollback: false,
        transientTicksLost: 0,
        transientTicksLostSource: 'no-snapshot',
        recoveryOrder: ['crash:no-snapshot'],
        recoveryError: null,
      };
    }

    try {
      const recovered = await this.recovery.recover({
        sessionId,
        matchId,
        targetSnapshot: snapshot.id,
        pendingEvents: transientPending,
      });
      const rollback = this.measureTransientTicksLost(snapshot, events, crashTick);
      return {
        window,
        recoveredSnapshot: recovered.recoveredSnapshot,
        replayedEvents: recovered.replayedEvents,
        committedEvents: recovered.committedEvents,
        deduplicatedEvents: recovered.deduplicatedEvents,
        pendingEventsBeforeCrash,
        pendingEventsAfterRecovery: 0,
        committedBeforeCrash,
        acknowledgedBeforeCrash,
        lostTransientEventIds: [],
        transientStateRollback: rollback.ticks > 0,
        transientTicksLost: rollback.ticks,
        transientTicksLostSource: rollback.source,
        recoveryOrder: recovered.recoveryOrder,
        recoveryError: null,
      };
    } catch (error) {
      // Recovery упал: часть pending-событий могла уже зафиксироваться в COLD.
      // Не обнуляем прогресс и не помечаем потерянными уже сохранённые события.
      const durable = await this.readDurableEventIds(sessionId, transientPending);
      const lost = transientPending.filter((event) => !durable.has(event.eventId));
      const rollback = this.measureTransientTicksLost(snapshot, events, crashTick);
      // Семантика failure-ветки: recovery не вернул свои счётчики и упал до
      // подтверждения результата, поэтому committedEvents/deduplicatedEvents
      // означают «события сейчас durable в COLD» и «события durable и до падения»,
      // а не число вызовов processor'а. Разделение по «до падения» делается
      // по фактическому pre-crash commit, а не по накопительному счётчику.
      const durableBeforeCrash = [...durable].filter((eventId) => committedBeforeCrashIds.has(eventId)).length;
      return {
        window,
        recoveredSnapshot: snapshot,
        replayedEvents: durable.size,
        committedEvents: Math.max(0, durable.size - durableBeforeCrash),
        deduplicatedEvents: Math.min(durable.size, durableBeforeCrash),
        pendingEventsBeforeCrash,
        pendingEventsAfterRecovery: lost.length,
        committedBeforeCrash,
        acknowledgedBeforeCrash,
        lostTransientEventIds: lost.map((event) => event.eventId),
        transientStateRollback: rollback.ticks > 0,
        transientTicksLost: rollback.ticks,
        transientTicksLostSource: rollback.source,
        recoveryOrder: ['recovery:failed'],
        recoveryError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Измеренный rollback transient HOT state = число тиков между recovery point
   * снапшота и тиком падения.
   *
   * Точный тик падения задаётся через `recordCrashTick()`. Если он не задан,
   * используется тик последнего durable события — это консервативная ОЦЕНКА
   * (источник указан в `transientTicksLostSource`), а не точный тик падения.
   * HC-08 остаётся открытым: production-гарантия отката не заявляется.
   */
  private measureTransientTicksLost(
    snapshot: HotSnapshot,
    observedEvents: readonly HotGameplayEventEnvelope[],
    crashTick: SimulationTick | null,
  ): { readonly ticks: number; readonly source: 'explicit-crash-tick' | 'last-durable-event-tick' } {
    const snapshotTick = Number(snapshot.recoveryPoint.simulationTick);
    if (crashTick !== null) {
      return { ticks: Math.max(0, Number(crashTick) - snapshotTick), source: 'explicit-crash-tick' };
    }
    const lastEventTick = observedEvents.reduce<number>(
      (maximum, event) => Math.max(maximum, Number(event.simulationTick)),
      snapshotTick,
    );
    return { ticks: Math.max(0, lastEventTick - snapshotTick), source: 'last-durable-event-tick' };
  }

  /**
   * EventId событий, уже зафиксированных в durable journal этой сессии.
   *
   * Переполнение журнального окна — fail-closed: молча усечённое окно могло бы
   * скрыть durable-событие и завысить измерение потерь (HC-07).
   */
  private async readDurableEventIds(
    sessionId: SessionId,
    candidates: readonly HotGameplayEventEnvelope[],
  ): Promise<Set<EventId>> {
    const journal = this.journal;
    if (candidates.length === 0) return new Set<EventId>();
    const entries = await journal.listBySession(sessionId, PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT + 1);
    if (entries.length > PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT) {
      throw new Error(
        `Crash harness: durable journal scan window exceeded (${PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT}); the loss window cannot be measured reliably`,
      );
    }
    const durable = new Set<EventId>();
    for (const entry of entries) {
      if (entry.kind !== 'hot_gameplay_committed') continue;
      const payload = entry.payload as { readonly event?: { readonly eventId?: unknown } };
      const eventId = payload.event?.eventId;
      if (typeof eventId === 'string') durable.add(eventId as EventId);
    }
    return new Set(candidates.filter((event) => durable.has(event.eventId)).map((event) => event.eventId));
  }

  getDiagnostics(): {
    readonly eventsCreated: number;
    readonly coldCommits: number;
    readonly snapshotsWritten: number;
  } {
    return {
      eventsCreated: this.events.length,
      coldCommits: this.coldCommits,
      snapshotsWritten: this.snapshots.length,
    };
  }
}

function validateWindow(window: CrashWindow): void {
  if (window.afterColdCommit && !window.afterEventCreated) {
    throw new Error('Crash harness: commit requires event creation');
  }
  if (window.afterAckSent && !window.afterColdCommit) {
    throw new Error('Crash harness: ACK requires COLD commit');
  }
}
