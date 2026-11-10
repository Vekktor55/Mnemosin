<script lang="ts">
  /**
   * VisualPanel — заглушка этапа 1 (промпт 1.12, п.4): «визуал появится на
   * этапе 2». visualStore уже принимает MEDIA_x/AUDIO_x (этап 2 включит
   * картинку без изменения транспорта).
   *
   * Редизайн (только графика): контейнер — старинная мрачная рама с двойным
   * багровым кантом; при смене локации / прибытии нового медиа (MEDIA_READY →
   * обновление sceneUrl) — медленный пульс свечения. Логика visualStore
   * не меняется: эффект следит за уже существующим $derived-значением.
   */
  import { visualStore } from '../stores/index.js';

  const sceneUrl = $derived($visualStore.visibleSceneUrl);

  /** Декоративный «разряд» свечения на новый кадр (UI-only, без изменения сторов). */
  let pulsing = $state(false);

  $effect(() => {
    if (sceneUrl === null) return;
    pulsing = true;
    const timer = setTimeout(() => {
      pulsing = false;
    }, 2600);
    return () => clearTimeout(timer);
  });
</script>

<div class="panel visual-panel">
  <h3 class="panel-title">Визуал</h3>
  {#if sceneUrl !== null}
    <!-- Этап 2: url приходит с сервера (MEDIA_READY), отдаётся через /media/files/* -->
    <div class="scene-frame {pulsing ? 'pulse' : ''}" data-testid="scene-frame">
      <img src={sceneUrl} alt="Сцена" data-testid="scene-image" />
    </div>
  {:else}
    <div class="visual-stub" data-testid="visual-stub">визуал появится на этапе 2</div>
  {/if}
</div>
