import { describe, expect, it } from 'vitest';

import { type ColdToHotCommand } from '@mnemosin/contracts';
import { HotColdRevisionBoundary } from '@mnemosin/core';

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const matchId = uuid(1);
const worldEpoch = 1;

function makeCommand(revision: number, eventId: string = uuid(10)): ColdToHotCommand {
  return {
    schemaVersion: 1,
    commandId: uuid(20),
    matchId,
    revision,
    worldEpoch,
    issuedAtEventId: eventId,
    type: 'prototype.runtime.fact',
    target: { participantId: uuid(2) },
    payload: { key: 'probe', value: true },
  };
}

describe('P06 COLD → HOT revision ordering', () => {
  it('applies strictly monotonic revision on tick boundary', () => {
    const boundary = new HotColdRevisionBoundary({ matchId, worldEpoch, coldRevision: 0 });

    boundary.receive(makeCommand(1));
    boundary.receive(makeCommand(2));
    boundary.receive(makeCommand(3));

    const drained = boundary.drainForTick();
    expect(drained.appliedRevision).toBe(3);
    expect(drained.appliedCommandIds).toHaveLength(3);
    expect(boundary.getState().coldRevision).toBe(3);
  });

  it('rejects duplicate revision deterministically', () => {
    const boundary = new HotColdRevisionBoundary({ matchId, worldEpoch, coldRevision: 0 });

    boundary.receive(makeCommand(1));
    const receipt1 = boundary.receive(makeCommand(1));
    expect(receipt1.accepted).toBe(false);
    expect(receipt1.reason).toBe('duplicate');
  });

  it('rejects stale revision (less than expected)', () => {
    const boundary = new HotColdRevisionBoundary({ matchId, worldEpoch, coldRevision: 2 });

    const receipt = boundary.receive(makeCommand(1));
    expect(receipt.accepted).toBe(false);
    expect(receipt.reason).toBe('stale');
  });

  it('reports next pending revision when gap exists', () => {
    const boundary = new HotColdRevisionBoundary({ matchId, worldEpoch, coldRevision: 0 });

    boundary.receive(makeCommand(3)); // gap: expected 1, got 3
    const drained = boundary.drainForTick();
    expect(drained.appliedRevision).toBe(0);
    expect(drained.awaitingRevision).toBe(3); // next pending key
  });

  it('applies queued commands in revision order after gap is filled', () => {
    const boundary = new HotColdRevisionBoundary({ matchId, worldEpoch, coldRevision: 0 });

    boundary.receive(makeCommand(3)); // queued
    boundary.receive(makeCommand(1)); // fills gap
    boundary.receive(makeCommand(2)); // fills gap

    const drained = boundary.drainForTick();
    expect(drained.appliedRevision).toBe(3);
    expect(drained.appliedCommandIds).toHaveLength(3);
    expect(boundary.getState().coldRevision).toBe(3);
  });

  it('ignores command with mismatched worldEpoch', () => {
    const boundary = new HotColdRevisionBoundary({ matchId, worldEpoch, coldRevision: 0 });

    const wrongEpoch = { ...makeCommand(1), worldEpoch: 99 };
    const receipt = boundary.receive(wrongEpoch);
    expect(receipt.accepted).toBe(false);
    expect(receipt.reason).toBe('context_mismatch');
  });
});
