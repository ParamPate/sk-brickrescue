<script lang="ts">
  import { tick } from "svelte";
  import { confirmState, settleConfirm } from "../services/confirm.svelte";

  let dialog = $state<HTMLDialogElement>();
  let confirmButton = $state<HTMLButtonElement>();

  // Opened last, so it stacks above any dialog that asked the question.
  $effect(() => {
    if (!dialog) return;
    if (confirmState.open && !dialog.open) {
      dialog.showModal();
      tick().then(() => confirmButton?.focus());
    } else if (!confirmState.open && dialog.open) {
      dialog.close();
    }
  });
</script>

<dialog bind:this={dialog} class="part-inspection confirm-dialog" aria-labelledby="confirm-message"
  onclose={() => settleConfirm(false)}>
  <p id="confirm-message">{confirmState.message}</p>
  <div class="review-row">
    {#if !confirmState.notice}
      <button type="button" class="btn" onclick={() => settleConfirm(false)}>Cancel</button>
    {/if}
    <button type="button" bind:this={confirmButton} class="btn {confirmState.danger ? 'danger-solid' : 'primary'}"
      onclick={() => settleConfirm(true)}>{confirmState.confirmLabel}</button>
  </div>
</dialog>
