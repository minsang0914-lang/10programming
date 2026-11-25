import { GIFEncoder, applyPalette, quantize } from "../vendor/gifenc.esm.js";

const FORMAT = "rgb565";

export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) {
    const value = n / 1024;
    return `${value.toFixed(value < 10 ? 1 : 0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  const whole = Math.floor(remainder);
  const tenth = Math.min(9, Math.floor((remainder - whole) * 10));
  return `${minutes}:${String(whole).padStart(2, "0")}.${tenth}`;
}

export function gifDownloadName(filename) {
  const trimmed = String(filename || "").trim() || "video";
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base || "video"}.gif`;
}

export function outputSize(videoWidth, videoHeight, maxWidth) {
  const sourceWidth = Math.max(2, videoWidth | 0);
  const sourceHeight = Math.max(2, videoHeight | 0);
  let width = sourceWidth;
  let height = sourceHeight;
  const limit = Math.max(2, maxWidth | 0);
  if (width > limit) {
    height = Math.round(height * (limit / width));
    width = limit;
  }
  if (height > 960) {
    width = Math.round(width * (960 / height));
    height = 960;
  }
  width = Math.max(2, width - (width % 2));
  height = Math.max(2, height - (height % 2));
  return { width, height };
}

export function frameCount(start, end, fps) {
  const span = Math.max(0, end - start);
  return Math.max(1, Math.round(span * fps));
}

export function delayMsForFrame(index, fps) {
  const step = 100 / fps;
  const centiseconds = Math.round((index + 1) * step) - Math.round(index * step);
  return Math.max(2, centiseconds) * 10;
}

export function canvasFilter(state) {
  const parts = [];
  if (state.filter === "gray") parts.push("grayscale(1)");
  else if (state.filter === "sepia") parts.push("sepia(0.92)");
  else if (state.filter === "vivid") parts.push("saturate(1.4)", "contrast(1.08)");
  else if (state.filter === "fade") parts.push("saturate(0.72)", "brightness(1.08)", "contrast(0.9)");
  if (Number(state.brightness) !== 100) parts.push(`brightness(${state.brightness / 100})`);
  if (Number(state.contrast) !== 100) parts.push(`contrast(${state.contrast / 100})`);
  return parts.length ? parts.join(" ") : "none";
}

export function estimateBytes({ width, height, frames, colors, grayscale }) {
  const pixels = Math.max(1, width) * Math.max(1, height);
  const colorScale = Math.sqrt(Math.min(256, Math.max(8, colors)) / 256);
  const bytesPerPixel = (grayscale ? 0.2 : 0.45) * (0.55 + 0.45 * colorScale);
  return Math.round(pixels * frames * bytesPerPixel + 1200 + frames * 18);
}

function abortError() {
  const error = new Error("변환이 취소되었습니다.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function waitEvent(target, eventName, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      target.removeEventListener(eventName, finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    target.addEventListener(eventName, finish);
  });
}

async function nextPaintedFrame(video) {
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 450);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return;
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function ensureCanDraw(video) {
  if (video.readyState >= 2) return;
  await waitEvent(video, "loadeddata", 4000);
}

export async function seekTo(video, time) {
  await ensureCanDraw(video);
  const hasDuration = Number.isFinite(video.duration);
  const end = hasDuration ? Math.max(video.duration - 0.001, 0) : time;
  const target = Math.min(Math.max(Number(time) || 0, 0), end);
  if (Math.abs((video.currentTime || 0) - target) > 0.0008) {
    const seeked = waitEvent(video, "seeked", 1600);
    try {
      video.pause();
      video.currentTime = target;
    } catch {
      return;
    }
    await seeked;
  }
  await nextPaintedFrame(video);
}

function drawFrame(ctx, video, width, height, filter) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = filter || "none";
  ctx.drawImage(video, 0, 0, width, height);
  ctx.filter = "none";
}

function drawEditedFrame(ctx, video, width, height, filter, options) {
  ctx.save();
  ctx.fillStyle = options.background || "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate((Number(options.rotation) || 0) * Math.PI / 180);
  ctx.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1);
  const rotated = Math.abs(options.rotation % 180) === 90;
  const sourceWidth = options.cropRect?.width || (rotated ? height : width);
  const sourceHeight = options.cropRect?.height || (rotated ? width : height);
  const scale = options.cropFill ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.filter = filter || "none";
  if (options.cropRect) {
    ctx.drawImage(video, options.cropRect.x, options.cropRect.y, sourceWidth, sourceHeight, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  } else {
    ctx.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  }
  ctx.restore();
}

function isMostlyBlank(data) {
  for (let i = 0; i < data.length; i += 16) {
    if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) return false;
  }
  return true;
}

function indexFrame(image, colors) {
  const colorCount = Math.max(8, Math.min(256, colors | 0));
  const palette = quantize(image.data, colorCount, { format: FORMAT });
  if (!palette?.length) {
    throw new Error("색을 추리지 못했습니다. 다른 구간으로 시도해 주세요.");
  }
  const index = applyPalette(image.data, palette, FORMAT);
  return { palette, index };
}

async function readFrame(video, ctx, width, height, filter, at, allowRetry) {
  await seekTo(video, at);
  drawFrame(ctx, video, width, height, filter);
  let image = ctx.getImageData(0, 0, width, height);
  if (allowRetry && isMostlyBlank(image.data)) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await nextPaintedFrame(video);
    drawFrame(ctx, video, width, height, filter);
    image = ctx.getImageData(0, 0, width, height);
  }
  return image;
}

function makeContext(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return { canvas, ctx };
}

