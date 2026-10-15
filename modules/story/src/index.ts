/**
 * @mnemosin/module-story — флаги и знания игроков (промпт 1.9, п.3).
 *
 * D120 (F-8.4): запись — только через core/state-service.apply, не напрямую
 * в репозиторий. Идемпотентность — детерминированные серверные ключи (D217-образец).
 */
export {
  storyContract,
  SetFlagInputSchema,
  SetFlagOutputSchema,
  GrantKnowledgeInputSchema,
  GrantKnowledgeOutputSchema,
  ListKnownFactsInputSchema,
  ListKnownFactsOutputSchema,
  KnownFactSchema,
  type SetFlagInput,
  type SetFlagOutput,
  type GrantKnowledgeInput,
  type GrantKnowledgeOutput,
  type ListKnownFactsInput,
  type ListKnownFactsOutput,
  type KnownFact,
} from './contract.js';
export { StoryService, type StoryServiceDeps } from './service.js';

export const PACKAGE_ID = '@mnemosin/module-story';
export const IMPLEMENTED_IN_PROMPT = '1.9';
