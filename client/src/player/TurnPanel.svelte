<script lang="ts">
  /** TurnPanel (SPEC §4): TurnStatus + ActionsInput + MyActions. */
  import TurnStatus from './TurnStatus.svelte';
  import ActionsInput from './ActionsInput.svelte';
  import MyActions from './MyActions.svelte';
</script>

<!--
  Редизайн (только графика): обёртка turn-ritual — «ритуальный стол» хода;
  скрытый SVG-фильтр #mn-displace (feTurbulence + feDisplacementMap) даёт
  органическое искажение кнопки «Действовать» при наведении (player.css).
  Состав и логика дочерних компонентов не меняются.
-->
<div class="turn-ritual">
  <svg class="mn-svg-defs" aria-hidden="true" focusable="false" width="0" height="0">
    <filter id="mn-displace">
      <feTurbulence type="fractalNoise" baseFrequency="0.022 0.03" numOctaves="2" seed="7" result="warp" />
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  </svg>

  <div class="panel turn-panel" data-testid="turn-panel">
    <h3 class="panel-title">Ход</h3>
    <TurnStatus />
    <MyActions />
    <ActionsInput />
  </div>
</div>
