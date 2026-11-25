import {
  canvasFilter,
  convertToGif,
  estimateBytes,
  formatBytes,
  formatClock,
  frameCount,
  gifDownloadName,
  measureSample,
  outputSize,
  seekTo,
} from "./encode.js";
import {
  clearGalleryRecords,
  deleteGalleryRecord,
  loadGalleryRecords,
  saveGalleryRecord,
} from "./gallery.js";

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|mpeg|mpg|3gp|wmv|qt)$/i;
const FPS_OPTIONS = [10, 15, 24, 30];
const FILTERS = [
  ["none", "원본"],
  ["gray", "흑백"],
  ["sepia", "세피아"],
  ["vivid", "선명"],
  ["fade", "바랜"],
];

const fileInput = document.querySelector("#file-input");
const drop = document.querySelector("#drop");
const filesEl = document.querySelector("#files");
const uploadBar = document.querySelector("#upload-bar");
const resetUploadsBtn = document.querySelector("#reset-uploads");
const resetGalleryBtn = document.querySelector("#reset-gallery");
const openStorageBtn = document.querySelector("#open-storage");
const storageModal = document.querySelector("#storage-modal");
const storageCount = document.querySelector("#storage-count");
const galleryEmpty = document.querySelector("#gallery-empty");
const galleryGrid = document.querySelector("#gallery-grid");
const toasts = document.querySelector("#toasts");
const cards = new Set();
const galleryItems = [];

fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

drop.addEventListener("click", (event) => {
  if (event.target.closest("label, button, a, input")) return;
  fileInput.click();
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  dragDepth += 1;
  document.body.classList.add("is-dragging");
});
window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("is-dragging");
});
window.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("is-dragging");
  addFiles(event.dataTransfer.files);
});

function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function isVideoFile(file) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("audio/") || type.startsWith("image/") || type.startsWith("text/")) return false;
  if (type.startsWith("video/")) return true;
  return VIDEO_EXT.test(file.name || "");
}

function addFiles(list) {
  const incoming = [...(list || [])];
  if (!incoming.length) return;
  const rejected = [];
  incoming.forEach((file) => {
    if (!file || file.size <= 0 || !isVideoFile(file)) rejected.push(file?.name || "이름 없는 파일");
    else {
      try {
        createCard(file);
      } catch (error) {
        console.error("파일 카드 생성 실패:", file.name, error);
        rejected.push(`${file.name} (화면을 만들지 못함)`);
      }
    }
  });
  if (rejected.length) {
    const names = rejected.slice(0, 3).join(", ");
    const extra = rejected.length > 3 ? ` 외 ${rejected.length - 3}개` : "";
    toast(`일부 파일을 추가하지 못했습니다. MP4, WebM, MOV 등 재생 가능한 동영상 파일인지 확인해 주세요. (${names}${extra})`);
  }
  syncChrome();
}

function syncChrome() {
  const hasUploads = cards.size > 0;
  document.body.classList.toggle("has-files", hasUploads);
  uploadBar.hidden = !hasUploads;
}

function toast(message, kind = "warn") {
  const item = document.createElement("div");
  item.className = kind === "ok" ? "toast ok" : "toast";
  item.setAttribute("role", "alert");
  item.textContent = message;
  toasts.append(item);
  setTimeout(() => item.remove(), 4600);
}

