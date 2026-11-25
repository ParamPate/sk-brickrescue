<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  // Photograph one piece: live preview → Capture → Use This Photo / Retake.
  interface Props {
    onCapture: (photo: Blob) => void;
    onCancel: () => void;
  }
  let { onCapture, onCancel }: Props = $props();

  let video = $state<HTMLVideoElement>();
  let stream: MediaStream | null = null;
  let captured = $state<{ blob: Blob; url: string } | null>(null);
  let error = $state("");
  let ready = $state(false);

  async function start() {
    error = "";
    ready = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      ready = true;
    } catch {
      error = "The camera could not be opened. Close other apps using it, allow camera access, or upload a photo instead.";
    }
  }

  function stop() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function capture() {
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      captured = { blob, url: URL.createObjectURL(blob) };
      stop();
    }, "image/jpeg", 0.92);
  }

  function retake() {
    if (captured) URL.revokeObjectURL(captured.url);
    captured = null;
    start();
  }

  onMount(start);
  onDestroy(() => {
    stop();
    if (captured) URL.revokeObjectURL(captured.url);
  });
</script>

<div class="camera-capture">
  {#if captured}
    <img src={captured.url} alt="Captured piece" />
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={video} autoplay playsinline muted></video>
  {/if}
  {#if error}<p class="camera-capture-error" role="alert">{error}</p>{/if}
  <div class="camera-capture-actions">
    {#if captured}
      <button type="button" class="btn" onclick={retake}>Retake</button>
      <button type="button" class="btn primary" onclick={() => captured && onCapture(captured.blob)}>Use This Photo</button>
    {:else}
      <button type="button" class="btn primary" disabled={!ready} onclick={capture}>Capture</button>
    {/if}
    <button type="button" class="btn" onclick={() => { stop(); onCancel(); }}>Cancel</button>
  </div>
</div>

<style>
  .camera-capture {
    display: grid;
    gap: 10px;
  }
  .camera-capture video,
  .camera-capture img {
    width: 100%;
    max-height: 50vh;
    object-fit: contain;
    background: #111;
    border-radius: var(--radius-sm);
  }
  .camera-capture-error {
    color: var(--danger);
    font-size: 0.875rem;
  }
  .camera-capture-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
