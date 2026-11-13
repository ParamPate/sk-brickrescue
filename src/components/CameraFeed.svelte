<script lang="ts">
  import { onDestroy } from "svelte";
  import type { BrickPart, ScannedColorInput } from "../services/types";
  import { findPhotoParts } from "../services/photoParts";
  import { predictPartFromImage } from "../services/api";
  import { loadColors, resolveColor } from "../services/catalog.svelte";
  import { buildRgbLookup, analyzeDominantColors, sameDominantColors, type RgbLookupEntry } from "../services/colorAnalyzer";

  const ANALYZE_INTERVAL_MS = 1500;
  const FLASH_DURATION_MS = 400;
  const SCAN_FEEDBACK_MS = 2500;
  const CAPTURE_JPEG_QUALITY = 0.85;
  const DEFAULT_COLOR_ID = 15; // Standard White placeholder when no colors were detected yet

  let colorRgbLookup = $state<RgbLookupEntry[]>([]);

  // loadColors never rejects (it falls back to the built-in palette internally)
  loadColors().then((colors) => {
    colorRgbLookup = buildRgbLookup(colors);
  });

  // --- PROPS (Svelte 5 Runes) ---
  interface Props {
    scannedColors: ScannedColorInput[];
    onPartIdentified: (part: BrickPart) => void;
  }
  let {
    scannedColors = $bindable(),
    onPartIdentified
  }: Props = $props();

  // --- STATE ---
  let videoElement = $state<HTMLVideoElement | null>(null);
  let canvasElement = $state<HTMLCanvasElement | null>(null);
  let streamActive = $state<boolean>(false);
  let cameraError = $state<string | null>(null);
  let isFrozen = $state<boolean>(false);
  let showFlash = $state<boolean>(false);
  let tapPosition = $state<{ x: number; y: number } | null>(null);
  let activeStream = $state<MediaStream | null>(null);
  let isCameraRequested = $state(false);
  let destroyed = false;
  let photoPreview = $state("");
  let photoBoxes = $state<{ left: number; top: number; width: number; height: number }[]>([]);
  let unidentified = $state<{ box: number; imageUrl: string; requestFailed: boolean }[]>([]);
  let activePhotoBox = $state(-1);
  onDestroy(() => {
    destroyed = true;
    URL.revokeObjectURL(photoPreview);
  });

  let photoProgress = $state("");
  let photoInput = $state<HTMLInputElement>();
  let scanFeedback = $state<string | null>(null);
  let scanFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

  const showScanFeedback = (message: string) => {
    scanFeedback = message;
    if (scanFeedbackTimeout) clearTimeout(scanFeedbackTimeout);
    scanFeedbackTimeout = setTimeout(() => {
      scanFeedback = null;
    }, SCAN_FEEDBACK_MS);
  };

  // Start/Stop video stream
  $effect(() => {
    if (!isCameraRequested) {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
        activeStream = null;
      }
      streamActive = false;
      return;
    }

    let cancelled = false;
    let activeStreamInstance: MediaStream | null = null;

    async function startCamera() {
      try {
        cameraError = null;
        let stream: MediaStream;

        try {
          // Versuch 1: Rückkamera (optimal für Handys)
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: false,
          });
        } catch (envErr) {
          if (cancelled) return;
          console.warn("Rear camera not available, trying default camera (webcam)...", envErr);
          // Versuch 2: Beliebige Kamera (Laptop-Webcam)
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        activeStreamInstance = stream;
        activeStream = stream;
        streamActive = true;

        if (videoElement) {
          videoElement.srcObject = stream;
        } else {
          // Fallback falls es beim allerersten Frame noch eine Verzögerung beim Binding gibt
          setTimeout(() => {
            if (videoElement) videoElement.srcObject = stream;
          }, 50);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn("Camera could not be started.", err);
        cameraError = "Enable camera in settings to scan.";
        streamActive = false;
        isCameraRequested = false;
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (activeStreamInstance) {
        activeStreamInstance.getTracks().forEach((track) => track.stop());
      }
    };
  });

  // Reset colors if camera is stopped
  $effect(() => {
    if (!streamActive && isCameraRequested) {
      scannedColors = [];
    }
  });

  // Periodic color extraction from camera if running
  $effect(() => {
    if (!streamActive || isFrozen) return;

    const interval = setInterval(() => {
      if (videoElement && canvasElement) {
        const canvas = canvasElement;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Draw video frame to small offscreen canvas to analyze pixels
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const detectedColors = analyzeDominantColors(imgData.data, colorRgbLookup);

        // Only publish a change when the dominant colors actually moved —
        // otherwise every 1.5s tick would trigger a full matching run.
        if (detectedColors.length > 0 && !sameDominantColors(detectedColors, scannedColors)) {
          scannedColors = detectedColors;
        }
      }
    }, ANALYZE_INTERVAL_MS);

    return () => clearInterval(interval);
  });

  async function recognize(canvas: HTMLCanvasElement, colorId: number, useCrop = false) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", CAPTURE_JPEG_QUALITY)
    );
    if (!blob) throw new Error("Could not encode scan image");

    const [detectedPart] = await predictPartFromImage(blob);
    if (!detectedPart || destroyed) return false;
    onPartIdentified({
      ...detectedPart,
      color_id: colorId,
      imageUrl: useCrop ? canvas.toDataURL("image/jpeg", 0.7) : detectedPart.imageUrl
    });
    return true;
  }

  async function classifyCapture(canvas: HTMLCanvasElement, useCrop = false) {
    try {
      if (!await recognize(canvas, scannedColors[0]?.color_id ?? DEFAULT_COLOR_ID, useCrop)) {
        showScanFeedback("No part recognized. Try a close-up of one brick.");
      }
    } catch (err) {
      console.error("Error in Brickognize classification:", err);
      showScanFeedback("Scan failed. Check your connection and try again.");
    } finally {
      isFrozen = false;
      tapPosition = null;
    }
  }

  async function scanPhoto(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || isFrozen) return;

    isFrozen = true;
    scanFeedback = null;
    photoProgress = "";
    activePhotoBox = -1;
    try {
      const image = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      try {
        const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get 2D context from canvas");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      } finally {
        image.close();
      }

      if (destroyed) return;
      URL.revokeObjectURL(photoPreview);
      photoPreview = URL.createObjectURL(file);
      photoBoxes = [];
      unidentified = [];

      const detection = document.createElement("canvas");
      const scale = Math.min(1, 800 / Math.max(canvas.width, canvas.height));
      detection.width = Math.max(1, Math.round(canvas.width * scale));
      detection.height = Math.max(1, Math.round(canvas.height * scale));
      const detector = detection.getContext("2d", { willReadFrequently: true });
      if (!detector) throw new Error("Could not get 2D context for detecting pieces");
      detector.drawImage(canvas, 0, 0, detection.width, detection.height);
      const parts = findPhotoParts(detector.getImageData(0, 0, detection.width, detection.height));
      photoBoxes = parts.map((part) => ({
        left: part.left / detection.width * 100,
        top: part.top / detection.height * 100,
        width: (part.right - part.left + 1) / detection.width * 100,
        height: (part.bottom - part.top + 1) / detection.height * 100
      }));
      const lookup = buildRgbLookup(await loadColors());
      isCameraRequested = false;
      cameraError = null;

      if (parts.length > 1) {
        const pixels = new Uint8ClampedArray(parts.reduce((size, part) => size + part.pixels.length, 0));
        let offset = 0;
        for (const part of parts) {
          pixels.set(part.pixels, offset);
          offset += part.pixels.length;
        }
        scannedColors = analyzeDominantColors(pixels, lookup);
        const crop = document.createElement("canvas");
        const cropCtx = crop.getContext("2d");
        if (!cropCtx) throw new Error("Could not get 2D context for cropping pieces");
        const xScale = canvas.width / detection.width;
        const yScale = canvas.height / detection.height;
        let recognized = 0;
        let failed = 0;
        for (const [index, part] of parts.entries()) {
          if (destroyed) return;
          activePhotoBox = index;
          photoProgress = `Scanning piece ${index + 1} of ${parts.length}…`;
          const left = Math.max(0, Math.floor((part.left - 5) * xScale));
          const top = Math.max(0, Math.floor((part.top - 5) * yScale));
          crop.width = Math.min(canvas.width, Math.ceil((part.right + 6) * xScale)) - left;
          crop.height = Math.min(canvas.height, Math.ceil((part.bottom + 6) * yScale)) - top;
          cropCtx.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
          const colorId = analyzeDominantColors(part.pixels, lookup)[0]?.color_id ?? DEFAULT_COLOR_ID;
          try {
            if (await recognize(crop, colorId, true)) {
              recognized++;
            } else if (!destroyed) {
              unidentified.push({ box: index + 1, imageUrl: crop.toDataURL("image/jpeg", 0.7), requestFailed: false });
            }
          } catch (err) {
            console.error("Error identifying photo crop:", err);
            failed++;
            if (!destroyed) {
              unidentified.push({ box: index + 1, imageUrl: crop.toDataURL("image/jpeg", 0.7), requestFailed: true });
            }
          }
        }
        photoProgress = `Recognized ${recognized} of ${parts.length} detected pieces.` +
          (unidentified.length ? ` ${unidentified.length} unidentified.` : "") +
          (failed ? ` ${failed} requests failed.` : "");
        return;
      }

      const sample = canvasElement;
      const sampleCtx = sample?.getContext("2d");
      if (!sample || !sampleCtx) throw new Error("Could not get 2D context from sample canvas");
      sampleCtx.drawImage(canvas, 0, 0, sample.width, sample.height);
      scannedColors = analyzeDominantColors(
        sampleCtx.getImageData(0, 0, sample.width, sample.height).data,
        lookup
      );
      await classifyCapture(canvas, true);
    } catch (err) {
      console.error("Error preparing scan photo:", err);
      showScanFeedback("Could not read that photo. Try a JPEG or PNG.");
    } finally {
      activePhotoBox = -1;
      isFrozen = false;
    }
  }

  // Core capture and classification logic
  const triggerCapture = async (clickX?: number, clickY?: number) => {
    if (isFrozen) return;

    if (clickX !== undefined && clickY !== undefined) {
      tapPosition = { x: clickX, y: clickY };
    } else {
      // Put marker in center of video element or fallback
      const rect = videoElement ? videoElement.getBoundingClientRect() : { width: 320, height: 240 };
      tapPosition = { x: rect.width / 2, y: rect.height / 2 };
    }

    isFrozen = true;
    showFlash = true;

    setTimeout(() => {
      showFlash = false;
    }, FLASH_DURATION_MS);

    if (streamActive && videoElement) {
      // Real classification with the Brickognize API
      try {
        const canvas = document.createElement("canvas");
        canvas.width = videoElement.videoWidth || 640;
        canvas.height = videoElement.videoHeight || 480;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get 2D context from canvas");

        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

        await classifyCapture(canvas);
      } catch (err) {
        console.error("Error during image capture:", err);
        isFrozen = false;
        tapPosition = null;
      }
    } else {
      isFrozen = false;
      tapPosition = null;
    }
  };

  // Tap/click to scan handler
  const handleViewportClick = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    triggerCapture(x, y);
  };

  // Handle keydown for Spacebar (to trigger scan on desktop webcams)
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!streamActive || isFrozen) return;
    if (e.code === "Space" && !(e.target instanceof HTMLElement && e.target.closest("button, input, a"))) {
      e.preventDefault(); // Prevent page scrolling
      triggerCapture();
    }
  };
