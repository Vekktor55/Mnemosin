import type { ColdToHotCommand, CommandId, FlagKey, Scalar, SessionId, StateMutation } from '@mnemosin/contracts';
import type { UnitOfWork } from '../domain/ports/index.js';
import type { StateService } from '../state/index.js';

export class ColdCommandProcessor {
  private readonly uow: UnitOfWork;
  private readonly state: StateService;
  private readonly appliedCommands = new Map<string, { revision: number; commandId: CommandId }>();

  constructor(deps: { readonly uow: UnitOfWork; readonly state: StateService }) {
    this.uow = deps.uow;
    this.state = deps.state;
  }

  async process(input: { readonly command: ColdToHotCommand; readonly sessionId: string }): Promise<{
    readonly applied: boolean;
    readonly revision: number;
  }> {
    const { command, sessionId } = input;

    const existing = this.appliedCommands.get(command.commandId);
    if (existing !== undefined) {
      return { applied: false, revision: existing.revision };
    }

    await this.uow.runInTx(async (scope) => {
      const mutations = this.toStateMutations(command);
      const currentState = await scope.repos.state.findBySession(sessionId as SessionId);
      await this.state.apply({
        sessionId: sessionId as SessionId,
        mutations,
        expectedVersion: currentState?.version ?? 0,
        turnId: null,
        traceId: `cold-cmd-${command.commandId}`,
        scope,
      });
    });

    this.appliedCommands.set(command.commandId, { revision: command.revision, commandId: command.commandId });
    return { applied: true, revision: command.revision };
  }

  private toStateMutations(command: ColdToHotCommand): StateMutation[] {
    const payload = command.payload as { key: string; value: Scalar };
    return [
      { kind: 'SET_FLAG', key: `prototype.runtime.${payload.key}` as FlagKey, value: payload.value, setBy: 'ENGINE' },
    ];
  }

  getAppliedRevision(commandId: CommandId): number | null {
    const record = this.appliedCommands.get(commandId);
    return record?.revision ?? null;
  }
}
