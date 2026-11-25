<script lang="ts">
  import type { ScannedColorInput } from "../services/types";
  import { loadColors, resolveColor } from "../services/catalog.svelte";
  import { buildRgbLookup, analyzeDominantColors, sameDominantColors, type RgbLookupEntry } from "../services/colorAnalyzer";
  import { addPhoto, addPiece, batch } from "../services/batch.svelte";
  import { estimateColor } from "../services/recognition";
  import { canvasToBlob, detectPieces, estimateImageColor, fileStem, fileToCanvas } from "../services/imageTools";

  const ANALYZE_INTERVAL_MS = 1500;
  const FLASH_DURATION_MS = 400;
  const SCAN_FEEDBACK_MS = 2500;
  const CROP_JPEG_QUALITY = 0.9;
  const PREVIEW_JPEG_QUALITY = 0.85;
  const IMAGE_FILE = /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i;

  let colorRgbLookup = $state<RgbLookupEntry[]>([]);

  // loadColors never rejects (it falls back to the built-in palette internally)
  loadColors().then((colors) => {
    colorRgbLookup = buildRgbLookup(colors);
  });

  // --- PROPS (Svelte 5 Runes) ---
  interface Props {
    scannedColors: ScannedColorInput[];
    selectedPhotoBox?: number | null;
    onSelectPhotoBox?: (box: number | null) => void;
    onOpenPiece?: (id: string) => void;
  }
  let {
    scannedColors = $bindable(),
    selectedPhotoBox = null,
    onSelectPhotoBox = () => {},
    onOpenPiece = () => {}
  }: Props = $props();

  // --- STATE ---
  let videoElement = $state<HTMLVideoElement | null>(null);
  let canvasElement = $state<HTMLCanvasElement | null>(null);
  let streamActive = $state<boolean>(false);
  let cameraError = $state<string | null>(null);
  let isFrozen = $state<boolean>(false);
  let preparing = $state("");
  let showFlash = $state<boolean>(false);
  let tapPosition = $state<{ x: number; y: number } | null>(null);
  let activeStream = $state<MediaStream | null>(null);
  let isCameraRequested = $state(false);
  let captureCount = 0;

  let photoInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  let scanFeedback = $state<string | null>(null);
  let scanFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

  let currentPhoto = $derived(batch.photos.find((photo) => photo.id === batch.currentPhotoId) ?? null);
  let photoPieces = $derived(currentPhoto ? batch.records.filter((record) => record.photoId === currentPhoto.id) : []);
  let pieceByBox = $derived(new Map(photoPieces.map((record) => [record.box, record])));
  let photoStatus = $derived.by(() => {
    if (!photoPieces.length) return "";
    const pending = photoPieces.filter((r) => r.status === "queued" || r.status === "processing").length;
    const recognized = photoPieces.filter((r) => r.status === "done").length;
    const missed = photoPieces.length - pending - recognized;
    if (pending) return `Identifying ${photoPieces.length - pending} of ${photoPieces.length} detected pieces…`;
    return `Recognized ${recognized} of ${photoPieces.length} detected pieces.` + (missed ? ` ${missed} unidentified.` : "");
  });

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
          // Rear camera first (phones)
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: false,
          });
        } catch (envErr) {
          if (cancelled) return;
          console.warn("Rear camera not available, trying default camera (webcam)...", envErr);
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

  // Split one photo into piece crops and queue them. Identification runs in the
  // background (several pieces at once), so the next photo can be prepared
  // immediately.
  async function preparePhoto(file: File, lookup: RgbLookupEntry[]) {
    const canvas = await fileToCanvas(file);
    const { parts, width, height } = detectPieces(canvas);
    const stem = fileStem(file.name);

    if (parts.length === 0) {
      // A close-up of one piece (or nothing separable): send the whole image.
      const sample = document.createElement("canvas");
      sample.width = 64;
      sample.height = 64;
      const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
      sampleCtx?.drawImage(canvas, 0, 0, 64, 64);
      if (sampleCtx) scannedColors = analyzeDominantColors(sampleCtx.getImageData(0, 0, 64, 64).data, lookup);
      const blob = await canvasToBlob(canvas, CROP_JPEG_QUALITY);
      addPiece({ image: `${stem}.jpg`, blob, fallbackColor: estimateImageColor(canvas) });
      return;
    }

    const preview = canvasToBlob(canvas, PREVIEW_JPEG_QUALITY);
    const photoId = addPhoto(file.name, await preview, parts.map((part) => ({
      left: part.left / width * 100,
      top: part.top / height * 100,
      width: (part.right - part.left + 1) / width * 100,
      height: (part.bottom - part.top + 1) / height * 100
    })));
    onSelectPhotoBox(null);

    const pixels = new Uint8ClampedArray(parts.reduce((size, part) => size + part.pixels.length, 0));
    let offset = 0;
    for (const part of parts) {
      pixels.set(part.pixels, offset);
      offset += part.pixels.length;
    }
    scannedColors = analyzeDominantColors(pixels, lookup);

    // Encode every crop in parallel (also avoids per-call throttling in background tabs),
    // then queue them in photo order.
    const xScale = canvas.width / width;
    const yScale = canvas.height / height;
    const crops = await Promise.all(parts.map((part) => {
      const crop = document.createElement("canvas");
      const cropCtx = crop.getContext("2d");
      if (!cropCtx) throw new Error("Could not get 2D context for cropping pieces");
      const left = Math.max(0, Math.floor((part.left - 5) * xScale));
      const top = Math.max(0, Math.floor((part.top - 5) * yScale));
      crop.width = Math.min(canvas.width, Math.ceil((part.right + 6) * xScale)) - left;
      crop.height = Math.min(canvas.height, Math.ceil((part.bottom + 6) * yScale)) - top;
      cropCtx.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
      return canvasToBlob(crop, CROP_JPEG_QUALITY);
    }));
    for (const [index, part] of parts.entries()) {
      addPiece({
        image: `${stem}_piece${String(index + 1).padStart(2, "0")}.jpg`,
        blob: crops[index],
        photoId,
        box: index + 1,
        fallbackColor: estimateColor(part.pixels)
      });
    }
  }

  async function scanFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/") || IMAGE_FILE.test(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!images.length) {
      showScanFeedback("No JPEG or PNG images were selected.");
      return;
    }
    isCameraRequested = false;
    cameraError = null;
    scanFeedback = null;
    const lookup = buildRgbLookup(await loadColors());
    let failed = 0;
    for (const [index, file] of images.entries()) {
      preparing = images.length > 1 ? `Preparing photo ${index + 1} of ${images.length}…` : "Finding pieces…";
      try {
        await preparePhoto(file, lookup);
      } catch (err) {
        console.error(`Could not read ${file.name}:`, err);
        failed++;
      }
    }
    preparing = "";
    if (failed) showScanFeedback(`${failed} file${failed === 1 ? "" : "s"} could not be read. Try JPEG or PNG.`);
  }

  function onFilesChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) scanFiles(files);
  }

  // Core capture and classification logic
  const triggerCapture = async (clickX?: number, clickY?: number) => {
    if (isFrozen || !streamActive || !videoElement) return;

    if (clickX !== undefined && clickY !== undefined) {
      tapPosition = { x: clickX, y: clickY };
    } else {
      const rect = videoElement.getBoundingClientRect();
      tapPosition = { x: rect.width / 2, y: rect.height / 2 };
    }

    isFrozen = true;
    showFlash = true;
    setTimeout(() => {
      showFlash = false;
    }, FLASH_DURATION_MS);

    try {
      const canvas = document.createElement("canvas");
      canvas.width = videoElement.videoWidth || 640;
      canvas.height = videoElement.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get 2D context from canvas");
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const record = await addPiece({
        image: `capture_${String(++captureCount).padStart(3, "0")}.jpg`,
        blob: await canvasToBlob(canvas, CROP_JPEG_QUALITY),
        fallbackColor: estimateImageColor(canvas)
      });
      if (record.status === "nomatch") showScanFeedback("No part recognized. Try a close-up of one brick.");
      else if (record.status === "failed") showScanFeedback("Scan failed. Check your connection and try again.");
      else if (record.row) showScanFeedback(`${record.row["Part Name"]} · ${record.row["LEGO Color"]}`);
    } catch (err) {
      console.error("Error during image capture:", err);
      showScanFeedback("Scan failed. Try again.");
    } finally {
      isFrozen = false;
      tapPosition = null;
    }
  };

  const handleViewportClick = (e: MouseEvent) => {
    if (!streamActive) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    triggerCapture(e.clientX - rect.left, e.clientY - rect.top);
  };

  // Spacebar triggers a scan on desktop webcams
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!streamActive || isFrozen) return;
    if (e.code === "Space" && !(e.target instanceof HTMLElement && e.target.closest("button, input, a, select, dialog"))) {
      e.preventDefault();
      triggerCapture();
    }
  };
