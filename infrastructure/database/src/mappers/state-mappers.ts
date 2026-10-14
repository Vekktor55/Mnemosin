import {
  GameStateSchema,
  LocationDefinitionSchema,
  type GameState,
  type LocationDefinition,
} from '@mnemosin/contracts';

import type { gameState, locations } from '../schema.js';
import { asJson, assertMatches, parseBody } from './index.js';

type StateRow = typeof gameState.$inferSelect;
type LocationRow = typeof locations.$inferSelect;

export function stateFromRow(row: StateRow): GameState {
  const body = parseBody(GameStateSchema, row.bodyJson, 'game_state');
  assertMatches('session_id', row.sessionId, body.sessionId, 'game_state');
  assertMatches('version', row.version, body.version, 'game_state');
  return body;
}

export function stateToRow(state: GameState): StateRow {
  return {
    sessionId: state.sessionId,
    version: state.version,
    currentLocationId: state.worldState.currentLocationId,
    timeOfDay: state.worldState.timeOfDay,
    endingReached: state.endingState !== null,
    updatedAt: state.updatedAt,
    bodyJson: asJson(state as unknown, 'game_state.insert'),
  };
}

export function locationFromRow(row: LocationRow): LocationDefinition {
  const body = parseBody(LocationDefinitionSchema, row.bodyJson, 'locations');
  assertMatches('location_id', row.locationId, body.locationId, 'locations');
  return body;
}

export function locationToRow(location: LocationDefinition): LocationRow {
  return {
    locationId: location.locationId,
    packId: location.templateSlug ? `pack:${location.templateSlug}` : null,
    templateSlug: location.templateSlug,
    name: location.name,
    exitsCount: location.exits.length,
    objectsCount: location.objects.length,
    hasGmSecret: location.gmSecret !== null,
    updatedAt: location.updatedAt,
    bodyJson: asJson(location as unknown, 'locations.upsert'),
  };
}