function safeFileName(name) {
  const cleaned = String(name || "video.gif").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned || "video.gif";
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `svt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function saveBlob(blob, filename) {
  if (!blob) return;
  const suggestedName = safeFileName(filename);
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const mime = blob.type || "image/gif";
      const extension = suggestedName.split(".").pop().toLowerCase();
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: `${extension.toUpperCase()} 파일`,
          accept: { [mime]: [`.${extension}`] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast(`선택한 위치에 ${extension.toUpperCase()} 파일을 저장했습니다.`, "ok");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function createQueue() {
  let tail = Promise.resolve();
  return function run(task) {
    const result = tail.then(() => task(), () => task());
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function outputFrameCount(state) {
  const speed=Math.max(.1,Number(state.edit.speed)||1);
  return frameCount(state.start,state.end,speed>1?state.fps/speed:state.fps);
}

function outputDimensions(state) {
  const sourceWidth=state.edit.cropRect?.width||state.videoWidth||2;
  const sourceHeight=state.edit.cropRect?.height||state.videoHeight||2;
  const rotated=Math.abs(state.edit.rotation%180)===90;
  if(state.edit.width||state.edit.height) return rotated
    ? {width:state.edit.height||sourceHeight,height:state.edit.width||sourceWidth}
    : {width:state.edit.width||sourceWidth,height:state.edit.height||sourceHeight};
  return rotated
    ? outputSize(sourceHeight,sourceWidth,state.maxWidth)
    : outputSize(sourceWidth,sourceHeight,state.maxWidth);
}

function minGap(state) {
  const gap = Math.max(1 / state.fps, 0.05);
  return Math.min(gap, Math.max(state.duration, 0));
}

function typeLabel(file) {
  if (file.type?.startsWith("video/")) return file.type.slice(6).toUpperCase();
  const ext = (file.name.split(".").pop() || "").toUpperCase();
  return ext || "VIDEO";
}

function hardLimit(state) {
  const frames = outputFrameCount(state);
  const {width,height} = outputDimensions(state);
  const estimate = state.sampleBytes ?? estimateBytes({
    width,
    height,
    frames,
    colors: state.colors,
    grayscale: state.filter === "gray",
  });
  if (!state.ready) return "";
  if (frames > 1200) return "한 번에 1200프레임까지 변환할 수 있습니다. 구간을 줄이거나 프레임 속도를 낮춰 주세요.";
  if (width * height * frames > 120_000_000) return "출력 해상도와 프레임 수가 너무 큽니다. 크기나 구간을 줄여 주세요.";
  if (estimate > 60 * 1024 * 1024) return "예상 용량이 60MB를 넘습니다. 가로 크기나 구간을 줄여 주세요.";
  return "";
}

function softWarning(state) {
  const frames = outputFrameCount(state);
  if (frames > 450) return "프레임이 많아 변환이 오래 걸리고 파일이 커질 수 있습니다.";
  return "";
}

function createCard(file) {
  const state = {
    file,
    url: URL.createObjectURL(file),
    fps: 30,
    filter: "none",
    brightness: 100,
    contrast: 100,
    colors: 128,
    maxWidth: 480,
    edit: { rotation: 0, flipX: false, flipY: false, cropFill: false, background: "#ffffff", speed: 1, reverse: false, pixelSize: 1 },
    start: 0,
    end: 0,
    duration: 0,
    videoWidth: 0,
    videoHeight: 0,
    ready: false,
    removed: false,
    busy: false,
    dragging: null,
    expanded: false,
    sampleBytes: null,
    resultUrl: "",
    staleResult: false,
    filmReady: false,
    filmToken: 0,
    estimateToken: 0,
    cancelBackground: false,
    queue: createQueue(),
    abort: null,
  };

  const card = document.createElement("article");
  card.className = "card";
  card.id = `card-${makeId()}`;
  card.innerHTML = cardTemplate(file);
  filesEl.append(card);
  cards.add(state);
  syncChrome();

  const ui = {
    card,
    meta: card.querySelector("[data-meta]"),
    preview: card.querySelector("[data-preview]"),
    detailsBtn: card.querySelector("[data-action='details']"),
    panel: card.querySelector("[data-panel]"),
    track: card.querySelector("[data-track]"),
    shadeStart: card.querySelector("[data-shade-start]"),
    shadeEnd: card.querySelector("[data-shade-end]"),
    window: card.querySelector("[data-window]"),
    handleStart: card.querySelector("[data-handle='start']"),
    handleEnd: card.querySelector("[data-handle='end']"),
    timeStart: card.querySelector("[data-time-start]"),
    timeEnd: card.querySelector("[data-time-end]"),
    timeSpan: card.querySelector("[data-time-span]"),
    bright: card.querySelector("[data-bright]"),
    brightVal: card.querySelector("[data-bright-val]"),
    contrast: card.querySelector("[data-contrast]"),
    contrastVal: card.querySelector("[data-contrast-val]"),
    width: card.querySelector("[data-width]"),
    widthVal: card.querySelector("[data-width-val]"),
    estimate: card.querySelector("[data-estimate]"),
    frames: card.querySelector("[data-frames]"),
    span: card.querySelector("[data-span]"),
    summary: card.querySelector("[data-summary]"),
    note: card.querySelector("[data-note]"),
    convert: card.querySelector("[data-action='convert']"),
    cancel: card.querySelector("[data-action='cancel']"),
    progressWrap: card.querySelector("[data-progress-wrap]"),
    progress: card.querySelector("[data-progress]"),
    progressBar: card.querySelector("[data-progress-bar]"),
    progressText: card.querySelector("[data-progress-text]"),
    result: card.querySelector("[data-result]"),
    resultImg: card.querySelector("[data-result-img]"),
    resultSize: card.querySelector("[data-result-size]"),
    outName: card.querySelector("[data-outname]"),
    download: card.querySelector("[data-download]"),
    stash: card.querySelector("[data-action='stash']"),
    stale: card.querySelector("[data-stale]"),
    capture: card.querySelector("[data-capture]"),
    editor: card.querySelector("[data-editor]"),
    editorTools: card.querySelector("[data-editor-tools]"),
    editorSettings: card.querySelector("[data-editor-settings]"),
  };
  state.ui = ui;
  ui.editor.hidden = true;
  ui.preview.src = state.url;
  ui.capture.src = state.url;
  ui.preview.muted = true;

  card.querySelector("[data-action='remove']").addEventListener("click", () => removeCard(state));
  ui.detailsBtn.addEventListener("click", () => toggleDetails(state));
  ui.convert.addEventListener("click", () => startConvert(state));
  ui.cancel.addEventListener("click", () => state.abort?.abort());
  ui.download.addEventListener("click", () => { const input=card.querySelector("[data-save-name]"); if(input?.value.trim()) state.downloadName=safeFileName(input.value); saveBlob(state.resultBlob, state.downloadName); });
  card.querySelectorAll("[data-edit-tool]").forEach((button) => button.addEventListener("click", () => showEditTool(state, button.dataset.editTool)));
  card.querySelector("[data-edit-back]").addEventListener("click", () => {
    ui.editorSettings.hidden = true;
    ui.editorTools.hidden = false;
  });
  card.querySelector("[data-edit-go]").addEventListener("click", () => {
    readEditorSettings(state);
    if (card.dataset.editTool === "format" && card.querySelector("[data-format]")?.value === "jpg") {
      exportCurrentFrame(state);
      return;
    }
    if (card.dataset.editTool === "format" && card.querySelector("[data-format]")?.value === "mp4") {
      exportMp4(state);
      return;
    }
    if (hardLimit(state)) {
      toast(hardLimit(state));
      return;
    }
    ui.editorSettings.hidden = true;
    ui.editorTools.hidden = false;
    state.expanded = true;
    ui.panel.hidden = false;
    startConvert(state);
  });
  card.querySelector("[data-combined-go]").addEventListener("click",()=>applyCombinedEdits(state));
  card.querySelectorAll("[data-combo-enable]").forEach(input=>input.addEventListener("change",()=>{
    setCombinedItemEnabled(card,input.dataset.comboEnable,input.checked);
    updateCombinedPreviews(state);
  }));
  card.querySelectorAll("[data-combo-rotate]").forEach(button=>button.addEventListener("click",()=>{
    card.querySelectorAll("[data-combo-rotate]").forEach(item=>{const selected=item===button;item.classList.toggle("selected",selected);item.setAttribute("aria-pressed",String(selected));});
  }));
  const comboSpeed=card.querySelector("[data-combo-speed]"), comboSpeedRange=card.querySelector("[data-combo-speed-range]");
  comboSpeed.addEventListener("input",()=>comboSpeedRange.value=String(clamp(Number(comboSpeed.value)||1,.1,10)));
  comboSpeed.addEventListener("change",()=>comboSpeed.value=comboSpeedRange.value);
  comboSpeedRange.addEventListener("input",()=>comboSpeed.value=comboSpeedRange.value);
  card.querySelector("[data-combo-pixel-size]").addEventListener("input",()=>{
    card.querySelector("[data-combo-pixel-value]").textContent=`${card.querySelector("[data-combo-pixel-size]").value}px`;
    drawPixelPreview(card.querySelector("[data-combo-pixel-preview]"),state,Number(card.querySelector("[data-combo-pixel-size]").value));
  });
  card.querySelectorAll("[data-combo-x],[data-combo-y],[data-combo-down-size],[data-combo-down-frames],[data-combo-down-colors]").forEach(input=>input.addEventListener("input",()=>updateCombinedPreviews(state)));
  card.querySelectorAll("[data-combo-crop-x],[data-combo-crop-y],[data-combo-crop-width],[data-combo-crop-height]").forEach(input=>input.addEventListener("input",()=>updateCombinedPreviews(state)));
  ui.stash.addEventListener("click", () => stashResult(state));
  card.querySelector("[data-action='play-range']").addEventListener("click", () => playRange(state));

  bindChoice(card.querySelector("[data-filters]"), "data-filter", (value) => {
    state.filter = value;
    applyPreviewFilter(state);
    markDirty(state);
  });
  bindChoice(card.querySelector("[data-colors]"), "data-colors", (value) => {
    state.colors = Number(value);
    markDirty(state);
  });
  bindChoice(card.querySelector("[data-fps]"), "data-fps", (value) => {
    state.fps = Number(value);
    markDirty(state);
  });

  ui.bright.addEventListener("input", () => {
    state.brightness = Number(ui.bright.value);
    ui.brightVal.textContent = String(state.brightness);
    applyPreviewFilter(state);
    markDirty(state);
  });
  ui.contrast.addEventListener("input", () => {
    state.contrast = Number(ui.contrast.value);
    ui.contrastVal.textContent = String(state.contrast);
    applyPreviewFilter(state);
    markDirty(state);
  });
  ui.width.addEventListener("input", () => {
    state.maxWidth = Number(ui.width.value);
    ui.widthVal.textContent = `${state.maxWidth}px`;
    markDirty(state);
  });

  bindTrim(state);
  loadMetadata(state);
  return state;
}

function cardTemplate(file) {
  const fpsButtons = FPS_OPTIONS.map((fps) => {
    const checked = fps === 30 ? "true" : "false";
    const badge = fps === 30 ? "<small>기본</small>" : "";
    return `<button type="button" class="chip" role="radio" data-fps="${fps}" aria-checked="${checked}">${fps}${badge}</button>`;
  }).join("");
  const filterButtons = FILTERS.map(([id, label], index) => {
    return `<button type="button" class="chip" role="radio" data-filter="${id}" aria-checked="${index === 0 ? "true" : "false"}">${label}</button>`;
  }).join("");
  return `
    <div class="file-top">
      <div class="file-id">
        <div class="file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <rect x="3" y="4" width="18" height="16" rx="2"></rect>
            <path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"></path>
          </svg>
        </div>
        <div>
          <h2 class="file-name">${escapeHtml(file.name)}</h2>
          <ul class="file-meta" data-meta>
            <li><span>형식</span>${escapeHtml(typeLabel(file))}</li>
            <li><span>크기</span>${escapeHtml(formatBytes(file.size))}</li>
            <li><span>길이</span>읽는 중</li>
            <li><span>해상도</span>읽는 중</li>
          </ul>
        </div>
      </div>
      <div class="file-actions">
        <button type="button" class="btn ghost" data-action="details" aria-expanded="false">세부 조정</button>
      </div>
    </div>
    <button type="button" class="icon-x" data-action="remove" aria-label="이 업로드 파일 삭제">×</button>
    <div class="preview-wrap">
      <video class="preview" data-preview controls playsinline preload="auto"></video>
    </div>
    <div class="editor" data-editor>
      <div class="editor-tools" data-editor-tools>
        <div><strong>빠른 편집</strong><p class="hint">한 가지 기능만 바로 적용하려면 아이콘을 선택하세요.</p></div>
        <div class="editor-icons">
          ${[["resize","크기"],["crop","자르기"],["downsize","용량"],["format","형식"],["rotate","회전"],["optimize","최적화"],["reverse","역재생"],["speed","속도"],["cut","구간"],["pixelate","픽셀화"]].map(([id,label]) => `<button type="button" class="editor-icon" data-edit-tool="${id}" title="${label}"><span>${{resize:"↔",crop:"⌗",downsize:"↓",format:"⇄",rotate:"⟳",optimize:"✧",reverse:"⇄",speed:"◷",cut:"✂",pixelate:"▦"}[id]}</span>${label}</button>`).join("")}
        </div>
      </div>
      <div class="editor-settings" data-editor-settings hidden>
        <h3 data-edit-title>편집</h3>
        <div class="edit-fields" data-edit-fields></div>
        <div class="edit-actions"><button type="button" class="btn ghost" data-edit-back>back</button><button type="button" class="btn primary" data-edit-go>go</button></div>
      </div>
    </div>
    <div class="panel lockable" data-panel hidden>
      <div class="panel-head">
        <div>
          <h3>구간과 화면</h3>
          <p class="hint">양쪽 막대를 드래그하면 그 지점의 영상이 위에 보입니다.</p>
        </div>
        <button type="button" class="btn ghost" data-action="play-range">선택 구간 재생</button>
      </div>
      <div class="trim">
        <div class="trim-track" data-track>
          <div class="trim-shade" data-shade-start></div>
          <div class="trim-shade end" data-shade-end></div>
          <div class="trim-window" data-window></div>
          <button type="button" class="trim-handle" data-handle="start" aria-label="시작 지점"></button>
          <button type="button" class="trim-handle" data-handle="end" aria-label="끝 지점"></button>
        </div>
        <div class="trim-times">
          <span>시작 <strong data-time-start>0:00.0</strong></span>
          <span>길이 <strong data-time-span>0:00.0</strong></span>
          <span>끝 <strong data-time-end>0:00.0</strong></span>
        </div>
      </div>
      <div class="settings">
        <div class="field full">
          <div class="group-label">색 편집</div>
          <div class="chips" role="radiogroup" aria-label="색 편집" data-filters>${filterButtons}</div>
        </div>
        <div class="field">
          <label>밝기 <span data-bright-val>100</span>%</label>
          <input data-bright type="range" min="70" max="140" value="100" />
        </div>
        <div class="field">
          <label>대비 <span data-contrast-val>100</span>%</label>
          <input data-contrast type="range" min="70" max="160" value="100" />
        </div>
        <div class="field">
          <label>최대 가로 크기 <span data-width-val>480px</span></label>
          <input data-width type="range" min="160" max="960" step="20" value="480" />
        </div>
        <div class="field">
          <div class="group-label">색 수</div>
          <div class="chips" role="radiogroup" aria-label="색 수" data-colors>
            <button type="button" class="chip" role="radio" data-colors="64" aria-checked="false">64</button>
            <button type="button" class="chip" role="radio" data-colors="128" aria-checked="true">128</button>
            <button type="button" class="chip" role="radio" data-colors="256" aria-checked="false">256</button>
          </div>
        </div>
      </div>
      <section class="combined-editor" data-combined-editor>
        <div class="combined-head"><div><h3>여러 기능 함께 적용</h3><p class="hint">적용할 기능을 여러 개 선택하고 한 번에 처리합니다. 예: 자르기 + 역재생</p></div><label class="combo-format">출력 형식<select data-combo-format><option value="gif">GIF</option><option value="jpg">JPG</option><option value="mp4" ${!mp4Supported()?"disabled":""}>MP4 ${mp4Supported()?"":"(브라우저 미지원)"}</option></select></label></div>
        <div class="combined-grid">
          <section class="combo-item" data-combo-item="resize"><label class="combo-toggle"><input type="checkbox" data-combo-enable="resize">크기 조절</label><div class="combo-panel"><div class="dimension-preview"><div><small>현재</small><strong data-combo-resize-before>-</strong></div><span>→</span><div><small>변환 후</small><strong data-combo-resize-after>-</strong><small data-combo-resize-ratio></small></div></div><label>X축 <input data-combo-x type="range" min="2" max="4096"><output data-combo-x-value></output></label><label>Y축 <input data-combo-y type="range" min="2" max="4096"><output data-combo-y-value></output></label></div></section>
          <section class="combo-item" data-combo-item="crop"><label class="combo-toggle"><input type="checkbox" data-combo-enable="crop">자르기</label><div class="combo-panel"><div class="combo-crop-preview"><canvas data-combo-crop-canvas></canvas><div data-combo-crop-selection></div></div><div class="crop-number-grid"><label>X<input data-combo-crop-x type="number" min="0" value="0"></label><label>Y<input data-combo-crop-y type="number" min="0" value="0"></label><label>너비<input data-combo-crop-width type="number" min="2" value="0"></label><label>높이<input data-combo-crop-height type="number" min="2" value="0"></label></div><label>빈 공간<select data-combo-crop-fill><option value="solid">배경색으로 채우기</option><option value="zoom">이미지를 확대해 채우기</option></select></label><label>배경색 <input data-combo-background type="color" value="#ffffff"></label></div></section>
          <section class="combo-item" data-combo-item="downsize"><label class="combo-toggle"><input type="checkbox" data-combo-enable="downsize">용량 줄이기</label><div class="combo-panel"><label><input type="checkbox" data-combo-down-size checked> 출력 크기 75%</label><label><input type="checkbox" data-combo-down-frames> 프레임 수 절반</label><label><input type="checkbox" data-combo-down-colors> 64색으로 축소</label><div class="estimate-compare"><div><small>현재 예상</small><strong data-combo-size-before>-</strong></div><span>→</span><div><small>적용 후 예상</small><strong data-combo-size-after>-</strong><small data-combo-size-saved></small></div></div></div></section>
          <section class="combo-item" data-combo-item="rotate"><label class="combo-toggle"><input type="checkbox" data-combo-enable="rotate">회전·뒤집기</label><div class="combo-panel"><div class="chips">${[0,90,180,270].map(n=>`<button type="button" class="chip" data-combo-rotate="${n}" aria-pressed="${n===0}">${n}°</button>`).join("")}</div><label><input type="checkbox" data-combo-flip-x> 좌우 뒤집기</label><label><input type="checkbox" data-combo-flip-y> 상하 뒤집기</label></div></section>
          <section class="combo-item" data-combo-item="optimize"><label class="combo-toggle"><input type="checkbox" data-combo-enable="optimize">GIF 최적화</label><div class="combo-panel"><label>최대 색상<select data-combo-colors><option value="256">256</option><option value="192">192</option><option value="128">128</option><option value="64">64</option></select></label></div></section>
          <section class="combo-item" data-combo-item="reverse"><label class="combo-toggle"><input type="checkbox" data-combo-enable="reverse">역재생</label><div class="combo-panel"><p>선택 구간을 거꾸로 재생하도록 GIF 프레임 순서를 바꿉니다.</p></div></section>
          <section class="combo-item" data-combo-item="pixelate"><label class="combo-toggle"><input type="checkbox" data-combo-enable="pixelate">픽셀화</label><div class="combo-panel"><div class="pixel-preview"><canvas data-combo-pixel-preview></canvas></div><label>도트 크기 <output data-combo-pixel-value>8px</output><input data-combo-pixel-size type="range" min="2" max="32" step="1" value="8"></label><p>크기를 키우면 도트가 커지고 더 픽셀아트처럼 보입니다.</p></div></section>
          <section class="combo-item" data-combo-item="speed"><label class="combo-toggle"><input type="checkbox" data-combo-enable="speed">속도 조절</label><div class="combo-panel speed-control"><label>배속<input data-combo-speed type="number" min="0.1" max="10" step="0.1" value="1">×</label><input data-combo-speed-range type="range" min="0.1" max="10" step="0.1" value="1"><p>최대 10×</p></div></section>
          <section class="combo-item" data-combo-item="cut"><label class="combo-toggle"><input type="checkbox" data-combo-enable="cut" checked>선택 구간 자르기</label><div class="combo-panel"><p>위 타임라인에서 선택한 시작과 끝 시각을 사용합니다.</p></div></section>
        </div>
        <div class="combined-actions"><button type="button" class="btn primary" data-combined-go>선택 기능 함께 적용 · go</button></div>
      </section>
    </div>
    <div class="convert-box">
      <div class="field lockable">
        <div class="group-label">출력 프레임 속도 <span>30fps 기본</span></div>
        <div class="chips" role="radiogroup" aria-label="출력 프레임 속도" data-fps>${fpsButtons}</div>
        <p class="hint">원본에서 프레임을 다시 뽑아 선택한 속도로 GIF를 만듭니다. 30을 고르면 1초에 30장이고, GIF 시간 단위에 맞춰 평균 30fps가 됩니다.</p>
      </div>
      <div class="stat-row">
        <div class="stat"><span>예상 용량</span><strong data-estimate>계산 중</strong></div>
        <div class="stat"><span>출력 프레임</span><strong data-frames>-</strong></div>
        <div class="stat"><span>변환 길이</span><strong data-span>-</strong></div>
      </div>
      <div class="convert-actions">
        <p class="summary" data-summary>프레임 정보를 읽고 있습니다.</p>
        <button type="button" class="btn primary wide" data-action="convert" disabled>GIF로 변환</button>
      </div>
      <p class="note warn" data-note hidden></p>
      <div class="progress-wrap" data-progress-wrap hidden>
        <div class="progress" data-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="progress-bar" data-progress-bar></div>
        </div>
        <p class="progress-text" data-progress-text></p>
        <button type="button" class="btn ghost" data-action="cancel" hidden>취소</button>
      </div>
    </div>
    <div class="result" data-result hidden>
      <img data-result-img alt="변환된 GIF 미리보기" />
      <video class="result-video" data-result-video controls playsinline hidden></video>
      <div class="result-row">
        <div>
          <div class="stat"><span>변환 후 용량</span><strong data-result-size>-</strong></div>
          <label class="save-name-label">저장 파일 이름 <input data-save-name value="${escapeHtml(gifDownloadName(file.name))}" maxlength="120" /></label>
          <p class="out-name" data-outname></p>
          <p class="note info" data-stale hidden>설정이 바뀌었습니다. 다시 변환하면 새 GIF를 받을 수 있습니다.</p>
        </div>
        <div class="result-actions">
          <button type="button" class="btn primary" data-download>다운로드</button>
          <button type="button" class="btn ghost" data-action="stash">임시저장</button>
        </div>
      </div>
    </div>
    <video class="capture-bin" data-capture muted playsinline preload="auto" aria-hidden="true"></video>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function bindChoice(container, attribute, onChange) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest(`[${attribute}]`);
    if (!button || !container.contains(button)) return;
    container.querySelectorAll(`[${attribute}]`).forEach((item) => {
      item.setAttribute("aria-checked", item === button ? "true" : "false");
    });
    onChange(button.getAttribute(attribute));
  });
}