</script>

<svelte:window onkeydown={handleKeyDown} />

<section class="main-content" aria-label="Scanner">
  <div class="photo-scan">
    <input bind:this={photoInput} type="file" accept="image/*" multiple hidden onchange={onFilesChosen} />
    <input bind:this={folderInput} type="file" accept="image/*" multiple hidden webkitdirectory onchange={onFilesChosen} />
    <button class="activate-camera-btn" disabled={!!preparing} onclick={() => photoInput?.click()}>
      Scan Photos
    </button>
    <button class="camera-button" disabled={!!preparing} onclick={() => folderInput?.click()}>Add Folder</button>
    {#if !streamActive && !isCameraRequested}
      <button class="camera-button" onclick={() => { isCameraRequested = true; }}>Start Camera</button>
    {:else}
      <button class="camera-button" onclick={() => { isCameraRequested = false; }}>Stop Camera</button>
    {/if}
    <p>Select one or more photos. Spread pieces apart on a plain, light surface, or use close-ups of single pieces. Brickognize receives images of the pieces for identification.</p>
    {#if !streamActive}
      <div role="status">{preparing || scanFeedback || photoStatus}</div>
    {/if}
    {#if batch.photos.length > 1 && !streamActive}
      <label class="photo-switch">Photo
        <select value={batch.currentPhotoId} onchange={(e) => { batch.currentPhotoId = e.currentTarget.value; onSelectPhotoBox(null); }}>
          {#each batch.photos as photo (photo.id)}<option value={photo.id}>{photo.name}</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scanner-viewport" class:photo-viewport={!streamActive && !!currentPhoto?.url && !isCameraRequested} onclick={handleViewportClick} style="cursor: {streamActive && !isFrozen ? 'crosshair' : 'default'}">
    <video
      bind:this={videoElement}
      autoplay
      playsinline
      muted
      class="camera-video {streamActive ? '' : 'hidden'}"
    >
      <track kind="captions" />
    </video>

    {#if !streamActive && currentPhoto?.url && !isCameraRequested}
      <img class="photo-preview" src={currentPhoto.url} alt="LEGO pieces selected for scanning" />
      <div class="photo-boxes">
        {#each currentPhoto.boxes as box, index (index)}
          {@const piece = pieceByBox.get(index + 1)}
          <button type="button" class="photo-box"
            class:active={piece?.status === "processing" || selectedPhotoBox === index + 1}
            class:unidentified={piece?.status === "nomatch" || piece?.status === "failed"}
            class:pending={piece?.status === "queued"}
            style:left={box.left + "%"} style:top={box.top + "%"}
            style:width={box.width + "%"} style:height={box.height + "%"}
            aria-label={`Review piece ${index + 1}${piece?.row ? `: ${piece.row["Part Name"]}` : ""}`}
            title={piece?.row ? `${piece.row["Part ID"]} · ${piece.row["Part Name"]} · ${piece.row["LEGO Color"]}` : `Piece ${index + 1}`}
            onclick={(event) => { event.stopPropagation(); onSelectPhotoBox(index + 1); if (piece) onOpenPiece(piece.id); }}>
            <span>{index + 1}</span>
          </button>
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
              Upload photos or start the camera.
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
    padding: 0;
    background: transparent;
    cursor: pointer;
    pointer-events: auto;
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

  .photo-box.pending {
    border-style: dotted;
    opacity: 0.75;
  }

  .photo-switch {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  .photo-switch select {
    margin-left: 6px;
    max-width: 70%;
    font: inherit;
  }

  .photo-box.unidentified {
    border: 2px dashed #a83b37;
  }

  .photo-box.unidentified span {
    background: #a83b37;
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
