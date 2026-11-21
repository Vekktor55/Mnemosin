/**
 * Test fixture AI providers - offline stands for testing only.
 * These are NOT production code and should not be imported in production code.
 *
 * - ScriptedAI — offline stand #1 (prompt 1.7, F-7.3): reads fixture AI response
 * - EchoAI — offline stand #2 (prompt 1.7, F-7.3): echoes player actions as narrative
 * - FailingAI — offline stand #3 (prompt 1.7, F-7.3): simulates provider failures
 */

export {
  ScriptedAI,
  ACTION_COUNT_MARKER,
  PLACEHOLDER_PLAYER_PREFIX,
  SCRIPTED_MODEL,
  type ScriptedAIOptions,
} from './scripted-provider.js';

export { EchoAI, echoNarrative, ECHO_MODEL, type EchoAIOptions } from './echo-provider.js';

export { FailingAI, FailingModeSchema, type FailingMode, type FailingAIOptions } from './failing-provider.js';
