import { z } from 'zod';
import { LocationId } from '../ids.js';

/**
 * Описание визуальной сцены (v3 §IV.5). Вынесено в отдельный leaf-модуль,
 * чтобы его могли использовать и TurnResolution, и AIResponse, и media-контур
 * без циклических импортов.
 */

export const VisualSceneDescriptionSchema = z.object({
  locationId: LocationId,
  mood: z.string().min(1).max(80),
  subjects: z.array(z.string().max(120)).max(8),
  style: z.string().max(120),
  cameraHint: z.string().max(200).nullable(),
});
export type VisualSceneDescription = z.infer<typeof VisualSceneDescriptionSchema>;

/** Подсказка сцены из эффекта REQUEST_MEDIA (до сборки полного описания). */
export const SceneHintSchema = z.string().min(1).max(500);
export type SceneHint = z.infer<typeof SceneHintSchema>;
