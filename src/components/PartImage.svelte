<script lang="ts">
  // Declarative image-with-fallback: replaces the copy-pasted onerror DOM
  // patching (style.display / nextElementSibling) previously used in five places.
  interface Props {
    src: string;
    alt: string;
    wrapperClass: string;
    imgClass: string;
    // Fallback rendering: a color chip when a hex is given, otherwise a box icon.
    colorHex?: string | null;
    fallbackClass?: string;
    iconSize?: number;
  }
  let { src, alt, wrapperClass, imgClass, colorHex = null, fallbackClass = "", iconSize = 18 }: Props = $props();

  let failed = $state(false);
  // Reset the error state whenever the image source changes
  $effect(() => {
    if (src) failed = false;
  });

  let showImage = $derived(!!src && !failed);
</script>

<div class="{wrapperClass} {showImage ? '' : 'placeholder'}">
  {#if showImage}
    <img {src} {alt} class={imgClass} onerror={() => { failed = true; }} />
  {:else if colorHex}
    <div class={fallbackClass} style="background-color: {colorHex}"></div>
  {:else}
    <svg xmlns="http://www.w3.org/2000/svg" width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="img-fallback-icon"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/></svg>
  {/if}
</div>
