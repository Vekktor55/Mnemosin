import type {
  AiLocationView,
  GameState,
  GmLocationView,
  LocationDefinition,
  ObjectId,
  ObjectState,
  PublicLocationView,
} from '@mnemosin/contracts';

/**
 * Проекции локаций (K11: три уровня видимости контента — Player / AI / GM).
 *
 * Промпт 1.9 (D244): построители перенесены из modules/ai-director в core —
 * одни и те же проекции нужны нескольким потребителям (ai-director собирает
 * DirectorContext.currentLocation, gm.inspectState — GMStateView.locations,
 * транспорт 1.10 — GET /state/projection), а модули не импортируют друг друга
 * (D161). Общий владелец — ядро; данные (LocationDefinition + objectStates)
 * приходят через порты, логика чистая.
 *
 * Приватность (блокер B-10, патч §8.4):
 *  - Public: скрытые выходы ИСКЛЮЧЕНЫ, `lock.requiresFlag` не раскрывается
 *    (только человекочитаемая lockReason), невидимые объекты исключены;
 *  - AI: + скрытые выходы, narrativeNotes, aiGuidance, allObjects с visible;
 *    gmSecret (K7) НЕ передаётся модели никогда;
 *  - GM: + gmSecret, registeredEventIds, templateSlug.
 */

const objectStateOf = (state: GameState, objectId: ObjectId): ObjectState | undefined => state.objectStates[objectId];

export function toPublicLocationView(location: LocationDefinition, state: GameState): PublicLocationView {
  return {
    locationId: location.locationId,
    name: location.name,
    description: location.description,
    atmosphere: location.atmosphere,
    objects: location.objects
      .filter((object) => objectStateOf(state, object.objectId)?.visible ?? true)
      .map((object) => ({
        objectId: object.objectId,
        name: object.name,
        description: object.description,
        interactive: object.interactive,
        takeable: object.takeable,
      })),
    exits: location.exits
      .filter((exit) => !exit.hidden)
      .map((exit) => ({
        kind: exit.kind,
        toLocationId: exit.toLocationId,
        label: exit.label,
        description: exit.description,
        via: exit.via,
        locked: exit.locked,
        // K11: requiresFlag игроку не раскрывается; только человекочитаемая причина.
        lockReason: exit.lock.reason,
        oneWay: exit.oneWay,
      })),
    hazards: location.hazards,
    tags: location.tags,
  };
}

export function toAiLocationView(location: LocationDefinition, state: GameState): AiLocationView {
  const allObjects = location.objects.map((object) => ({
    objectId: object.objectId,
    name: object.name,
    description: object.description,
    interactive: object.interactive,
    takeable: object.takeable,
    visible: objectStateOf(state, object.objectId)?.visible ?? true,
  }));
  return {
    ...toPublicLocationView(location, state),
    hiddenExits: location.exits.filter((exit) => exit.hidden),
    narrativeNotes: location.narrativeNotes,
    aiGuidance: location.aiGuidance,
    // Ограничения v1 lore.secret_truth и «правда этажа» приходят с world-pack
    // конвертером (2.3/2.4); в dev-фикстурах этапа 1 их нет. gmSecret (K7)
    // модели НЕ передаётся никогда.
    secretRestrictions: [],
    floorTruth: null,
    allObjects,
  };
}

export function toGmLocationView(location: LocationDefinition, state: GameState): GmLocationView {
  return {
    ...toAiLocationView(location, state),
    gmSecret: location.gmSecret,
    registeredEventIds: location.registeredEventIds,
    templateSlug: location.templateSlug,
  };
}