function bindTrim(state) {
  const onDown=(event)=>{
    const handle=event.target.closest("[data-handle]"), track=event.target.closest("[data-track],[data-edit-track]");
    if(!track||!state.ready||state.busy) return;
    if(handle) { state.dragging=handle.dataset.handle; state.dragTrack=track; handle.setPointerCapture?.(event.pointerId); return; }
    state.dragTrack=track;
    const time=timeFromPointer(state,event,track);
    state.dragging=Math.abs(time-state.start)<=Math.abs(time-state.end)?"start":"end";
    moveTrim(state,time);
  };
  const onKeyDown=(event)=>{
    const handle=event.target.closest("[data-handle]");
    if(!handle||(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")||!state.ready||state.busy) return;
    event.preventDefault();
    const direction=event.key==="ArrowLeft"?-1:1, step=event.shiftKey?1:.1, edge=handle.dataset.handle;
    state.dragTrack=handle.closest("[data-track],[data-edit-track]");
    moveTrim(state,(edge==="start"?state.start:state.end)+direction*step,edge);
    markDirty(state);
  };
  state.ui.card.addEventListener("pointerdown",onDown);
  state.ui.card.addEventListener("keydown",onKeyDown);
  const onMove = (event) => {
    if (!state.dragging) return;
    moveTrim(state, timeFromPointer(state, event, state.dragTrack));
  };
  const onUp = () => {
    if (!state.dragging) return;
    state.dragging = null;
    state.dragTrack=null;
    markDirty(state);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  state.unbindTrim = () => {
    state.ui.card.removeEventListener("pointerdown",onDown);
    state.ui.card.removeEventListener("keydown",onKeyDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
}

function timeFromPointer(state, event, track = state.ui.track) {
  const rect = track.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  return ratio * state.duration;
}

function moveTrim(state, time, edge = state.dragging) {
  const gap = minGap(state);
  if (edge === "start") state.start = clamp(time, 0, Math.max(0, state.end - gap));
  else state.end = clamp(time, Math.min(state.duration, state.start + gap), state.duration);
  updateTrim(state);
  updateNumbers(state);
  const previewAt = edge === "start" ? state.start : state.end;
  const preview = state.ui.preview;
  if (Math.abs(preview.currentTime - previewAt) > 0.03) preview.currentTime = previewAt;
}

function updateTrim(state) {
  const duration = state.duration || 1;
  const start = (state.start / duration) * 100;
  const end = (state.end / duration) * 100;
  const tracks=[...state.ui.card.querySelectorAll("[data-track],[data-edit-track]")];
  tracks.forEach(track=>{
    track.querySelector("[data-shade-start]").style.width=`${start}%`;
    track.querySelector("[data-shade-end]").style.width=`${Math.max(0,100-end)}%`;
    track.querySelector("[data-window]").style.left=`${start}%`;
    track.querySelector("[data-window]").style.width=`${Math.max(0,end-start)}%`;
    track.querySelector('[data-handle="start"]').style.left=`${start}%`;
    track.querySelector('[data-handle="end"]').style.left=`${end}%`;
  });
  state.ui.card.querySelectorAll("[data-time-start]").forEach(el=>el.textContent=formatClock(state.start));
  state.ui.card.querySelectorAll("[data-time-end]").forEach(el=>el.textContent=formatClock(state.end));
  state.ui.card.querySelectorAll("[data-time-span]").forEach(el=>el.textContent=formatClock(state.end-state.start));
  const cutStart=state.ui.card.querySelector("[data-cut-start]"), cutEnd=state.ui.card.querySelector("[data-cut-end]");
  if(cutStart&&document.activeElement!==cutStart) cutStart.value=state.start.toFixed(1);
  if(cutEnd&&document.activeElement!==cutEnd) cutEnd.value=state.end.toFixed(1);
}

function applyPreviewFilter(state) {
  state.ui.preview.style.filter = canvasFilter(state);
}

function markDirty(state) {
  state.sampleBytes = null;
  state.sampleFailed = false;
  if (state.resultUrl) {
    state.staleResult = true;
    state.ui.stale.hidden = false;
  }
  updateNumbers(state);
  scheduleEstimate(state);
}

function updateNumbers(state) {
  const frames = state.ready ? outputFrameCount(state) : 0;
  const size = outputDimensions(state);
  const heuristic = estimateBytes({
    width: size.width,
    height: size.height,
    frames: Math.max(frames, 1),
    colors: state.colors,
    grayscale: state.filter === "gray",
  });
  state.ui.estimate.textContent = state.sampleBytes
    ? formatBytes(state.sampleBytes)
    : state.sampleFailed
      ? `약 ${formatBytes(heuristic)}`
      : "계산 중";
  state.ui.frames.textContent = state.ready ? `${frames}장` : "-";
  state.ui.span.textContent = state.ready ? formatClock(state.end - state.start) : "-";
  state.ui.summary.textContent = state.ready
    ? `${state.fps}fps · ${size.width}×${size.height} · ${formatClock(state.start)}–${formatClock(state.end)}`
    : "프레임 정보를 읽고 있습니다.";
  const blocked = hardLimit(state);
  const warn = blocked || softWarning(state);
  state.ui.note.hidden = !warn;
  state.ui.note.textContent = warn;
  state.ui.note.className = blocked ? "note error" : "note warn";
  state.ui.convert.disabled = !state.ready || state.busy || Boolean(blocked);
  state.ui.convert.textContent = state.resultUrl ? "다시 변환" : "GIF로 변환";
}

function scheduleEstimate(state) {
  clearTimeout(state.estimateTimer);
  if (!state.ready || state.removed) return;
  const token = ++state.estimateToken;
  state.estimateTimer = setTimeout(() => {
    state.queue(async () => {
      if (state.removed || state.cancelBackground || token !== state.estimateToken) return;
      try {
        const bytes = await measureSample(state.ui.capture, {
          ...optionsFrom(state),
          isCancelled: () => state.removed || state.cancelBackground || token !== state.estimateToken,
        });
        if (!bytes || token !== state.estimateToken || state.cancelBackground) return;
        state.sampleBytes = bytes;
        updateNumbers(state);
      } catch {
        if (!state.removed && token === state.estimateToken) {
          state.sampleFailed = true;
          updateNumbers(state);
        }
      }
    });
  }, 350);
}

function optionsFrom(state) {
  return {
    videoWidth: state.videoWidth,
    videoHeight: state.videoHeight,
    maxWidth: state.maxWidth,
    start: state.start,
    end: state.end,
    fps: state.fps,
    filter: canvasFilter(state),
    colors: state.colors,
    width: state.edit.width,
    height: state.edit.height,
    rotation: state.edit.rotation,
    flipX: state.edit.flipX,
    flipY: state.edit.flipY,
    cropFill: state.edit.cropFill,
    background: state.edit.background,
    reverse: state.edit.reverse,
    speed: state.edit.speed,
    cropRect: state.edit.cropRect,
    pixelSize: state.edit.pixelSize,
  };
}

async function loadMetadata(state) {
  try {
    await Promise.all([ensureMetadata(state.ui.preview), ensureMetadata(state.ui.capture)]);
    let duration = await normalizeDuration(state.ui.capture);
    if (!usableDuration(state.ui.preview.duration)) {
      const previewDuration = await normalizeDuration(state.ui.preview);
      if (usableDuration(previewDuration)) duration = previewDuration;
    }
    if (Math.abs(state.ui.preview.currentTime) > 0.05) state.ui.preview.currentTime = 0;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("이 브라우저에서 재생할 수 없는 동영상입니다. mp4 또는 webm 파일을 사용해 주세요.");
    }
    if (!state.ui.preview.videoWidth) {
      throw new Error("이 브라우저에서 재생할 수 없는 동영상입니다. mp4 또는 webm 파일을 사용해 주세요.");
    }
    state.duration = duration;
    state.end = duration;
    state.videoWidth = state.ui.preview.videoWidth;
    state.videoHeight = state.ui.preview.videoHeight;
    state.ready = true;
    state.ui.editor.hidden = false;
    initializeCombinedEditor(state);
    state.ui.meta.innerHTML = `
      <li><span>형식</span>${escapeHtml(typeLabel(state.file))}</li>
      <li><span>크기</span>${escapeHtml(formatBytes(state.file.size))}</li>
      <li><span>길이</span>${escapeHtml(formatClock(duration))}</li>
      <li><span>해상도</span>${state.videoWidth}×${state.videoHeight}</li>
    `;
    updateTrim(state);
    updateNumbers(state);
    scheduleEstimate(state);
  } catch (error) {
    if (state.removed) return;
    state.ui.note.hidden = false;
    state.ui.note.className = "note error";
    state.ui.note.textContent = error.message || "동영상 정보를 읽지 못했습니다.";
    state.ui.convert.disabled = true;
  }
}

function ensureMetadata(video) {
  const unsupported = new Error("이 브라우저에서 재생할 수 없는 동영상입니다. mp4 또는 webm 파일을 사용해 주세요.");
  if (video.error) return Promise.reject(unsupported);
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("동영상 정보를 읽지 못했습니다.")), 8000);
    const ok = () => finish();
    const bad = () => finish(unsupported);
    const finish = (error) => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", bad);
      if (error) reject(error);
      else resolve();
    };
    video.addEventListener("loadedmetadata", ok);
    video.addEventListener("error", bad);
    if (video.readyState >= 1) finish();
  });
}

