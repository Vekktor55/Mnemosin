import { z } from 'zod';

/**
 * Module Contract (v3 §IV.1) как generic, а не `Record<string, unknown>`:
 * F-8.1 — контракт с `unknown` на границе гарантировал нарушение антипаттерна
 * из v3 §I.4. Теперь команды и запросы описываются Zod-схемами, а `defineModule`
 * валидирует контракт (события, зависимости, capability).
 */

export const ModuleIdSchema = z.enum([
  'session',
  'turn',
  'chat',
  'story',
  'gm',
  'gm-review',
  'gm-audit',
  'ai-director',
  'media-director',
  'audio-director',
  'inventory',
  'analytics',
]);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export type ZodCommandMap = Record<string, { input: z.ZodTypeAny; output: z.ZodTypeAny }>;

export interface ModuleContract<
  TCmd extends ZodCommandMap = ZodCommandMap,
  TQuery extends ZodCommandMap = ZodCommandMap,
> {
  readonly moduleId: ModuleId;
  readonly purpose: string;
  readonly version: string;
  readonly commands: TCmd;
  readonly queries: TQuery;
  /** Команды, требующие idempotencyKey от клиента (F-8.2). */
  readonly idempotentCommands: readonly string[];
  readonly emits: readonly string[];
  readonly subscribes: readonly string[];
  readonly ports: readonly string[];
  /** D161: модули не импортируют друг друга — зависимости декларативны, wiring в apps/server. */
  readonly dependencies: readonly ModuleId[];
  readonly capabilities: readonly string[];
}

export interface DefineModuleOptions<TCmd extends ZodCommandMap, TQuery extends ZodCommandMap> {
  readonly moduleId: ModuleId;
  readonly purpose: string;
  readonly version: string;
  readonly commands: TCmd;
  readonly queries: TQuery;
  readonly idempotentCommands?: readonly string[];
  readonly emits?: readonly string[];
  readonly subscribes?: readonly string[];
  readonly ports?: readonly string[];
  readonly dependencies?: readonly ModuleId[];
  readonly capabilities?: readonly string[];
}

/**
 * Конструктор контракта. Валидация (события ⊆ каталог, зависимости ⊆ ModuleId,
 * отсутствие циклов) выполняется тестом `tests/contract/module-registry.test.ts`
 * при загрузке реестра модулей (промпт 1.9), чтобы не тянуть сюда импорт
 * каталога событий и не создавать цикл contracts → events → contracts.
 */
export function defineModule<TCmd extends ZodCommandMap, TQuery extends ZodCommandMap>(
  options: DefineModuleOptions<TCmd, TQuery>,
): ModuleContract<TCmd, TQuery> {
  return Object.freeze({
    moduleId: options.moduleId,
    purpose: options.purpose,
    version: options.version,
    commands: options.commands,
    queries: options.queries,
    idempotentCommands: options.idempotentCommands ?? [],
    emits: options.emits ?? [],
    subscribes: options.subscribes ?? [],
    ports: options.ports ?? [],
    dependencies: options.dependencies ?? [],
    capabilities: options.capabilities ?? [],
  });
}

/** UI-вклад модуля (v3 §X.3; критерий A3.5). */
export const UiPanelContributionSchema = z.object({
  moduleId: ModuleIdSchema,
  panelId: z.string().min(1).max(60),
  title: z.string().min(1).max(60),
  audience: z.enum(['PLAYER', 'GM', 'BOTH']),
  visibleWhen: z.object({
    requiresCapability: z.string().max(40).nullable(),
    sessionStatuses: z.array(z.enum(['LOBBY', 'ACTIVE', 'PAUSED', 'ENDED'])),
  }),
});
export type UiPanelContribution = z.infer<typeof UiPanelContributionSchema>;
