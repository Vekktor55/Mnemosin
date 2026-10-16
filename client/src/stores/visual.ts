import { writable } from 'svelte/store';
import type { AudioJobView, MediaJobView } from '@mnemosin/contracts';

/**
 * VisualStore — ЗАГОТОВКА под этап 2 (промпт 1.12, п.3): media/audio-джобы и
 * видимая сцена. В этапе 1 MEDIA_PROVIDER=none — сообщения MEDIA_x/AUDIO_x
 * не приходят; панель VisualPanel показывает «визуал появится на этапе 2».
 * Обработчики зарегистрированы, чтобы этап 2 не менял транспортный слой.
 */
export interface VisualState {
  readonly jobs: Readonly<Record<string, MediaJobView>>;
  readonly audioJobs: Readonly<Record<string, AudioJobView>>;
  /** URL последней READY-сцены, видимой игроку (этап 2). */
  readonly visibleSceneUrl: string | null;
}

export const EMPTY_VISUAL: VisualState = Object.freeze({ jobs: {}, audioJobs: {}, visibleSceneUrl: null });

export const visualStore = writable<VisualState>(EMPTY_VISUAL);

export function upsertMediaJob(job: MediaJobView): void {
  visualStore.update((state) =>
    Object.freeze({
      ...state,
      jobs: Object.freeze({ ...state.jobs, [job.mediaJobId]: job }),
      visibleSceneUrl: job.status === 'READY' && job.url !== null ? job.url : state.visibleSceneUrl,
    }),
  );
}

export function upsertAudioJob(job: AudioJobView): void {
  visualStore.update((state) =>
    Object.freeze({ ...state, audioJobs: Object.freeze({ ...state.audioJobs, [job.audioJobId]: job }) }),
  );
}

export function resetVisualStore(): void {
  visualStore.set(EMPTY_VISUAL);
}