async function normalizeDuration(video) {
  if (usableDuration(video.duration)) return video.duration;
  await seekTo(video, 1e101);
  if (usableDuration(video.duration)) return video.duration;
  if (video.seekable?.length) {
    const end = video.seekable.end(video.seekable.length - 1);
    if (usableDuration(end)) return end;
  }
  await seekTo(video, 0);
  return video.duration;
}

function usableDuration(value) {
  return Number.isFinite(value) && value > 0;
}

function toggleDetails(state) {
  state.expanded = !state.expanded;
  state.ui.panel.hidden = !state.expanded;
  state.ui.detailsBtn.setAttribute("aria-expanded", String(state.expanded));
  if (state.expanded && state.ready && !state.filmReady) buildFilmstrip(state);
}

function showEditTool(state, tool) {
  const ui = state.ui;
  const titles = { resize:"크기 조절", crop:"자르기", downsize:"용량 줄이기", format:"형식 변환", rotate:"회전", optimize:"GIF 최적화", reverse:"역재생", speed:"속도", cut:"구간 자르기", pixelate:"픽셀화" };
  const current=outputDimensions(state), currentWidth=current.width, currentHeight=current.height;
  const crop=state.edit.cropRect||{x:0,y:0,width:state.videoWidth,height:state.videoHeight};
  const fill = `
    <label><input type="radio" name="crop-mode-${state.ui.card.id}" value="solid" ${state.edit.cropFill ? "" : "checked"}> 빈 공간을 단색으로 채우기</label>
    <label><input type="radio" name="crop-mode-${state.ui.card.id}" value="zoom" ${state.edit.cropFill ? "checked" : ""}> 이미지를 확대해 빈 공간 없애기</label>
    <label>배경색 <input data-edit-bg type="color" value="${state.edit.background}"></label>`;
  const contents = {
    resize:`<div class="dimension-preview"><div><small>현재 크기</small><strong>${currentWidth} × ${currentHeight}</strong></div><span>→</span><div><small>변환 후</small><strong data-resize-output>${currentWidth} × ${currentHeight}</strong><small data-resize-ratio></small></div></div><label>X축 <output data-xval>${currentWidth}px</output><input data-x type="range" min="${Math.max(2,Math.round(currentWidth*.05))}" max="${Math.max(2,Math.round(currentWidth*3))}" value="${currentWidth}"></label><label>Y축 <output data-yval>${currentHeight}px</output><input data-y type="range" min="${Math.max(2,Math.round(currentHeight*.05))}" max="${Math.max(2,Math.round(currentHeight*3))}" value="${currentHeight}"></label>`,
    crop:`<p>테두리 안쪽이 결과에 남습니다. 안쪽을 끌어 위치를 옮기고 오른쪽 아래 모서리를 끌어 크기를 바꾸거나, X/Y와 너비/높이를 픽셀로 입력하세요.</p><div class="crop-tool-preview"><canvas data-crop-preview></canvas><div class="crop-selection" data-crop-selection><button type="button" class="crop-resize-handle" data-crop-resize aria-label="자르기 영역 크기 조절"></button></div></div><label>비율 고정<select data-ratio><option value="free">자유</option><option value="original">원본 비율</option><option>1:1</option><option>4:3</option><option>16:9</option></select></label><div class="crop-number-grid"><label>X 시작<input data-crop-x type="number" min="0" max="${state.videoWidth}" value="${Math.round(crop.x)}"></label><label>Y 시작<input data-crop-y type="number" min="0" max="${state.videoHeight}" value="${Math.round(crop.y)}"></label><label>너비<input data-crop-width type="number" min="2" max="${state.videoWidth}" value="${Math.round(crop.width)}"></label><label>높이<input data-crop-height type="number" min="2" max="${state.videoHeight}" value="${Math.round(crop.height)}"></label></div>${fill}`,
    downsize:`<label><input type="checkbox" data-down-size checked> 출력 크기 줄이기 (75%)</label><label><input type="checkbox" data-down-frames> 프레임 수 절반으로 줄이기</label><label><input type="checkbox" data-down-colors> 색상 수 줄이기 (64색)</label><div class="estimate-compare"><div><small>현재 예상</small><strong data-down-before>계산 중</strong></div><span>→</span><div><small>적용 후 예상</small><strong data-down-after>계산 중</strong><small data-down-saving></small></div></div>`,
    format:`<label>저장 형식 <select data-format><option value="gif">GIF</option><option value="jpg">JPG (현재 프레임)</option><option value="mp4" ${!mp4Supported()?"disabled":""}>MP4 ${mp4Supported()?"":"(브라우저 미지원)"}</option></select></label>`,
    rotate:`<p>선택한 회전·뒤집기 버튼이 파란색으로 표시됩니다.</p><div class="chips">${[0,90,180,270].map(n=>`<button type="button" class="chip ${state.edit.rotation===n?"selected":""}" aria-pressed="${state.edit.rotation===n}" data-rotate="${n}">${n}°</button>`).join("")}</div><button type="button" class="chip ${state.edit.flipX?"selected":""}" aria-pressed="${state.edit.flipX}" data-flip="flipX">좌우 뒤집기</button><button type="button" class="chip ${state.edit.flipY?"selected":""}" aria-pressed="${state.edit.flipY}" data-flip="flipY">상하 뒤집기</button>`,
    optimize:`<p>원본 영상에서 프레임을 다시 추출하고 색상 수를 유지해 GIF 용량을 최적화합니다.</p><label>최대 색상 <select data-opt-colors><option value="256" selected>256 (품질 우선)</option><option value="192">192</option><option value="128">128</option></select></label>`,
    reverse:`<label><input type="checkbox" data-reverse> 애니메이션 역재생</label><p>원본 동영상에서 프레임을 다시 만들어 저장합니다.</p>`,
    speed:`<div class="speed-control"><label>배속 <input data-speed-number type="number" min="0.1" max="10" step="0.1" value="${state.edit.speed}">×</label><input data-speed-range type="range" min="0.1" max="10" step="0.1" value="${state.edit.speed}"><p>0.1×부터 최대 10×까지 0.1 단위로 지정할 수 있습니다. 빠른 배속은 프레임을 건너뛰어 반영합니다.</p></div>`,
    pixelate:`<div class="pixel-preview"><canvas data-pixel-preview></canvas></div><label>도트 크기 <output data-pixel-value>${state.edit.pixelSize>1?state.edit.pixelSize:8}px</output><input data-pixel-size type="range" min="2" max="32" step="1" value="${state.edit.pixelSize>1?state.edit.pixelSize:8}"></label><p>값이 클수록 도트가 커져 픽셀아트 느낌이 강해집니다.</p>`,
    cut:`<div class="trim"><div class="trim-track" data-edit-track><div class="trim-shade" data-shade-start></div><div class="trim-shade end" data-shade-end></div><div class="trim-window" data-window></div><button type="button" class="trim-handle" data-handle="start" aria-label="구간 시작"></button><button type="button" class="trim-handle" data-handle="end" aria-label="구간 끝"></button></div><div class="trim-times"><span>시작 <strong data-time-start>${formatClock(state.start)}</strong></span><span>길이 <strong data-time-span>${formatClock(state.end-state.start)}</strong></span><span>끝 <strong data-time-end>${formatClock(state.end)}</strong></span></div></div><div class="crop-number-grid"><label>시작 시간 (초)<input data-cut-start type="number" min="0" max="${state.duration}" step="0.1" value="${state.start.toFixed(1)}"></label><label>끝 시간 (초)<input data-cut-end type="number" min="0" max="${state.duration}" step="0.1" value="${state.end.toFixed(1)}"></label></div><button type="button" class="btn ghost" data-edit-play-range>선택 구간 재생</button>`,
  };
  ui.editorTools.hidden = true;
  ui.editorSettings.hidden = false;
  ui.card.querySelector("[data-edit-title]").textContent = titles[tool];
  ui.card.querySelector("[data-edit-fields]").innerHTML = contents[tool];
  ui.card.dataset.editTool = tool;
  ui.card.dataset.resizeBaseWidth=String(currentWidth); ui.card.dataset.resizeBaseHeight=String(currentHeight);
  ui.card.querySelectorAll("[data-rotate]").forEach(b=>b.addEventListener("click",()=>{state.edit.rotation=Number(b.dataset.rotate);ui.card.querySelectorAll("[data-rotate]").forEach(x=>x.classList.toggle("selected",x===b));}));
  ui.card.querySelectorAll("[data-rotate]").forEach(b=>b.addEventListener("click",()=>{ui.card.querySelectorAll("[data-rotate]").forEach(x=>{const selected=x===b;x.classList.toggle("selected",selected);x.setAttribute("aria-pressed",String(selected));});}));
  ui.card.querySelectorAll("[data-flip]").forEach(b=>b.addEventListener("click",()=>{state.edit[b.dataset.flip]=!state.edit[b.dataset.flip];b.classList.toggle("selected",state.edit[b.dataset.flip]);b.setAttribute("aria-pressed",String(state.edit[b.dataset.flip]));}));
  ui.card.querySelector("[data-x]")?.addEventListener("input",e=>ui.card.querySelector("[data-xval]").textContent=`${e.target.value}px`);
  ui.card.querySelector("[data-y]")?.addEventListener("input",e=>ui.card.querySelector("[data-yval]").textContent=`${e.target.value}px`);
  ui.card.querySelectorAll("[data-x],[data-y]").forEach(input=>input.addEventListener("input",()=>updateResizePreview(state)));
  if(tool==="resize") updateResizePreview(state);
  if(tool==="crop") bindCropEditor(state);
  if(tool==="downsize") {
    ui.card.querySelectorAll("[data-down-size],[data-down-frames],[data-down-colors]").forEach(input=>input.addEventListener("change",()=>updateDownsizePreview(state)));
    updateDownsizePreview(state);
  }
  const speedNumber=ui.card.querySelector("[data-speed-number]"), speedRange=ui.card.querySelector("[data-speed-range]");
  speedNumber?.addEventListener("input",()=>{speedRange.value=String(clamp(Number(speedNumber.value)||1,.1,10));});
  speedNumber?.addEventListener("change",()=>{speedNumber.value=speedRange.value;});
  speedRange?.addEventListener("input",()=>{speedNumber.value=speedRange.value;});
  const pixelSize=ui.card.querySelector("[data-pixel-size]");
  pixelSize?.addEventListener("input",()=>{ui.card.querySelector("[data-pixel-value]").textContent=`${pixelSize.value}px`;drawPixelPreview(ui.card.querySelector("[data-pixel-preview]"),state,Number(pixelSize.value));});
  if(tool==="pixelate") drawPixelPreview(ui.card.querySelector("[data-pixel-preview]"),state,Number(pixelSize.value));
  ui.card.querySelectorAll("[data-cut-start],[data-cut-end]").forEach(input=>input.addEventListener("input",()=>updateCutFromFields(state)));
  ui.card.querySelector("[data-edit-play-range]")?.addEventListener("click",()=>playRange(state));
  if(tool==="cut"&&!state.filmReady) buildFilmstrip(state);
}