</script>

<svelte:window onkeydown={handleKeyDown} />

<section class="main-content" aria-label="Scanner">
  <div class="photo-scan">
    <input bind:this={photoInput} type="file" accept="image/*" hidden onchange={scanPhoto} />
    <button class="activate-camera-btn" disabled={isFrozen} onclick={() => photoInput?.click()}>
      Scan Photo
    </button>
    {#if !streamActive && !isCameraRequested}
      <button class="camera-button" disabled={isFrozen} onclick={() => {
        photoProgress = "";
        isCameraRequested = true;
      }}>Start Camera</button>
    {/if}
    <p>Use a close-up or spread pieces apart on a plain, light surface. Brickognize receives images of the pieces for identification.</p>
    {#if !streamActive}
      <div role="status">{photoProgress || (isFrozen ? "Processing image..." : scanFeedback ?? "")}</div>
    {/if}
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scanner-viewport" class:photo-viewport={!streamActive && !!photoPreview && !isCameraRequested} onclick={handleViewportClick} style="cursor: {streamActive && !isFrozen ? 'crosshair' : 'default'}">
    <video
      bind:this={videoElement}
      autoplay
      playsinline
      muted
      class="camera-video {streamActive ? '' : 'hidden'}"
    >
      <track kind="captions" />
    </video>

    {#if !streamActive && photoPreview && !isCameraRequested}
      <img class="photo-preview" src={photoPreview} alt="LEGO pieces selected for scanning" />
      <div class="photo-boxes" aria-hidden="true">
        {#each photoBoxes as box, index}
          <div class="photo-box" class:active={index === activePhotoBox}
            class:unidentified={unidentified.some((piece) => piece.box === index + 1)}
            style:left={box.left + "%"} style:top={box.top + "%"}
            style:width={box.width + "%"} style:height={box.height + "%"}>
            <span>{index + 1}</span>
          </div>
        {/each}
      </div>
    {:else if !streamActive}
      <div class="camera-fallback-container">
        {#if isCameraRequested && !cameraError}
          <div class="camera-fallback-icon fallback-pulse" style="color: var(--primary)">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
          </div>
          <div class="camera-fallback-title">Connecting...</div>
          <div class="camera-fallback-desc">
            Please allow camera access if prompted by your browser.
          </div>
        {:else}
          <div class="camera-fallback-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
          </div>
          {#if cameraError}
            <div class="camera-fallback-title camera-fallback-error">Camera access denied</div>
            <div class="camera-fallback-desc">{cameraError}</div>
          {:else}
            <div class="camera-fallback-title">Ready to scan</div>
            <div class="camera-fallback-desc">
              Upload a photo or start the camera.
            </div>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Offscreen canvas for analyzing video pixels -->
    <canvas bind:this={canvasElement} width="64" height="80" class="hidden"></canvas>

    <!-- Capture Flash Effect -->
    <div class="flash-effect {showFlash ? 'trigger' : ''}"></div>

    <!-- Scan HUD Overlay -->
    {#if streamActive}
      <div class="scanner-overlay">


        <!-- Persistent amber viewfinder brackets — a target for placing a brick. -->
        <div class="viewfinder {isFrozen ? 'active' : ''}">
          <span class="viewfinder-corner tl"></span>
          <span class="viewfinder-corner tr"></span>
          <span class="viewfinder-corner bl"></span>
          <span class="viewfinder-corner br"></span>
        </div>

        <!-- Tap Marker -->
        {#if tapPosition}
          <div class="tap-marker" style="top: {tapPosition.y}px; left: {tapPosition.x}px;"></div>
        {/if}

        <div class="hud-bottom">
          <div class="hud-hint">
            {#if isFrozen}
              Processing image...
            {:else if scanFeedback}
              {scanFeedback}
            {:else}
              Tap to scan
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if unidentified.length && !streamActive}
    <details class="unidentified-pieces">
      <summary>Review unidentified pieces ({unidentified.length})</summary>
      <ul>
        {#each unidentified as piece (piece.box)}
          <li>
            <a href={piece.imageUrl} download={`piece-${piece.box}.jpg`}>
              <img src={piece.imageUrl} alt={`Piece ${piece.box}`} />
              <span>Box {piece.box}</span>
            </a>
            <span>{piece.requestFailed ? "Request failed" : "No match returned"}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  <!-- Color Profile Bar -->
  <div class="color-profile-panel">
    <div class="color-profile-header">
      <span class="panel-section-title">Dominant Colors</span>
    </div>

    {#if scannedColors.length > 0}
      <div class="color-bars-container">
        {#each scannedColors as sc (sc.color_id)}
          {@const colorInfo = resolveColor(sc.color_id)}
          <div
            class="color-bar"
            style="width: {sc.weight * 100}%; background-color: {colorInfo?.hex || '#777'};"
            title="{colorInfo?.name || 'Unknown'}: {Math.round(sc.weight * 100)}%"
          ></div>
        {/each}
      </div>
      <div class="color-bar-label">
        {#each scannedColors as sc (sc.color_id)}
          {@const colorInfo = resolveColor(sc.color_id)}
          <div class="color-chip-legend" title="{colorInfo?.name || 'Unknown'} · {Math.round(sc.weight * 100)}%">
            <span class="color-dot" style="background-color: {colorInfo?.hex || '#777'}"></span>
            <span class="color-chip-name">{colorInfo?.name}</span>
            <span class="color-chip-percent">{Math.round(sc.weight * 100)}%</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="color-profile-empty">
        Scan a photo or move the camera over bricks to detect colors.
      </div>
    {/if}
  </div>
</section>

<style>
  .photo-scan {
    padding: 0.75rem 1rem;
    text-align: left;
  }

  .photo-scan .activate-camera-btn {
    margin-top: 0;
  }

  .camera-button {
    margin-left: 0.5rem;
    padding: 9px 12px;
    border: 1px solid var(--border-glass);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    background: var(--bg-elevated);
    font: inherit;
    cursor: pointer;
  }

  .scanner-viewport.photo-viewport {
    aspect-ratio: auto;
  }

  .photo-preview {
    display: block;
    width: 100%;
    height: auto;
  }

  .photo-boxes {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .photo-box {
    position: absolute;
    border: 2px solid #36563f;
    box-shadow: 0 0 0 1px #fff;
    border-radius: 3px;
  }

  .photo-box span {
    position: absolute;
    bottom: 100%;
    left: -2px;
    padding: 0 3px;
    color: #fff;
    background: #36563f;
    font-size: 0.65rem;
  }

  .photo-box.unidentified {
    border: 2px dashed #a83b37;
  }

  .photo-box.unidentified span {
    background: #a83b37;
  }

  .unidentified-pieces {
    padding: 12px 16px;
  }

  .unidentified-pieces ul {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 8px;
    margin-top: 8px;
  }

  .unidentified-pieces li {
    font-size: 0.8rem;
  }

  .unidentified-pieces img {
    display: block;
    width: 100%;
    height: 75px;
    object-fit: contain;
  }

  .photo-box.active {
    border-color: #e4ad3a;
    z-index: 1;
  }

  .photo-scan p {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
</style>
