<script lang="ts">
  /**
   * VisualPanel — заглушка этапа 1 (промпт 1.12, п.4): «визуал появится на
   * этапе 2». visualStore уже принимает MEDIA_x/AUDIO_x (этап 2 включит
   * картинку без изменения транспорта).
   */
  import { visualStore } from '../stores/index.js';

  const sceneUrl = $derived($visualStore.visibleSceneUrl);
</script>

<div class="panel">
  <h3 class="panel-title">Визуал</h3>
  {#if sceneUrl !== null}
    <!-- Этап 2: url приходит с сервера (MEDIA_READY), отдаётся через /media/files/* -->
    <img src={sceneUrl} alt="Сцена" style="max-width: 100%; border-radius: var(--mn-radius-sm);" data-testid="scene-image" />
  {:else}
    <div class="visual-stub" data-testid="visual-stub">визуал появится на этапе 2</div>
  {/if}
</div>