function updateResizePreview(state) {
  const root=state.ui.card, width=Number(root.querySelector("[data-x]")?.value)||state.videoWidth, height=Number(root.querySelector("[data-y]")?.value)||state.videoHeight;
  const output=root.querySelector("[data-resize-output]"), ratio=root.querySelector("[data-resize-ratio]");
  if(output) output.textContent=`${width} × ${height}`;
  if(ratio) ratio.textContent=`가로 ${Math.round(width/Number(root.dataset.resizeBaseWidth)*100)}% · 세로 ${Math.round(height/Number(root.dataset.resizeBaseHeight)*100)}%`;
}

function updateCropPreview(state) {
  const root=state.ui.card, x=Number(root.querySelector("[data-crop-x]")?.value)||0, y=Number(root.querySelector("[data-crop-y]")?.value)||0;
  const width=Number(root.querySelector("[data-crop-width]")?.value)||state.videoWidth, height=Number(root.querySelector("[data-crop-height]")?.value)||state.videoHeight;
  const selection=root.querySelector("[data-crop-selection]");
  if(selection) { selection.style.left=`${x/state.videoWidth*100}%`; selection.style.top=`${y/state.videoHeight*100}%`; selection.style.width=`${width/state.videoWidth*100}%`; selection.style.height=`${height/state.videoHeight*100}%`; }
}

function bindCropEditor(state) {
  const root=state.ui.card, canvas=root.querySelector("[data-crop-preview]"), ctx=canvas?.getContext("2d");
  if(canvas&&ctx) { canvas.width=320; canvas.height=Math.max(80,Math.round(320*state.videoHeight/state.videoWidth)); ctx.drawImage(state.ui.preview,0,0,canvas.width,canvas.height); }
  const sync=()=>{
    const x=Math.round(clamp(Number(root.querySelector("[data-crop-x]").value)||0,0,state.videoWidth-2));
    const y=Math.round(clamp(Number(root.querySelector("[data-crop-y]").value)||0,0,state.videoHeight-2));
    const width=Math.round(clamp(Number(root.querySelector("[data-crop-width]").value)||2,2,state.videoWidth-x));
    const height=Math.round(clamp(Number(root.querySelector("[data-crop-height]").value)||2,2,state.videoHeight-y));
    root.querySelector("[data-crop-x]").value=x; root.querySelector("[data-crop-y]").value=y;
    root.querySelector("[data-crop-width]").value=width; root.querySelector("[data-crop-height]").value=height;
    state.edit.cropRect={x,y,width,height}; updateCropPreview(state);
  };
  const selection=root.querySelector("[data-crop-selection]");
  selection.addEventListener("pointerdown",event=>{
    event.preventDefault(); selection.setPointerCapture(event.pointerId);
    const box={...state.edit.cropRect}, rect=canvas.getBoundingClientRect(), startX=event.clientX, startY=event.clientY;
    const resizing=Boolean(event.target.closest("[data-crop-resize]"));
    const onMove=move=>{
      const dx=(move.clientX-startX)/Math.max(rect.width,1)*state.videoWidth, dy=(move.clientY-startY)/Math.max(rect.height,1)*state.videoHeight;
      if(resizing) { root.querySelector("[data-crop-width]").value=Math.round(clamp(box.width+dx,2,state.videoWidth-box.x)); root.querySelector("[data-crop-height]").value=Math.round(clamp(box.height+dy,2,state.videoHeight-box.y)); }
      else { root.querySelector("[data-crop-x]").value=Math.round(clamp(box.x+dx,0,state.videoWidth-box.width)); root.querySelector("[data-crop-y]").value=Math.round(clamp(box.y+dy,0,state.videoHeight-box.height)); }
      sync();
    };
    const onUp=()=>{selection.removeEventListener("pointermove",onMove);selection.removeEventListener("pointerup",onUp);selection.removeEventListener("pointercancel",onUp);};
    selection.addEventListener("pointermove",onMove); selection.addEventListener("pointerup",onUp); selection.addEventListener("pointercancel",onUp);
  });
  root.querySelectorAll("[data-crop-x],[data-crop-y],[data-crop-width],[data-crop-height]").forEach(input=>input.addEventListener("input",sync));
  root.querySelector("[data-ratio]").addEventListener("change",()=>{
    const value=root.querySelector("[data-ratio]").value;
    if(value==="free") return;
    const ratio=value==="original"?state.videoWidth/state.videoHeight:value.split(":").map(Number).reduce((a,b)=>a/b);
    const maxW=state.videoWidth-Number(root.querySelector("[data-crop-x]").value), maxH=state.videoHeight-Number(root.querySelector("[data-crop-y]").value);
    const area=Number(root.querySelector("[data-crop-width]").value)*Number(root.querySelector("[data-crop-height]").value);
    let width=Math.min(maxW,Math.sqrt(area*ratio)), height=width/ratio;
    if(height>maxH){height=maxH;width=height*ratio;}
    root.querySelector("[data-crop-width]").value=Math.max(2,Math.round(width)); root.querySelector("[data-crop-height]").value=Math.max(2,Math.round(height)); sync();
  });
  sync();
}