function applyPixelation(ctx, smallCtx, width, height, pixelSize) {
  if (!smallCtx || pixelSize <= 1) return;
  const smallCanvas=smallCtx.canvas;
  smallCtx.clearRect(0,0,smallCanvas.width,smallCanvas.height);
  smallCtx.drawImage(ctx.canvas,0,0,smallCanvas.width,smallCanvas.height);
  ctx.save();
  ctx.imageSmoothingEnabled=false;
  ctx.clearRect(0,0,width,height);
  ctx.drawImage(smallCanvas,0,0,width,height);
  ctx.restore();
}

export async function measureSample(video, options) {
  const rotated = Math.abs((Number(options.rotation) || 0) % 180) === 90;
  const sourceWidth=options.cropRect?.width||options.videoWidth;
  const sourceHeight=options.cropRect?.height||options.videoHeight;
  const baseSize = rotated
    ? outputSize(sourceHeight, sourceWidth, options.maxWidth)
    : outputSize(sourceWidth, sourceHeight, options.maxWidth);
  const width = Math.max(2, Math.min(4096, Math.round(options.width || baseSize.width)) & ~1);
  const height = Math.max(2, Math.min(4096, Math.round(options.height ? (rotated ? options.width : options.height) : (width * (rotated ? sourceWidth : sourceHeight) / (rotated ? sourceHeight : sourceWidth)))) & ~1);
  const speed=Math.max(.1,Number(options.speed)||1);
  const outputFps=speed>1?options.fps:options.fps*speed;
  const frames=frameCount(options.start,options.end,speed>1?options.fps/speed:options.fps);
  const { ctx } = makeContext(width, height);
  const pixelSize=Math.max(1,Number(options.pixelSize)||1);
  const smallContext=pixelSize>1?makeContext(Math.max(1,Math.ceil(width/pixelSize)),Math.max(1,Math.ceil(height/pixelSize))).ctx:null;
  const span = Math.max(options.end - options.start, 1 / options.fps);
  const at = options.start + span / 2;
  if (options.isCancelled?.()) return null;
  const image = await readFrame(video, ctx, width, height, options.filter, at, true);
  if (options.rotation || options.flipX || options.flipY || options.cropFill || options.background || options.cropRect) {
    drawEditedFrame(ctx, video, width, height, options.filter, options);
  }
  applyPixelation(ctx,smallContext,width,height,pixelSize);
  if(pixelSize>1||options.rotation||options.flipX||options.flipY||options.cropFill||options.background||options.cropRect) image.data.set(ctx.getImageData(0,0,width,height).data);
  if (options.isCancelled?.()) return null;
  const { palette, index } = indexFrame(image, options.colors);
  const gif = GIFEncoder();
  gif.writeFrame(index, width, height, {
    palette,
    delay: delayMsForFrame(0, outputFps),
    repeat: 0,
  });
  gif.finish();
  const oneFrame = gif.bytes().length;
  const overhead = 48;
  return overhead + Math.max(1, oneFrame - overhead) * frames;
}

export async function convertToGif(video, options) {
  throwIfAborted(options.signal);
  const rotated = Math.abs((Number(options.rotation) || 0) % 180) === 90;
  const sourceWidth=options.cropRect?.width||options.videoWidth;
  const sourceHeight=options.cropRect?.height||options.videoHeight;
  const baseSize = rotated
    ? outputSize(sourceHeight, sourceWidth, options.maxWidth)
    : outputSize(sourceWidth, sourceHeight, options.maxWidth);
  const width = Math.max(2, Math.min(4096, Math.round(options.width ? (rotated ? options.height : options.width) : baseSize.width)) & ~1);
  const height = Math.max(2, Math.min(4096, Math.round(options.height ? (rotated ? options.width : options.height) : (width * (rotated ? sourceWidth : sourceHeight) / (rotated ? sourceHeight : sourceWidth)))) & ~1);
  const speed=Math.max(.1,Number(options.speed)||1);
  const effectiveFps=speed>1?options.fps:options.fps*speed;
  const frames=frameCount(options.start,options.end,speed>1?options.fps/speed:options.fps);
  const span = Math.max(options.end - options.start, 1 / Math.max(options.fps, 1));
  const { ctx } = makeContext(width, height);
  const pixelSize=Math.max(1,Number(options.pixelSize)||1);
  const smallContext=pixelSize>1?makeContext(Math.max(1,Math.ceil(width/pixelSize)),Math.max(1,Math.ceil(height/pixelSize))).ctx:null;
  const gif = GIFEncoder({ initialCapacity: Math.min(width * height * frames, 8 * 1024 * 1024) });

  for (let index = 0; index < frames; index += 1) {
    throwIfAborted(options.signal);
    const progress = options.reverse ? 1 - (index + 0.5) / frames : (index + 0.5) / frames;
    const at = Math.min(options.start + progress * span, options.end);
    const image = await readFrame(video, ctx, width, height, options.filter, at, index === 0);
    if (options.rotation || options.flipX || options.flipY || options.cropFill || options.background || options.cropRect) {
      drawEditedFrame(ctx, video, width, height, options.filter, options);
    }
    applyPixelation(ctx,smallContext,width,height,pixelSize);
    if(pixelSize>1||options.rotation||options.flipX||options.flipY||options.cropFill||options.background||options.cropRect) image.data.set(ctx.getImageData(0,0,width,height).data);
    throwIfAborted(options.signal);
    const encoded = indexFrame(image, options.colors);
    gif.writeFrame(encoded.index, width, height, {
      palette: encoded.palette,
      delay: delayMsForFrame(index, effectiveFps),
      repeat: 0,
    });
    options.onProgress?.({
      index: index + 1,
      frames,
      ratio: (index + 1) / frames,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throwIfAborted(options.signal);
  gif.finish();
  const bytes = gif.bytes();
  const blob = new Blob([bytes], { type: "image/gif" });
  return { blob, size: bytes.byteLength, frames, width, height };
}
