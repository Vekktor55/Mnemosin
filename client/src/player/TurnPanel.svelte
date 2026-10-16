<script lang="ts">
  /** TurnPanel (SPEC §4): TurnStatus + ActionsInput + MyActions. */
  import TurnStatus from './TurnStatus.svelte';
  import ActionsInput from './ActionsInput.svelte';
  import MyActions from './MyActions.svelte';
</script>

<div class="panel turn-panel" data-testid="turn-panel">
  <h3 class="panel-title">Ход</h3>
  <TurnStatus />
  <MyActions />
  <ActionsInput />
</div>