function updateDownsizePreview(state) {
  const root=state.ui.card, beforeSize=outputDimensions(state), frames=outputFrameCount(state);
  const before=state.resultBlob?.type==="image/gif"?state.resultBlob.size:estimateBytes({width:beforeSize.width,height:beforeSize.height,frames,colors:state.colors,grayscale:state.filter==="gray"});
  let width=beforeSize.width,height=beforeSize.height,afterFrames=frames,colors=state.colors;
  if(root.querySelector("[data-down-size]")?.checked){width=Math.max(2,Math.round(width*.75));height=Math.max(2,Math.round(height*.75));}
  if(root.querySelector("[data-down-frames]")?.checked){const fps=Math.max(10,Math.round(state.fps/2)),speed=Math.max(.1,Number(state.edit.speed)||1);afterFrames=frameCount(state.start,state.end,speed>1?fps/speed:fps);}
  if(root.querySelector("[data-down-colors]")?.checked) colors=64;
  const after=estimateBytes({width,height,frames:Math.max(1,afterFrames),colors,grayscale:state.filter==="gray"});
  root.querySelector("[data-down-before]").textContent=`약 ${formatBytes(before)}`;
  root.querySelector("[data-down-after]").textContent=`약 ${formatBytes(after)}`;
  const saved=Math.max(0,Math.round((1-after/Math.max(before,1))*100));
  root.querySelector("[data-down-saving]").textContent=after<=before?`약 ${saved}% 감소`:`약 ${formatBytes(after-before)} 증가`;
}

function updateCutFromFields(state) {
  const root=state.ui.card, gap=minGap(state);
  const start=root.querySelector("[data-cut-start]"), end=root.querySelector("[data-cut-end]");
  state.start=clamp(Number(start.value)||0,0,Math.max(0,state.duration-gap));
  state.end=clamp(Number(end.value)||state.duration,state.start+gap,state.duration);
  updateTrim(state); markDirty(state);
}

function setCombinedItemEnabled(card,name,enabled) {
  const item=card.querySelector(`[data-combo-item="${name}"]`);
  if(!item) return;
  item.classList.toggle("is-enabled",enabled);
  item.querySelectorAll(".combo-panel input,.combo-panel select,.combo-panel button").forEach(control=>control.disabled=!enabled);
}

function initializeCombinedEditor(state) {
  const card=state.ui.card, dimensions=outputDimensions(state);
  const cropCanvas=card.querySelector("[data-combo-crop-canvas]");
  cropCanvas.width=260;cropCanvas.height=Math.max(80,Math.round(260*state.videoHeight/state.videoWidth));
  cropCanvas.getContext("2d").drawImage(state.ui.preview,0,0,cropCanvas.width,cropCanvas.height);
  const resizeX=card.querySelector("[data-combo-x]"), resizeY=card.querySelector("[data-combo-y]");
  [[resizeX,dimensions.width],[resizeY,dimensions.height]].forEach(([input,value])=>{
    input.min=String(Math.max(2,Math.round(value*.05))); input.max=String(Math.min(4096,Math.round(value*3))); input.value=String(value);
  });
  const crop=state.edit.cropRect||{x:0,y:0,width:state.videoWidth,height:state.videoHeight};
  card.querySelector("[data-combo-crop-x]").value=String(Math.round(crop.x));
  card.querySelector("[data-combo-crop-y]").value=String(Math.round(crop.y));
  card.querySelector("[data-combo-crop-width]").value=String(Math.round(crop.width));
  card.querySelector("[data-combo-crop-height]").value=String(Math.round(crop.height));
  card.querySelector('[data-combo-enable="resize"]').checked=Boolean(state.edit.width||state.edit.height);
  card.querySelector('[data-combo-enable="crop"]').checked=Boolean(state.edit.cropRect);
  card.querySelector('[data-combo-enable="rotate"]').checked=Boolean(state.edit.rotation||state.edit.flipX||state.edit.flipY);
  card.querySelector('[data-combo-enable="reverse"]').checked=Boolean(state.edit.reverse);
  card.querySelector('[data-combo-enable="speed"]').checked=Number(state.edit.speed)!==1;
  card.querySelector('[data-combo-enable="cut"]').checked=true;
  card.querySelector("[data-combo-background]").value=state.edit.background||"#ffffff";
  card.querySelector("[data-combo-crop-fill]").value=state.edit.cropFill?"zoom":"solid";
  card.querySelector("[data-combo-colors]").value=String(state.colors);
  card.querySelector("[data-combo-speed]").value=String(state.edit.speed||1);
  card.querySelector("[data-combo-speed-range]").value=String(state.edit.speed||1);
  card.querySelector('[data-combo-enable="pixelate"]').checked=Number(state.edit.pixelSize)>1;
  card.querySelector("[data-combo-pixel-size]").value=String(state.edit.pixelSize>1?state.edit.pixelSize:8);
  card.querySelector("[data-combo-pixel-value]").textContent=`${card.querySelector("[data-combo-pixel-size]").value}px`;
  card.querySelector("[data-combo-flip-x]").checked=Boolean(state.edit.flipX);
  card.querySelector("[data-combo-flip-y]").checked=Boolean(state.edit.flipY);
  card.querySelectorAll("[data-combo-rotate]").forEach(button=>{
    const selected=Number(button.dataset.comboRotate)===Number(state.edit.rotation||0);
    button.classList.toggle("selected",selected); button.setAttribute("aria-pressed",String(selected));
  });
  card.querySelectorAll("[data-combo-enable]").forEach(input=>setCombinedItemEnabled(card,input.dataset.comboEnable,input.checked));
  updateCombinedPreviews(state);
  drawPixelPreview(card.querySelector("[data-combo-pixel-preview]"),state,Number(card.querySelector("[data-combo-pixel-size]").value));
}

function updateCombinedPreviews(state) {
  const card=state.ui.card, base=outputDimensions(state), resize=card.querySelector('[data-combo-enable="resize"]').checked;
  const width=resize?(Number(card.querySelector("[data-combo-x]").value)||base.width):base.width;
  const height=resize?(Number(card.querySelector("[data-combo-y]").value)||base.height):base.height;
  card.querySelector("[data-combo-resize-before]").textContent=`${base.width} × ${base.height}`;
  card.querySelector("[data-combo-resize-after]").textContent=`${width} × ${height}`;
  card.querySelector("[data-combo-x-value]").textContent=`${width}px`;
  card.querySelector("[data-combo-y-value]").textContent=`${height}px`;
  card.querySelector("[data-combo-resize-ratio]").textContent=`가로 ${Math.round(width/base.width*100)}% · 세로 ${Math.round(height/base.height*100)}%`;
  const cropEnabled=card.querySelector('[data-combo-enable="crop"]').checked;
  const cropWidth=Number(card.querySelector("[data-combo-crop-width]").value)||state.videoWidth;
  const cropHeight=Number(card.querySelector("[data-combo-crop-height]").value)||state.videoHeight;
  const cropSelection=card.querySelector("[data-combo-crop-selection]");
  cropSelection.style.left=`${Number(card.querySelector("[data-combo-crop-x]").value)/state.videoWidth*100}%`;
  cropSelection.style.top=`${Number(card.querySelector("[data-combo-crop-y]").value)/state.videoHeight*100}%`;
  cropSelection.style.width=`${cropWidth/state.videoWidth*100}%`;
  cropSelection.style.height=`${cropHeight/state.videoHeight*100}%`;
  const outputWidth=cropEnabled&&!resize?outputSize(cropWidth,cropHeight,state.maxWidth).width:width;
  const outputHeight=cropEnabled&&!resize?outputSize(cropWidth,cropHeight,state.maxWidth).height:height;
  const frames=outputFrameCount(state), colors=state.colors;
  const before=state.resultBlob?.type==="image/gif"?state.resultBlob.size:estimateBytes({width:base.width,height:base.height,frames,colors,grayscale:state.filter==="gray"});
  let afterWidth=outputWidth,afterHeight=outputHeight,afterFrames=frames,afterColors=colors;
  const down=card.querySelector('[data-combo-enable="downsize"]').checked;
  if(down&&card.querySelector("[data-combo-down-size]").checked){afterWidth=Math.max(2,Math.round(afterWidth*.75));afterHeight=Math.max(2,Math.round(afterHeight*.75));}
  if(down&&card.querySelector("[data-combo-down-frames]").checked){const fps=Math.max(10,Math.round(state.fps/2)),speed=Math.max(.1,Number(state.edit.speed)||1);afterFrames=frameCount(state.start,state.end,speed>1?fps/speed:fps);}
  if(down&&card.querySelector("[data-combo-down-colors]").checked)afterColors=64;
  const after=estimateBytes({width:afterWidth,height:afterHeight,frames:Math.max(1,afterFrames),colors:afterColors,grayscale:state.filter==="gray"});
  card.querySelector("[data-combo-size-before]").textContent=`약 ${formatBytes(before)}`;
  card.querySelector("[data-combo-size-after]").textContent=`약 ${formatBytes(after)}`;
  const saved=Math.max(0,Math.round((1-after/Math.max(before,1))*100));
  card.querySelector("[data-combo-size-saved]").textContent=after<=before?`약 ${saved}% 감소`:`약 ${formatBytes(after-before)} 증가`;
}

function drawPixelPreview(canvas,state,pixelSize) {
  if(!canvas||!state.ready) return;
  const dimensions=outputDimensions(state), scale=Math.min(1,480/Math.max(dimensions.width,1));
  canvas.width=Math.max(2,Math.round(dimensions.width*scale)); canvas.height=Math.max(2,Math.round(dimensions.height*scale));
  const ctx=canvas.getContext("2d"), small=document.createElement("canvas");
  const effectiveBlock=Math.max(1,pixelSize*scale);
  small.width=Math.max(1,Math.ceil(canvas.width/effectiveBlock)); small.height=Math.max(1,Math.ceil(canvas.height/effectiveBlock));
  const smallCtx=small.getContext("2d");
  smallCtx.drawImage(state.ui.preview,0,0,small.width,small.height);
  ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(small,0,0,canvas.width,canvas.height);
}

function applyCombinedEdits(state) {
  const card=state.ui.card, enabled=name=>card.querySelector(`[data-combo-enable="${name}"]`).checked;
  if(enabled("resize")){state.edit.width=Number(card.querySelector("[data-combo-x]").value);state.edit.height=Number(card.querySelector("[data-combo-y]").value);}
  else {state.edit.width=null;state.edit.height=null;}
  if(enabled("crop")){
    const x=clamp(Number(card.querySelector("[data-combo-crop-x]").value)||0,0,state.videoWidth-2),y=clamp(Number(card.querySelector("[data-combo-crop-y]").value)||0,0,state.videoHeight-2);
    const width=Math.max(2,Math.min(state.videoWidth-x,Number(card.querySelector("[data-combo-crop-width]").value)||state.videoWidth));
    const height=Math.max(2,Math.min(state.videoHeight-y,Number(card.querySelector("[data-combo-crop-height]").value)||state.videoHeight));
    state.edit.cropRect={x,y,width,height}; state.edit.cropFill=card.querySelector("[data-combo-crop-fill]").value==="zoom"; state.edit.background=card.querySelector("[data-combo-background]").value;
  } else {state.edit.cropRect=null;state.edit.cropFill=false;}
  if(enabled("downsize")){
    if(card.querySelector("[data-combo-down-size]").checked){
      if(state.edit.width||state.edit.height){state.edit.width=Math.max(2,Math.round((state.edit.width||state.videoWidth)*.75));state.edit.height=Math.max(2,Math.round((state.edit.height||state.videoHeight)*.75));}
      else {const sourceWidth=state.edit.cropRect?.width||state.videoWidth;state.maxWidth=Math.max(2,Math.round(Math.min(sourceWidth,state.maxWidth)*.75));}
    }
    if(card.querySelector("[data-combo-down-frames]").checked)state.fps=Math.max(10,Math.round(state.fps/2));
    if(card.querySelector("[data-combo-down-colors]").checked)state.colors=64;
  }
  if(enabled("rotate")){
    state.edit.rotation=Number(card.querySelector('[data-combo-rotate][aria-pressed="true"]').dataset.comboRotate);
    state.edit.flipX=card.querySelector("[data-combo-flip-x]").checked;state.edit.flipY=card.querySelector("[data-combo-flip-y]").checked;
  } else {state.edit.rotation=0;state.edit.flipX=false;state.edit.flipY=false;}
  if(enabled("optimize"))state.colors=Number(card.querySelector("[data-combo-colors]").value);
  state.edit.pixelSize=enabled("pixelate")?Number(card.querySelector("[data-combo-pixel-size]").value):1;
  state.edit.reverse=enabled("reverse");
  state.edit.speed=enabled("speed")?clamp(Number(card.querySelector("[data-combo-speed]").value)||1,.1,10):1;
  if(!enabled("cut")){state.start=0;state.end=state.duration;updateTrim(state);}
  state.sampleBytes=null;
  if(state.resultBlob){state.staleResult=true;state.ui.stale.hidden=false;}
  const format=card.querySelector("[data-combo-format]").value;
  if(format==="jpg"){exportCurrentFrame(state);return;}
  if(format==="mp4"){exportMp4(state);return;}
  const blocked=hardLimit(state);if(blocked){toast(blocked);return;}
  state.expanded=true;state.ui.panel.hidden=false;startConvert(state);
}

function readEditorSettings(state) {
  const root=state.ui.card, tool=root.dataset.editTool;
  if(tool==="resize") { state.edit.width=Number(root.querySelector("[data-x]").value); state.edit.height=Number(root.querySelector("[data-y]").value); }
  if(tool==="crop") {
    state.edit.cropFill=root.querySelector('input[name^="crop-mode"]:checked')?.value==="zoom";
    state.edit.background=root.querySelector("[data-edit-bg]").value;
    state.edit.ratio=root.querySelector("[data-ratio]").value;
    state.edit.cropRect={x:Number(root.querySelector("[data-crop-x]").value),y:Number(root.querySelector("[data-crop-y]").value),width:Number(root.querySelector("[data-crop-width]").value),height:Number(root.querySelector("[data-crop-height]").value)};
    state.edit.width=null; state.edit.height=null;
  }
  if(tool==="downsize") {
    if(root.querySelector("[data-down-size]").checked) {
      if(state.edit.width) { state.edit.width=Math.max(2,Math.round(state.edit.width*.75)); state.edit.height=Math.max(2,Math.round(state.edit.height*.75)); }
      else state.maxWidth=Math.max(2,Math.round(Math.min(state.videoWidth,state.maxWidth)*.75));
    }
    if(root.querySelector("[data-down-frames]").checked) state.fps=Math.max(10,Math.round(state.fps/2));
    if(root.querySelector("[data-down-colors]").checked) state.colors=64;
  }
  if(tool==="optimize") state.colors=Number(root.querySelector("[data-opt-colors]").value);
  if(tool==="reverse") state.edit.reverse=root.querySelector("[data-reverse]").checked;
  if(tool==="speed") state.edit.speed=clamp(Number(root.querySelector("[data-speed-number]").value)||1,.1,10);
  if(tool==="pixelate") state.edit.pixelSize=Number(root.querySelector("[data-pixel-size]").value);
  if(tool==="cut") { const gap=minGap(state); state.start=clamp(Number(root.querySelector("[data-cut-start]").value)||0,0,Math.max(0,state.duration-gap)); state.end=clamp(Number(root.querySelector("[data-cut-end]").value)||state.duration,state.start+gap,state.duration); updateTrim(state); }
  state.sampleBytes=null;
  if(state.resultBlob) { state.staleResult=true; state.ui.stale.hidden=false; }
}

async function exportCurrentFrame(state) {
  const video=state.ui.capture;
  try {
    await seekTo(video,state.start);
    const crop=state.edit.cropRect||{x:0,y:0,width:video.videoWidth,height:video.videoHeight}, rotated=Math.abs(state.edit.rotation%180)===90;
    const canvas=document.createElement("canvas");
    canvas.width=state.edit.width || (rotated?crop.height:crop.width);
    canvas.height=state.edit.height || (rotated?crop.width:crop.height);
    const ctx=canvas.getContext("2d");
    ctx.fillStyle=state.edit.background||"#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.translate(canvas.width/2,canvas.height/2); ctx.rotate(state.edit.rotation*Math.PI/180); ctx.scale(state.edit.flipX?-1:1,state.edit.flipY?-1:1);
    const rotatedW=rotated?crop.height:crop.width, rotatedH=rotated?crop.width:crop.height;
    const scale=state.edit.cropFill?Math.max(canvas.width/rotatedW,canvas.height/rotatedH):Math.min(canvas.width/rotatedW,canvas.height/rotatedH);
    ctx.drawImage(video,crop.x,crop.y,crop.width,crop.height,-crop.width*scale/2,-crop.height*scale/2,crop.width*scale,crop.height*scale);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.92));
    if(!blob) throw new Error("JPG로 저장하지 못했습니다.");
    if(state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultBlob=blob; state.resultUrl=URL.createObjectURL(blob); state.downloadName=state.file.name.replace(/\.[^.]+$/,"")+".jpg";
    state.ui.resultImg.src=state.resultUrl; state.ui.resultSize.textContent=formatBytes(blob.size); state.ui.result.hidden=false;
    state.ui.resultImg.hidden=false;
    const outputVideo=state.ui.card.querySelector("[data-result-video]"); outputVideo.pause(); outputVideo.removeAttribute("src"); outputVideo.load(); outputVideo.hidden=true;
    state.ui.stash.disabled=false;
    state.ui.card.querySelector("[data-save-name]").value=state.downloadName;
    state.ui.editorSettings.hidden=true; state.ui.editorTools.hidden=false;
  } catch(error) { toast(error.message||"JPG 변환에 실패했습니다."); }
}

function mp4Supported() { return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4"); }

async function exportMp4(state) {
  if(!mp4Supported()) { toast("이 브라우저는 MP4 녹화를 지원하지 않습니다."); return; }
  const video=state.ui.capture, canvas=document.createElement("canvas");
  const crop=state.edit.cropRect||{x:0,y:0,width:video.videoWidth,height:video.videoHeight}, rotated=Math.abs(state.edit.rotation%180)===90;
  canvas.width=state.edit.width || (rotated?crop.height:crop.width);
  canvas.height=state.edit.height || (rotated?crop.width:crop.height);
  const ctx=canvas.getContext("2d"), stream=canvas.captureStream(30), chunks=[];
  const drawEdited=()=>{
    ctx.fillStyle=state.edit.background||"#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.save(); ctx.translate(canvas.width/2,canvas.height/2); ctx.rotate(state.edit.rotation*Math.PI/180); ctx.scale(state.edit.flipX?-1:1,state.edit.flipY?-1:1);
    const rw=rotated?crop.height:crop.width, rh=rotated?crop.width:crop.height;
    const scale=state.edit.cropFill?Math.max(canvas.width/rw,canvas.height/rh):Math.min(canvas.width/rw,canvas.height/rh);
    ctx.drawImage(video,crop.x,crop.y,crop.width,crop.height,-crop.width*scale/2,-crop.height*scale/2,crop.width*scale,crop.height*scale); ctx.restore();
  };
  try {
    await seekTo(video,state.start);
    const recorder=new MediaRecorder(stream,{mimeType:"video/mp4"});
    const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size) chunks.push(e.data);}; recorder.onerror=()=>reject(new Error("MP4 변환에 실패했습니다.")); recorder.onstop=resolve;});
    recorder.start(); video.playbackRate=state.edit.speed||1;
    await video.play();
    await new Promise(resolve=>{const draw=()=>{drawEdited(); if(video.currentTime>=state.end){video.pause();resolve();} else requestAnimationFrame(draw);}; draw();});
    recorder.stop(); await done;
    const blob=new Blob(chunks,{type:"video/mp4"});
    if(state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultBlob=blob; state.resultUrl=URL.createObjectURL(blob); state.downloadName=state.file.name.replace(/\.[^.]+$/,"")+".mp4";
    state.ui.resultImg.hidden=true; state.ui.card.querySelector("[data-result-video]").src=state.resultUrl; state.ui.card.querySelector("[data-result-video]").hidden=false; state.ui.resultSize.textContent=formatBytes(blob.size); state.ui.result.hidden=false;
    state.ui.stash.disabled=true;
    state.ui.card.querySelector("[data-save-name]").value=state.downloadName;
    state.ui.editorSettings.hidden=true; state.ui.editorTools.hidden=false;
  } catch(error) { toast(error.message||"MP4 변환에 실패했습니다."); }
  finally { stream.getTracks().forEach(track=>track.stop()); video.playbackRate=1; }
}

function buildFilmstrip(state) {
  const token = ++state.filmToken;
  state.queue(async () => {
    if (state.removed || token !== state.filmToken || state.cancelBackground || !state.ready) return;
    const count = 8;
    const thumbHeight = 64;
    const thumbWidth = Math.max(36, Math.round(thumbHeight * state.videoWidth / state.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = thumbWidth * count;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext("2d");
    for (let index = 0; index < count; index += 1) {
      if (state.removed || token !== state.filmToken || state.cancelBackground) return;
      const at = ((index + 0.5) / count) * state.duration;
      await seekTo(state.ui.capture, at);
      ctx.drawImage(state.ui.capture, index * thumbWidth, 0, thumbWidth, thumbHeight);
    }
    if (token !== state.filmToken || state.cancelBackground) return;
    const filmstrip=`url("${canvas.toDataURL("image/jpeg", 0.72)}")`;
    state.ui.track.style.backgroundImage=filmstrip;
    state.ui.card.querySelectorAll("[data-edit-track]").forEach(track=>track.style.backgroundImage=filmstrip);
    state.filmReady = true;
  });
}

function playRange(state) {
  if (!state.ready || state.busy) return;
  const video = state.ui.preview;
  state.stopRange?.();
  const onTime = () => {
    if (video.currentTime >= state.end - 0.02) {
      video.pause();
      video.removeEventListener("timeupdate", onTime);
    }
  };
  state.stopRange = () => video.removeEventListener("timeupdate", onTime);
  const startPlayback = () => {
    video.removeEventListener("seeked", startPlayback);
    video.play().catch(() => {});
    video.addEventListener("timeupdate", onTime);
  };
  if (Math.abs(video.currentTime - state.start) < 0.04) startPlayback();
  else {
    video.addEventListener("seeked", startPlayback);
    video.currentTime = state.start;
  }
}

async function startConvert(state) {
  if (!state.ready || state.busy) return;
  const blocked=hardLimit(state);
  if (blocked) { state.ui.note.hidden=false; state.ui.note.className="note error"; state.ui.note.textContent=blocked; return; }
  state.busy = true;
  state.convertError = "";
  state.cancelBackground = true;
  state.estimateToken += 1;
  state.filmToken += 1;
  state.abort = new AbortController();
  state.ui.card.classList.add("is-busy");
  state.ui.card.setAttribute("aria-busy", "true");
  state.ui.convert.disabled = true;
  state.ui.progressWrap.hidden = false;
  state.ui.cancel.hidden = false;
  state.ui.note.hidden = true;
  setProgress(state, 0, `0프레임 · ${state.fps}fps`);
  try {
    await state.queue(async () => {});
    if (state.removed || state.abort.signal.aborted) {
      const error = new Error("변환이 취소되었습니다.");
      error.name = "AbortError";
      throw error;
    }
    state.cancelBackground = false;
    const total = outputFrameCount(state);
    const result = await state.queue(() => convertToGif(state.ui.capture, {
      ...optionsFrom(state),
      signal: state.abort.signal,
      onProgress: ({ index, frames, ratio }) => {
        setProgress(state, ratio, `${index} / ${frames} 프레임 · ${state.fps}fps · ${Math.round(ratio * 100)}%`);
      },
    }));
    if (state.removed) return;
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultBlob = result.blob;
    state.resultUrl = URL.createObjectURL(result.blob);
    state.staleResult = false;
    state.downloadName = gifDownloadName(state.file.name);
    state.ui.result.hidden = false;
    state.ui.resultImg.src = state.resultUrl;
    state.ui.resultImg.hidden = false;
    const outputVideo=state.ui.card.querySelector("[data-result-video]"); outputVideo.pause(); outputVideo.removeAttribute("src"); outputVideo.load(); outputVideo.hidden=true;
    state.ui.resultSize.textContent = formatBytes(result.size);
    state.ui.outName.textContent = `저장 이름 ${state.downloadName} · ${result.width}×${result.height} · ${result.frames}프레임 · ${state.fps}fps`;
    state.ui.stash.textContent = "임시저장";
    state.ui.stale.hidden = true;
    state.ui.stash.disabled = false;
    state.sampleBytes = result.size;
    setProgress(state, 1, `변환 완료 · ${total}프레임 · ${state.fps}fps`);
    updateNumbers(state);
    state.ui.result.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    if (state.removed) return;
    if (error?.name === "AbortError") {
      state.ui.progressText.textContent = "변환을 취소했습니다.";
    } else {
      state.convertError = error.message || "변환에 실패했습니다.";
      state.ui.progressWrap.hidden = true;
    }
  } finally {
    if (state.removed) return;
    state.busy = false;
    state.cancelBackground = false;
    state.ui.card.classList.remove("is-busy");
    state.ui.card.setAttribute("aria-busy", "false");
    state.ui.cancel.hidden = true;
    updateNumbers(state);
    if (state.expanded && !state.filmReady) buildFilmstrip(state);
    if (state.convertError) {
      state.ui.note.hidden = false;
      state.ui.note.className = "note error";
      state.ui.note.textContent = state.convertError;
      state.ui.convert.disabled = false;
    }
  }
}

function setProgress(state, ratio, text) {
  const percent = Math.round(clamp(ratio, 0, 1) * 100);
  state.ui.progressBar.style.width = `${percent}%`;
  state.ui.progress.setAttribute("aria-valuenow", String(percent));
  state.ui.progressText.textContent = text;
}

function removeCard(state) {
  state.removed = true;
  state.cancelBackground = true;
  state.abort?.abort();
  clearTimeout(state.estimateTimer);
  state.stopRange?.();
  state.unbindTrim?.();
  URL.revokeObjectURL(state.url);
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  cards.delete(state);
  state.ui.card.remove();
  syncChrome();
}

function resetUploads() {
  if (!cards.size) return;
  [...cards].forEach((state) => removeCard(state));
  toast("업로드한 파일을 모두 삭제했습니다.", "ok");
}

async function stashResult(state) {
  if (!state.resultBlob || !state.downloadName) return;
  const nameInput=state.ui.card.querySelector("[data-save-name]");
  if(nameInput?.value.trim()) state.downloadName=safeFileName(nameInput.value);
  const item = {
    id: makeId(),
    name: state.downloadName,
    size: state.resultBlob.size,
    createdAt: Date.now(),
    blob: state.resultBlob,
  };
  item.url = URL.createObjectURL(item.blob);
  galleryItems.unshift(item);
  renderGallery();
  state.ui.stash.textContent = "임시저장됨";
  toast("웹저장소에 임시저장했습니다.", "ok");
  try {
    await saveGalleryRecord({
      id: item.id,
      name: item.name,
      size: item.size,
      createdAt: item.createdAt,
      blob: item.blob,
    });
  } catch {
    toast("이 화면에는 저장됐지만, 브라우저 저장소에는 남기지 못했습니다.");
  }
}

function renderGallery() {
  galleryGrid.innerHTML = "";
  storageCount.textContent = String(galleryItems.length);
  galleryEmpty.hidden = galleryItems.length > 0;
  resetGalleryBtn.disabled = galleryItems.length === 0;
  galleryItems.forEach((item) => {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.innerHTML = `
      <button type="button" class="icon-x" data-gallery-remove aria-label="${escapeHtml(item.name)} 삭제">×</button>
      <img src="${item.url}" alt="${escapeHtml(item.name)} 미리보기" />
      <div class="name-view" data-name-view>
        <h3>${escapeHtml(item.name)}</h3>
        <button type="button" class="text-btn" data-rename>이름 수정</button>
      </div>
      <form class="name-edit" data-name-edit hidden>
        <input type="text" value="${escapeHtml(item.name)}" aria-label="파일 이름" maxlength="120" />
        <button type="submit" class="btn ghost">저장</button>
      </form>
      <p>${escapeHtml(formatBytes(item.size))}</p>
      <button type="button" class="btn primary" data-gallery-download>다운로드</button>
    `;
    card.querySelector("[data-gallery-remove]").addEventListener("click", () => removeGalleryItem(item.id));
    card.querySelector("[data-gallery-download]").addEventListener("click", () => saveBlob(item.blob, item.name));
    card.querySelector("[data-rename]").addEventListener("click", () => {
      card.querySelector("[data-name-view]").hidden = true;
      const form = card.querySelector("[data-name-edit]");
      form.hidden = false;
      const input = form.querySelector("input");
      input.focus();
      input.select();
    });
    card.querySelector("[data-name-edit]").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input");
      renameGalleryItem(item.id, input.value);
    });
    galleryGrid.append(card);
  });
}

function gifFileName(value) {
  const cleaned = String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  if (!cleaned) return "";
  return /\.gif$/i.test(cleaned) ? cleaned : `${cleaned}.gif`;
}

async function renameGalleryItem(id, rawName) {
  const item = galleryItems.find((entry) => entry.id === id);
  if (!item) return;
  const name = gifFileName(rawName);
  if (!name) {
    toast("이름을 입력해 주세요.");
    return;
  }
  item.name = name;
  renderGallery();
  toast("이름을 수정했습니다.", "ok");
  try {
    await saveGalleryRecord({
      id: item.id,
      name: item.name,
      size: item.size,
      createdAt: item.createdAt,
      blob: item.blob,
    });
  } catch {
    toast("화면의 이름은 바뀌었지만, 브라우저 저장소에는 반영하지 못했습니다.");
  }
}

async function removeGalleryItem(id) {
  const index = galleryItems.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [item] = galleryItems.splice(index, 1);
  if (item.url) URL.revokeObjectURL(item.url);
  renderGallery();
  try {
    await deleteGalleryRecord(id);
  } catch {
    toast("화면에서는 지웠지만, 브라우저 저장소에서는 지우지 못했습니다.");
  }
}

async function resetGallery() {
  if (!galleryItems.length) return;
  const removed = galleryItems.splice(0, galleryItems.length);
  removed.forEach((item) => {
    if (item.url) URL.revokeObjectURL(item.url);
  });
  renderGallery();
  toast("웹저장소의 파일을 모두 삭제했습니다.", "ok");
  try {
    await clearGalleryRecords();
  } catch {
    toast("화면에서는 모두 지웠지만, 브라우저 저장소에서는 지우지 못했습니다.");
  }
}

async function restoreGallery() {
  try {
    const records = await loadGalleryRecords();
    records
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach((record) => {
        if (!record?.blob) return;
        galleryItems.push({ ...record, url: URL.createObjectURL(record.blob) });
      });
  } catch {
    // 저장소를 열지 못하면 빈 갤러리로 둡니다.
  }
  renderGallery();
}

resetUploadsBtn.addEventListener("click", resetUploads);
resetGalleryBtn.addEventListener("click", resetGallery);
openStorageBtn.addEventListener("click", openStorage);
document.querySelector("#close-storage").addEventListener("click", closeStorage);
storageModal.querySelector("[data-close-storage]").addEventListener("click", closeStorage);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !storageModal.hidden) closeStorage();
});
restoreGallery();

let storageMotion = 0;

function openStorage() {
  const motion = ++storageMotion;
  storageModal.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (motion !== storageMotion) return;
      storageModal.classList.add("is-open");
      document.querySelector("#close-storage").focus();
    });
  });
}

function closeStorage() {
  if (storageModal.hidden) return;
  const motion = ++storageMotion;
  const panel = storageModal.querySelector(".modal-dialog");
  let settled = false;
  const finish = () => {
    if (settled || motion !== storageMotion) return;
    settled = true;
    storageModal.hidden = true;
    document.body.classList.remove("modal-open");
    openStorageBtn.focus();
  };
  panel.addEventListener("transitionend", (event) => {
    if (event.target === panel && event.propertyName === "transform") finish();
  });
  storageModal.classList.remove("is-open");
  setTimeout(finish, 420);
}
