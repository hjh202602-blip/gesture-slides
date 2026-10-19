import {
  PoseLandmarker,
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage"), sheet = $("sheet"), slideCanvas = $("slide"), inkCanvas = $("ink");
const counter = $("counter"), grid = $("grid");
const video = $("video"), overlay = $("overlay"), camStatus = $("camStatus");
const pointerEl = $("pointer"), toastEl = $("toast");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ================= 슬라이드 ================= */

// 슬라이드 하나 = { w, h: 원본 크기, draw(canvas, scale): 그 배율로 canvas에 그림 }
let slides = [];
let current = 0;
let renderToken = 0;
let zoom = 1;
const pan = { x: 0, y: 0 }; // 확대했을 때 화면을 옮긴 정도(px)

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdf = files.find((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  try {
    if (pdf) {
      const doc = await pdfjsLib.getDocument({ data: await pdf.arrayBuffer() }).promise;
      slides = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        slides.push({
          w: base.width,
          h: base.height,
          draw: async (canvas, scale) => {
            const vp = page.getViewport({ scale });
            canvas.width = Math.ceil(vp.width);
            canvas.height = Math.ceil(vp.height);
            await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
          },
        });
      }
    } else {
      const images = files
        .filter((f) => f.type.startsWith("image/"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const bitmaps = await Promise.all(images.map((f) => createImageBitmap(f)));
      slides = bitmaps.map((bmp) => ({
        w: bmp.width,
        h: bmp.height,
        draw: async (canvas, scale) => {
          canvas.width = Math.ceil(bmp.width * scale);
          canvas.height = Math.ceil(bmp.height * scale);
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        },
      }));
    }
  } catch (err) {
    console.error(err);
    return toast("파일을 열지 못했어요");
  }
  if (!slides.length) return toast("PDF나 이미지 파일을 올려주세요");
  stage.classList.add("has-deck");
  inks.clear();
  thumbsBuilt = false;
  closeOverview(false);
  go(0);
}

async function render() {
  if (!slides.length) return;
  const token = ++renderToken;
  const s = slides[current];
  const rect = stage.getBoundingClientRect();
  const css = Math.min(rect.width / s.w, rect.height / s.h) * zoom;
  const px = Math.min(css * devicePixelRatio, 8192 / Math.max(s.w, s.h));
  // 임시 캔버스에 그린 뒤 옮김 → 빠르게 넘겨도 이전 페이지가 덮어쓰지 않음
  const tmp = document.createElement("canvas");
  await s.draw(tmp, px);
  if (token !== renderToken) return;
  slideCanvas.width = tmp.width;
  slideCanvas.height = tmp.height;
  slideCanvas.getContext("2d").drawImage(tmp, 0, 0);
  sheet.style.width = `${s.w * css}px`;
  sheet.style.height = `${s.h * css}px`;
  stage.classList.toggle("zoomed", zoom > 1);
  applyPan();
  drawInk();
  updateEraserSize();
  counter.textContent = `${current + 1} / ${slides.length}`;
}

// 슬라이드가 화면 밖으로 빠지지 않는 범위에서만 옮김
function applyPan() {
  const st = stage.getBoundingClientRect();
  const mx = Math.max(0, (parseFloat(sheet.style.width) - st.width) / 2) || 0;
  const my = Math.max(0, (parseFloat(sheet.style.height) - st.height) / 2) || 0;
  pan.x = clamp(pan.x, -mx, mx);
  pan.y = clamp(pan.y, -my, my);
  sheet.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
}
function movePan(dx, dy) {
  if (zoom <= 1 || overview) return;
  pan.x += dx;
  pan.y += dy;
  applyPan();
}

function go(i) {
  if (!slides.length) return;
  current = clamp(i, 0, slides.length - 1);
  zoom = 1;
  pan.x = pan.y = 0;
  render();
}

function next() {
  if (overview) return moveSelection(1);
  if (current >= slides.length - 1) return toast("마지막 슬라이드");
  go(current + 1);
  toast("다음 ▶");
}
function prev() {
  if (overview) return moveSelection(-1);
  if (current <= 0) return toast("첫 슬라이드");
  go(current - 1);
  toast("◀ 이전");
}
function first() {
  if (!slides.length) return;
  closeOverview(false);
  go(0);
  toast("첫 슬라이드로");
}
function last() {
  if (!slides.length) return;
  closeOverview(false);
  go(slides.length - 1);
  toast("마지막 슬라이드로");
}

const ZOOMS = [1, 1.5, 2, 3];
function setZoom(z) {
  if (!slides.length || overview) return;
  // 지금 보고 있는 부분이 그대로 가운데에 오도록 옮긴 거리도 같은 비율로 늘림
  pan.x *= z / zoom;
  pan.y *= z / zoom;
  zoom = z;
  render();
  toast(`확대 ${Math.round(z * 100)}%`);
}
function zoomIn() {
  const z = ZOOMS.find((v) => v > zoom + 0.01);
  z ? setZoom(z) : toast("최대 확대예요");
}
function zoomOut() {
  const z = [...ZOOMS].reverse().find((v) => v < zoom - 0.01);
  z ? setZoom(z) : toast("원래 크기예요");
}
function zoomReset() {
  setZoom(1);
}

// 마우스: 그리기가 켜져 있으면 글씨 쓰기, 아니면 확대했을 때 잡고 끌어서 옮기기
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || overview || !sheet.contains(e.target)) return;
  if (drawMode) {
    e.preventDefault();
    const st = beginStroke(slidePoint(e.clientX, e.clientY));
    stage.setPointerCapture(e.pointerId);
    const move = (ev) => extendStroke(st, slidePoint(ev.clientX, ev.clientY));
    const up = () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    return;
  }
  if (zoom <= 1) return;
  e.preventDefault();
  let x = e.clientX, y = e.clientY;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("panning");
  const move = (ev) => {
    movePan(ev.clientX - x, ev.clientY - y);
    x = ev.clientX;
    y = ev.clientY;
  };
  const up = () => {
    stage.classList.remove("panning");
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
});

/* ---------- 목록 보기 ---------- */

let overview = false;
let selected = 0;
let thumbsBuilt = false;

async function buildThumbs() {
  thumbsBuilt = true;
  grid.innerHTML = "";
  const buttons = slides.map((_, i) => {
    const b = document.createElement("button");
    b.className = "thumb";
    b.dataset.index = i;
    const label = document.createElement("span");
    label.textContent = i + 1;
    b.append(document.createElement("canvas"), label);
    b.addEventListener("click", () => {
      selected = i;
      closeOverview(true);
    });
    grid.append(b);
    return b;
  });
  markSelected();
  const deck = slides;
  for (let i = 0; i < deck.length; i++) {
    if (deck !== slides) return; // 그리는 도중 새 파일을 열었을 때
    const s = deck[i];
    await s.draw(buttons[i].firstChild, Math.min(320 / s.w, 200 / s.h) * devicePixelRatio);
  }
}

function openOverview() {
  if (!slides.length) return;
  overview = true;
  selected = current;
  stage.classList.add("overview");
  if (!thumbsBuilt) buildThumbs();
  else markSelected();
  toast("목록 보기");
}
function closeOverview(jump) {
  if (!overview) return;
  overview = false;
  stage.classList.remove("overview");
  if (jump) go(selected);
}
function toggleOverview() {
  overview ? closeOverview(true) : openOverview();
}
function moveSelection(d) {
  selected = clamp(selected + d, 0, slides.length - 1);
  markSelected();
}
function markSelected() {
  [...grid.children].forEach((el, i) => el.classList.toggle("sel", i === selected));
  grid.children[selected]?.scrollIntoView({ block: "nearest" });
}

/* ---------- 글씨 쓰기 ---------- */

// 굵기는 슬라이드 너비 대비 비율
const PENS = {
  red: { label: "빨간 펜", color: "#e53935", width: 0.004 },
  blue: { label: "파란 펜", color: "#1e6bff", width: 0.004 },
  black: { label: "검은 펜", color: "#111111", width: 0.004 },
  hl: { label: "형광펜", color: "#ffeb3b", width: 0.022, alpha: 0.4 },
  eraser: { label: "지우개", width: 0.035 },
};
const TOOL_ORDER = ["red", "blue", "black", "hl", "eraser"];
let tool = "red";
let drawMode = false; // 마우스로 그리기
const inks = new Map(); // 슬라이드 번호 → 획 목록 [{ tool, pts: [[x, y], ...] }] (슬라이드 기준 0~1 좌표)

function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll(".tool")) b.classList.toggle("sel", b.dataset.tool === t);
  const cur = $("drawCursor");
  cur.style.setProperty("--pen", PENS[t].color ?? "#fff");
  cur.classList.toggle("eraser", t === "eraser");
  cur.classList.toggle("hl", t === "hl");
  updateEraserSize();
}
// 빨 → 파 → 검 → 형광 → 지우개 → 빨 …
function nextTool() {
  setTool(TOOL_ORDER[(TOOL_ORDER.indexOf(tool) + 1) % TOOL_ORDER.length]);
  toast(PENS[tool].label);
}
function setDrawMode(on) {
  drawMode = on;
  stage.classList.toggle("drawing", on);
  $("drawToggle").classList.toggle("on", on);
  updateEraserSize();
}

// 지우개 커서 = 실제로 지워지는 범위와 같은 크기의 원 (확대하면 같이 커짐)
function updateEraserSize() {
  const d = Math.max(8, PENS.eraser.width * (parseFloat(sheet.style.width) || 0));
  $("drawCursor").style.setProperty("--eraser", `${d}px`);
  // 마우스로 지울 때도 같은 원을 커서로 씀
  if (drawMode && tool === "eraser") {
    const r = Math.min(d, 120) / 2;
    const size = Math.ceil(r * 2 + 4);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#0008" stroke-width="4"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#fff" stroke-width="2"/></svg>`;
    sheet.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${size / 2} ${size / 2}, crosshair`;
  } else {
    sheet.style.cursor = "";
  }
}

function slidePoint(clientX, clientY) {
  const r = sheet.getBoundingClientRect();
  return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
}
function beginStroke(p) {
  if (!slides.length || overview) return null;
  const st = { tool, pts: [p] };
  if (!inks.has(current)) inks.set(current, []);
  inks.get(current).push(st);
  scheduleInk();
  return st;
}
function extendStroke(st, p) {
  if (!st) return;
  st.pts.push(p);
  scheduleInk();
}

let inkQueued = false;
function scheduleInk() {
  if (inkQueued) return;
  inkQueued = true;
  requestAnimationFrame(() => {
    inkQueued = false;
    drawInk();
  });
}

function drawInk() {
  const w = parseFloat(sheet.style.width) || 0, h = parseFloat(sheet.style.height) || 0;
  if (!w || !h) return;
  const scale = Math.min(devicePixelRatio, 8192 / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  if (inkCanvas.width !== cw || inkCanvas.height !== ch) {
    inkCanvas.width = cw;
    inkCanvas.height = ch;
  }
  const ctx = inkCanvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  ctx.lineCap = ctx.lineJoin = "round";
  for (const st of inks.get(current) || []) {
    const pen = PENS[st.tool];
    // 지우개는 그 아래 그려진 획을 투명하게 깎아냄
    ctx.globalCompositeOperation = st.tool === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = pen.alpha ?? 1;
    ctx.strokeStyle = pen.color ?? "#000";
    ctx.lineWidth = pen.width * cw;
    ctx.beginPath();
    st.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * cw, y * ch) : ctx.moveTo(x * cw, y * ch)));
    if (st.pts.length === 1) ctx.lineTo(st.pts[0][0] * cw + 0.1, st.pts[0][1] * ch); // 점 하나도 보이게
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function clearInk() {
  if (!inks.get(current)?.length) return;
  inks.delete(current);
  drawInk();
  toast("이 슬라이드의 글씨를 지웠어요");
}

/* ---------- 알림 · 전체화면 ---------- */

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 900);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

/* ================= 기능 · 동작 목록 ================= */

// continuous = 동작을 하는 동안 계속 작동 (손가락 움직임으로 화면 이동)
const ACTIONS = [
  { id: "next", label: "다음 슬라이드", run: next },
  { id: "prev", label: "이전 슬라이드", run: prev },
  { id: "overview", label: "목록 보기 (다시 하면 선택)", run: toggleOverview },
  { id: "zoomIn", label: "확대", run: zoomIn },
  { id: "zoomOut", label: "축소", run: zoomOut },
  { id: "zoomReset", label: "원래 크기로", run: zoomReset },
  { id: "pan", label: "확대 화면 이동 (확대했을 때)", continuous: true },
  { id: "first", label: "첫 슬라이드로", run: first },
  { id: "last", label: "마지막 슬라이드로", run: last },
  { id: "draw", label: "그리기/지우기 (손가락 끝으로)", continuous: true },
  { id: "nextPen", label: "다음 도구 (빨→파→검→형광→지우개)", run: nextTool },
];
const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

const SIDES = ["L", "R"];
const SIDE_NAME = { L: "왼손", R: "오른손", B: "양손" };
const other = (s) => (s === "L" ? "R" : "L");

// 손 하나가 할 수 있는 동작 (왼손·오른손 같은 목록)
// kind: hold = 자세를 유지하면 실행, motion = 움직이는 순간 실행
// 방향(왼쪽/오른쪽)은 카메라를 보는 사람 기준
const HAND_GESTURES = [
  { id: "armOut", label: "팔 옆으로 뻗기", group: "팔", kind: "hold" },
  { id: "armUp", label: "팔 위로 들기", group: "팔", kind: "hold" },
  { id: "swipeL", label: "왼쪽으로 쓸기", group: "움직임", kind: "motion" },
  { id: "swipeR", label: "오른쪽으로 쓸기", group: "움직임", kind: "motion" },
  { id: "fistOpen", label: "주먹 쥐었다 펴기", group: "움직임", kind: "motion" },
  { id: "point", label: "검지 세우고 움직이기", group: "손 모양", kind: "hold" },
  { id: "palm", label: "손바닥 펴기", group: "손 모양", kind: "hold" },
  { id: "fist", label: "주먹 쥐기", group: "손 모양", kind: "hold" },
  { id: "vsign", label: "브이(V)", group: "손 모양", kind: "hold" },
  { id: "thumbUp", label: "엄지 척", group: "손 모양", kind: "hold" },
];

// 양손으로 동시에 하는 동작 = 왼손 동작 + 오른손 동작
const TWO_HAND_GESTURES = [
  { id: "pinch", label: "두 손 모으기", L: "swipeR", R: "swipeL" },
  { id: "spread", label: "두 손 벌리기", L: "swipeL", R: "swipeR" },
  { id: "palms", label: "양손 손바닥 펴기", L: "palm", R: "palm" },
  { id: "fists", label: "양손 주먹 쥐기", L: "fist", R: "fist" },
  { id: "fistOpens", label: "양손 주먹 쥐었다 펴기", L: "fistOpen", R: "fistOpen" },
  { id: "armsUp", label: "두 팔 위로 들기", L: "armUp", R: "armUp" },
  { id: "armsOut", label: "두 팔 옆으로 뻗기", L: "armOut", R: "armOut" },
  { id: "vsigns", label: "양손 브이(V)", L: "vsign", R: "vsign" },
  { id: "thumbsUp", label: "양손 엄지 척", L: "thumbUp", R: "thumbUp" },
];

// 기능마다 동작 키 목록 — 그중 어느 것을 해도 실행 ("R:swipeR" = 오른손 오른쪽으로 쓸기, "B:pinch" = 양손 두 손 모으기)
const DEFAULTS = {
  mapping: {
    next: ["R:swipeR", "L:swipeR"],
    prev: ["R:swipeL", "L:swipeL"],
    overview: ["B:pinch"],
    zoomIn: ["R:fistOpen"],
    zoomOut: ["L:fistOpen"],
    zoomReset: ["B:palms"],
    pan: ["R:point"],
    first: ["R:vsign"],
    last: ["L:vsign"],
    draw: ["L:point"],
    nextPen: ["L:thumbUp"],
  },
  enabled: Object.fromEntries(ACTIONS.map((a) => [a.id, true])),
  custom: [], // { id, name, side, feat }
  hold: 450,
  ver: 6,
};

const STORE_KEY = "gesture-slides.v3";
let settings = loadSettings();

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) {
      const mapping = structuredClone(DEFAULTS.mapping);
      for (const [k, v] of Object.entries(s.mapping || {})) {
        if (mapping[k] && Array.isArray(v) && v.length) mapping[k] = v.filter((x) => typeof x === "string");
      }
      return {
        ...structuredClone(DEFAULTS),
        ...s,
        mapping,
        enabled: { ...DEFAULTS.enabled, ...s.enabled },
        hold: (s.ver ?? 0) < 6 ? DEFAULTS.hold : s.hold, // 기본 민감도가 0.45초로 바뀜
        ver: DEFAULTS.ver,
      };
    }
  } catch {}
  return structuredClone(DEFAULTS);
}
function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {}
}

// 한 손 동작 찾기 (기본 동작 + 그 손으로 녹화한 내 동작)
function findHand(side, id) {
  if (!id) return null;
  const g = HAND_GESTURES.find((x) => x.id === id);
  if (g) return g;
  const c = settings.custom.find((x) => x.id === id && x.side === side);
  return c && { id: c.id, label: c.name, group: "내 동작", kind: "hold" };
}

// 동작 키 → { key, side, label, L, R, kind, shapeHold }
function gestureDef(key) {
  const [side, id] = key.split(":");
  let L = "", R = "", label;
  if (side === "B") {
    const t = TWO_HAND_GESTURES.find((x) => x.id === id);
    if (!t) return null;
    ({ L, R, label } = t);
  } else {
    const g = findHand(side, id);
    if (!g) return null;
    label = g.label;
    if (side === "L") L = id;
    else R = id;
  }
  const parts = SIDES.filter((s) => (s === "L" ? L : R)).map((s) => findHand(s, s === "L" ? L : R));
  return {
    key,
    side,
    label,
    L,
    R,
    kind: parts.some((p) => p.kind === "motion") ? "motion" : "hold",
    shapeHold: parts.some((p) => p.group !== "팔"), // 손 모양은 0.2초 더 유지
  };
}
const fullLabel = (d) => (d.side === "B" ? `${d.label} (양손)` : `${SIDE_NAME[d.side]} ${d.label}`);

// 고를 수 있는 모든 동작을 오른손 · 왼손 · 양손으로 나눔
function gestureGroups() {
  const hand = (side) => [
    ...HAND_GESTURES.map((g) => `${side}:${g.id}`),
    ...settings.custom.filter((c) => c.side === side).map((c) => `${side}:${c.id}`),
  ];
  return [
    { side: "R", title: "오른손 동작", keys: hand("R") },
    { side: "L", title: "왼손 동작", keys: hand("L") },
    { side: "B", title: "양손 동작 (동시에)", keys: TWO_HAND_GESTURES.map((t) => `B:${t.id}`) },
  ];
}

// 연결을 한 줄씩 펼친 목록. all=false면 체크된 기능만
function bindings(all = false) {
  const list = [];
  for (const a of ACTIONS) {
    if (!all && !settings.enabled[a.id]) continue;
    (settings.mapping[a.id] || []).forEach((gkey, i) => {
      const def = gestureDef(gkey);
      if (def) list.push({ action: a, key: `${a.id}#${i}`, def, L: def.L, R: def.R });
    });
  }
  return list;
}
const isMotion = (b) => b.def.kind === "motion";
const holdOf = (b) => settings.hold + (b.def.shapeHold ? 200 : 0);

/* ---------- 설정 패널 (적용 전까지는 draft에서만 바뀜) ---------- */

const settingsEl = $("settings"), mapRows = $("mapRows"), customList = $("customList");
const holdInput = $("hold"), holdOut = $("holdOut"), recBtn = $("recBtn");
const customName = $("customName"), customSide = $("customSide");
const applyBtn = $("applyBtn"), revertBtn = $("revertBtn"), dirtyMsg = $("dirtyMsg");

const draftOf = () => ({
  mapping: structuredClone(settings.mapping),
  enabled: { ...settings.enabled },
  hold: settings.hold,
});
let draft = draftOf();
const isDirty = () => JSON.stringify(draft) !== JSON.stringify(draftOf());

function gestureSelect(value, onChange) {
  const sel = document.createElement("select");
  for (const grp of gestureGroups()) {
    const og = document.createElement("optgroup");
    og.label = grp.title;
    for (const key of grp.keys) {
      const d = gestureDef(key);
      og.append(new Option(d.label + (d.side !== "B" && findHand(d.side, d.L || d.R).group === "내 동작" ? " (내 동작)" : ""), key));
    }
    sel.append(og);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

// 설정 화면에서 기능을 보여주는 묶음 (보여주는 순서만 정함)
const MAP_GROUPS = [
  { title: "슬라이드 넘기기", ids: ["next", "prev", "first", "last", "overview"] },
  { title: "확대와 화면 이동", ids: ["zoomIn", "zoomOut", "zoomReset", "pan"] },
  { title: "그리기", ids: ["draw", "nextPen"] },
];
const ICON = {
  trash: '<svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  plus: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  play: '<svg class="ic fill" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  close: '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  restore: '<svg class="ic" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
};

function handBadge(side) {
  const b = document.createElement("i");
  b.className = `hand-badge ${side}`;
  b.textContent = SIDE_NAME[side];
  return b;
}

function buildMapBlock(a) {
  const block = document.createElement("div");
  block.className = "map-block";
  block.dataset.action = a.id;
  block.classList.toggle("off", !draft.enabled[a.id]);

  const title = document.createElement("div");
  title.className = "map-title";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = a.label;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.title = "발표 중 인식 상태 (주황: 인식 중, 초록: 실행)";
  const sw = document.createElement("label");
  sw.className = "switch";
  sw.title = "끄면 발표 중에 실행되지 않아요";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = draft.enabled[a.id];
  check.addEventListener("change", () => {
    draft.enabled[a.id] = check.checked;
    buildMapRows();
  });
  const track = document.createElement("span");
  track.className = "track";
  const swLabel = document.createElement("span");
  swLabel.className = "sw-label";
  swLabel.textContent = check.checked ? "사용" : "꺼짐";
  sw.append(check, track, swLabel);
  title.append(name, dot, sw);
  block.append(title);

  const alts = document.createElement("div");
  alts.className = "alts";
  const lone = draft.mapping[a.id].length === 1;
  draft.mapping[a.id].forEach((gkey, i) => {
    if (i) {
      const or = document.createElement("div");
      or.className = "or";
      or.textContent = "또는";
      alts.append(or);
    }
    const alt = document.createElement("div");
    alt.className = "alt";
    const del = document.createElement("button");
    del.className = "icon-btn" + (lone ? " lone" : "");
    del.title = lone ? "기능마다 동작이 하나는 있어야 해요" : "이 동작 빼기";
    del.setAttribute("aria-label", "이 동작 빼기");
    del.innerHTML = ICON.trash;
    del.addEventListener("click", () => removeAlt(a.id, i));
    alt.append(handBadge(gkey.split(":")[0]), gestureSelect(gkey, (v) => assign(a.id, i, v)), del);
    alts.append(alt);
  });
  block.append(alts);

  const add = document.createElement("button");
  add.className = "add-alt";
  add.innerHTML = `${ICON.plus}<span>다른 동작 추가</span>`;
  add.title = "추가한 동작 중 어느 것을 해도 실행돼요";
  add.addEventListener("click", () => addAlt(a.id));
  block.append(add);
  return block;
}

function buildMapRows() {
  mapRows.innerHTML = "";
  const listed = new Set(MAP_GROUPS.flatMap((g) => g.ids));
  const groups = MAP_GROUPS.map((g) => ({ ...g, ids: [...g.ids] }));
  groups.at(-1).ids.push(...ACTIONS.filter((a) => !listed.has(a.id)).map((a) => a.id)); // 빠진 기능이 없도록
  for (const g of groups) {
    const wrap = document.createElement("div");
    wrap.className = "map-group";
    const h = document.createElement("h4");
    h.textContent = g.title;
    wrap.append(h);
    for (const id of g.ids) if (ACTION_BY_ID[id]) wrap.append(buildMapBlock(ACTION_BY_ID[id]));
    mapRows.append(wrap);
  }
  refreshDirty();
}

// 같은 동작이 이미 다른 줄에 있으면 그 기능 이름을 돌려줌
function usedBy(gkey, skipAction, skipIndex) {
  for (const a of ACTIONS) {
    if (draft.mapping[a.id].some((k, i) => k === gkey && !(a.id === skipAction && i === skipIndex))) return a.label;
  }
  return null;
}

function assign(actionId, idx, gkey) {
  const dup = usedBy(gkey, actionId, idx);
  if (dup) {
    toast(`이미 '${dup}'에 쓰는 동작이에요`);
    return buildMapRows();
  }
  draft.mapping[actionId][idx] = gkey;
  buildMapRows();
}

function addAlt(actionId) {
  // 아직 아무 데도 안 쓰인 동작 하나로 새 줄을 시작
  const free = gestureGroups().flatMap((g) => g.keys).find((k) => !usedBy(k));
  if (!free) return toast("더 추가할 수 있는 동작이 없어요");
  draft.mapping[actionId].push(free);
  buildMapRows();
}

function removeAlt(actionId, idx) {
  if (draft.mapping[actionId].length === 1) return toast("기능마다 동작이 하나는 있어야 해요 (안 쓰려면 사용 스위치를 꺼주세요)");
  draft.mapping[actionId].splice(idx, 1);
  buildMapRows();
}

function refreshDirty() {
  const dirty = isDirty();
  dirtyMsg.textContent = dirty ? "적용하지 않은 변경이 있어요" : "바뀐 내용 없음";
  dirtyMsg.classList.toggle("dirty", dirty);
  applyBtn.disabled = revertBtn.disabled = !dirty;
}

function applyDraft() {
  settings.mapping = structuredClone(draft.mapping);
  settings.enabled = { ...draft.enabled };
  settings.hold = draft.hold;
  saveSettings();
  refreshSettingsUI();
  toast("적용했어요");
}

function buildCustomList() {
  customList.innerHTML = "";
  if (!settings.custom.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "아직 만든 동작이 없어요";
    customList.append(li);
  }
  for (const c of settings.custom) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "cname";
    name.textContent = c.name;
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.title = "이 동작 삭제";
    del.setAttribute("aria-label", "이 동작 삭제");
    del.innerHTML = ICON.trash;
    del.addEventListener("click", () => deleteCustom(c));
    li.append(handBadge(c.side), name, del);
    customList.append(li);
  }
}

// 내 동작 삭제는 바로 저장 (적용된 설정과 작업 중인 설정 모두에서 뺌)
function deleteCustom(c) {
  const key = `${c.side}:${c.id}`;
  settings.custom = settings.custom.filter((x) => x.id !== c.id);
  for (const target of [settings, draft]) {
    for (const a of ACTIONS) {
      const keys = target.mapping[a.id].filter((k) => k !== key);
      target.mapping[a.id] = keys.length ? keys : [...DEFAULTS.mapping[a.id]];
    }
  }
  saveSettings();
  buildMapRows();
  buildCustomList();
  renderGuide();
}

function renderGuide() {
  const ul = $("guide");
  ul.innerHTML = "";
  for (const a of ACTIONS) {
    const bs = bindings().filter((b) => b.action === a);
    if (!bs.length) continue;
    const li = document.createElement("li");
    bs.forEach((b, i) => {
      if (i) li.append(" 또는 ");
      const strong = document.createElement("b");
      strong.textContent = fullLabel(b.def);
      li.append(strong);
    });
    li.append(` → ${a.label}`);
    ul.append(li);
  }
}

function showHold() {
  holdInput.value = draft.hold;
  holdOut.value = `${(draft.hold / 1000).toFixed(2)}s`;
}

function refreshSettingsUI() {
  draft = draftOf();
  buildMapRows();
  buildCustomList();
  renderGuide();
  showHold();
}

holdInput.addEventListener("input", () => {
  draft.hold = +holdInput.value;
  showHold();
  refreshDirty();
});
$("resetBtn").addEventListener("click", () => {
  draft = { mapping: structuredClone(DEFAULTS.mapping), enabled: { ...DEFAULTS.enabled }, hold: DEFAULTS.hold };
  buildMapRows();
  showHold();
  toast("기본값을 불러왔어요. 적용을 눌러야 반영돼요");
});
applyBtn.addEventListener("click", applyDraft);
revertBtn.addEventListener("click", () => {
  refreshSettingsUI();
  toast("변경을 취소했어요");
});

function closeSettings() {
  if (isDirty()) toast("적용하지 않은 변경은 취소됐어요");
  settingsEl.hidden = true;
  refreshSettingsUI();
}
$("setBtn").addEventListener("click", () => (settingsEl.hidden ? (settingsEl.hidden = false) : closeSettings()));
$("closeSet").addEventListener("click", closeSettings);
// 설정 창 바깥을 누르면 닫힘 (누른 버튼은 그대로 작동)
document.addEventListener(
  "pointerdown",
  (e) => {
    if (settingsEl.hidden || settingsEl.contains(e.target) || e.target.closest("#setBtn")) return;
    closeSettings();
  },
  true,
);

refreshSettingsUI();

/* ---------- 기타 UI ---------- */

$("file").addEventListener("change", (e) => loadFiles(e.target.files));
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("dragover");
});
stage.addEventListener("dragleave", () => stage.classList.remove("dragover"));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("dragover");
  loadFiles(e.dataTransfer.files);
});
$("fsBtn").addEventListener("click", toggleFullscreen);
$("firstBtn").addEventListener("click", first);
$("prevBtn").addEventListener("click", prev);
$("overviewBtn").addEventListener("click", toggleOverview);
$("nextBtn").addEventListener("click", next);
$("lastBtn").addEventListener("click", last);
$("drawToggle").addEventListener("click", () => setDrawMode(!drawMode));
$("clearInk").addEventListener("click", clearInk);
for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => {
    setTool(b.dataset.tool);
    setDrawMode(true);
  });
}
setTool("red");
addEventListener("resize", () => {
  render();
  placeCam();
});
document.addEventListener("fullscreenchange", () => setTimeout(render, 100));

addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT"].includes(e.target.tagName)) return;
  const k = e.key;
  if (["ArrowRight", "PageDown", " "].includes(k)) { e.preventDefault(); next(); }
  else if (["ArrowLeft", "PageUp"].includes(k)) { e.preventDefault(); prev(); }
  else if (k === "Home") first();
  else if (k === "End") last();
  else if (k === "o" || k === "O") toggleOverview();
  else if (k === "Enter" && overview) closeOverview(true);
  else if (k === "Escape") {
    if (labOpen) closeLab();
    else if (!settingsEl.hidden) closeSettings();
    else closeOverview(false);
  }
  else if (k === "+" || k === "=") zoomIn();
  else if (k === "-") zoomOut();
  else if (k === "0") zoomReset();
  else if (k === "f" || k === "F") toggleFullscreen();
});

/* ================= 카메라 + 인식 모델 ================= */

// MediaPipe Pose 번호 (사람 기준 왼쪽/오른쪽)
const ARM = {
  L: { shoulder: 11, elbow: 13, wrist: 15, index: 19 },
  R: { shoulder: 12, elbow: 14, wrist: 16, index: 20 },
};
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODELS = "https://storage.googleapis.com/mediapipe-models";

let poseLm = null, handLm = null;
let running = false; // 카메라가 켜져 인식 중
let stream = null;
let presenting = false; // 발표 중일 때만 동작으로 기능이 실행됨

// 카메라는 발표 중·실험 중·녹화 중 중 하나라도 쓰면 켜 둠
async function ensureCamera() {
  if (running) return;
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.srcObject = stream;
  await video.play();
  if (!poseLm) {
    camStatus.textContent = "인식 모델 불러오는 중…";
    const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    [poseLm, handLm] = await Promise.all([
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${MODELS}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      }),
    ]);
  }
  running = true;
  requestAnimationFrame(loop);
}

function releaseCamera() {
  if (presenting || labOpen || recording) return;
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

const presentBtn = $("presentBtn");
presentBtn.addEventListener("click", () => (presenting ? stopPresenting() : startPresenting()));

async function startPresenting() {
  presenting = true;
  presentBtn.innerHTML = "<span>발표 중지</span>";
  presentBtn.classList.add("on");
  $("cam").hidden = false;
  placeCam();
  camStatus.textContent = "카메라 연결 중…";
  try {
    await ensureCamera();
    toast("발표를 시작했어요");
  } catch (err) {
    console.error(err);
    stopPresenting();
    toast("카메라를 켜지 못했어요: " + err.message);
  }
}

function stopPresenting() {
  presenting = false;
  presentBtn.innerHTML = `${ICON.play}<span>발표 시작</span>`;
  presentBtn.classList.remove("on");
  $("cam").hidden = true;
  hideCursors();
  releaseCamera();
  toast("발표를 멈췄어요. 동작 인식도 꺼졌어요");
}

let lastVideoTime = -1;
function loop() {
  if (!running) return;
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;
    const t = performance.now();
    const pose = poseLm.detectForVideo(video, t).landmarks?.[0];
    const hands = handLm.detectForVideo(video, t);
    onFrame(pose, hands.landmarks ?? [], hands.handedness ?? [], t);
  }
  requestAnimationFrame(loop);
}

/* ---------- 카메라 창: 숨기기 · 옮기기 · 크기 조절 ---------- */

const camEl = $("cam"), camBar = $("camBar"), camToggle = $("camToggle");
const CAM_KEY = "gesture-slides.cam";
let camLayout = { x: null, y: null, w: 280, mini: false };
try {
  camLayout = { ...camLayout, ...JSON.parse(localStorage.getItem(CAM_KEY)) };
} catch {}
const saveCam = () => {
  try {
    localStorage.setItem(CAM_KEY, JSON.stringify(camLayout));
  } catch {}
};

// 창이 화면 밖으로 나가지 않게 위치·크기를 맞춤
function placeCam() {
  const w = clamp(camLayout.w, 160, innerWidth - 16);
  camEl.style.width = `${w}px`;
  camEl.classList.toggle("mini", camLayout.mini);
  camToggle.innerHTML = camLayout.mini ? ICON.restore : ICON.close;
  camToggle.title = camLayout.mini ? "카메라 다시 보이기" : "카메라 숨기기 (인식은 계속돼요)";
  if (camLayout.x == null || camEl.hidden) return;
  const r = camEl.getBoundingClientRect();
  const x = clamp(camLayout.x, 0, innerWidth - r.width);
  const y = clamp(camLayout.y, 0, innerHeight - r.height);
  Object.assign(camEl.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
}

camToggle.addEventListener("click", () => {
  camLayout.mini = !camLayout.mini;
  saveCam();
  placeCam();
});

// 막대를 끌어서 옮기기
camBar.addEventListener("pointerdown", (e) => {
  if (e.target === camToggle) return;
  const r = camEl.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  camBar.setPointerCapture(e.pointerId);
  const move = (ev) => {
    camLayout.x = ev.clientX - dx;
    camLayout.y = ev.clientY - dy;
    placeCam();
  };
  const up = () => {
    camBar.removeEventListener("pointermove", move);
    camBar.removeEventListener("pointerup", up);
    saveCam();
  };
  camBar.addEventListener("pointermove", move);
  camBar.addEventListener("pointerup", up);
});

// 오른쪽 아래 모서리를 끌어서 크기 조절
const camResize = $("camResize");
camResize.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const r = camEl.getBoundingClientRect();
  const startX = e.clientX, startW = r.width;
  // 크기를 바꾸는 동안 왼쪽 위 모서리가 고정되도록 위치를 확정
  camLayout.x = r.left;
  camLayout.y = r.top;
  camResize.setPointerCapture(e.pointerId);
  const move = (ev) => {
    camLayout.w = clamp(startW + ev.clientX - startX, 160, 900);
    placeCam();
  };
  const up = () => {
    camResize.removeEventListener("pointermove", move);
    camResize.removeEventListener("pointerup", up);
    saveCam();
  };
  camResize.addEventListener("pointermove", move);
  camResize.addEventListener("pointerup", up);
});

/* ================= 동작 판정 ================= */

// 좌표는 x에 화면 비율(A)을 곱해 가로·세로 길이를 같은 단위로 맞춤
let A = 4 / 3;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function armPoints(lm, side) {
  const ids = ARM[side];
  const p = (i) => ({ x: lm[i].x * A, y: lm[i].y, v: lm[i].visibility ?? 1 });
  return { s: p(ids.shoulder), e: p(ids.elbow), w: p(ids.wrist), i: p(ids.index) };
}

function analyzeArm(arm, side, shoulderW) {
  const visible = Math.min(arm.s.v, arm.e.v, arm.w.v) > 0.5;
  const path = dist(arm.s, arm.e) + dist(arm.e, arm.w) + dist(arm.w, arm.i);
  const straight = dist(arm.s, arm.i) / path; // 1에 가까울수록 팔이 곧게 펴짐
  const dx = arm.i.x - arm.s.x;
  const dy = arm.i.y - arm.s.y;
  // 원본(비반전) 카메라 영상에서 사람의 오른팔은 -x 방향, 왼팔은 +x 방향으로 뻗음
  const out = side === "R" ? -dx : dx;
  const up = -dy;
  return {
    visible,
    sideways: visible && straight > 0.8 && out > 0.9 * shoulderW && Math.abs(dy) < 0.6 * out,
    raised: visible && straight > 0.75 && up > 0.9 * shoulderW && Math.abs(dx) < 0.7 * up,
  };
}

// 손 모양: 손가락 끝이 둘째 마디보다 손목에서 멀면 펴진 것
function handInfo(h, handed) {
  const p = (i) => ({ x: h[i].x * A, y: h[i].y });
  const w = p(0);
  const palm = dist(w, p(9)) || 1e-3;
  const ext = (tip, pip) => dist(w, p(tip)) > dist(w, p(pip)) * 1.15;
  const f = [ext(8, 6), ext(12, 10), ext(16, 14), ext(20, 18)];
  const thumb = dist(p(4), p(5)) > 0.55 * palm;
  const thumbUpward = p(4).y < p(5).y - 0.35 * palm;
  const n = f.filter(Boolean).length;
  let shape = null;
  if (n === 4 && thumb) shape = "palm";
  else if (n === 0 && thumb && thumbUpward) shape = "thumbUp";
  else if (n === 0) shape = "fist";
  else if (f[0] && !f[1] && !f[2] && !f[3]) shape = "point";
  else if (f[0] && f[1] && !f[2] && !f[3]) shape = "vsign";
  // MediaPipe의 왼손/오른손 표시는 거울 영상 기준이라 원본 영상에서는 반대
  const guess = handed?.[0]?.categoryName === "Left" ? "R" : "L";
  return { pts: h.map((_, i) => p(i)), wrist: w, tip: p(8), ext: [thumb, ...f].map(Number), shape, guess, side: null, shown: false };
}

// 손을 왼손/오른손에 배정: 포즈의 손목과 가까운 쪽 (포즈가 없으면 모델의 추정값)
function assignHands(handInfos, body) {
  const bySide = { L: null, R: null };
  if (!body) {
    for (const h of handInfos) if (!bySide[h.guess]) bySide[(h.side = h.guess)] = h;
    return bySide;
  }
  const cost = (h, s) => dist(h.wrist, body[s].w);
  if (handInfos.length === 1) {
    const h = handInfos[0];
    h.side = cost(h, "L") < cost(h, "R") ? "L" : "R";
    bySide[h.side] = h;
  } else if (handInfos.length >= 2) {
    const [a, b] = handInfos;
    const straight = cost(a, "L") + cost(b, "R");
    const swapped = cost(a, "R") + cost(b, "L");
    [a.side, b.side] = straight <= swapped ? ["L", "R"] : ["R", "L"];
    bySide[a.side] = a;
    bySide[b.side] = b;
  }
  return bySide;
}

/* ---------- 움직임 (손마다 쓸기 · 주먹 쥐었다 펴기) ---------- */

const hist = { L: [], R: [] };
const sideCooldown = { L: 0, R: 0 };
const backBlock = { L: null, R: null }; // 쓸고 난 뒤 손이 돌아오는 움직임은 무시
const OPPOSITE = { swipeL: "swipeR", swipeR: "swipeL" };
const fistAt = { L: 0, R: 0 }; // 마지막으로 주먹을 쥔 시각
let pending = []; // 손마다 감지된 움직임 { side, id, t, used }

function pushMotion(side, id, now, seen) {
  pending.push({ side, id, t: now, used: false });
  seen[side][id] = now;
}

function detectSwipes(body, handBySide, now, seen) {
  const W = body.W;
  for (const s of SIDES) {
    // 검지를 세우고 움직이는 중(화면 이동)에는 쓸기로 보지 않음
    const hand = handBySide[s];
    const pointing = hand?.shown && hand.shape === "point";
    // 포즈 손목이 흐리면 손 모델의 손목을 씀
    const pos = body[s].w.v > 0.5 ? body[s].w : hand?.wrist;
    // 손이 허리보다 아래면 무시 (걷거나 팔을 내리는 움직임)
    if (pointing || !pos || pos.y > body.shoulderY + 1.8 * W) {
      hist[s].length = 0;
      continue;
    }
    const h = hist[s];
    h.push({ t: now, x: -pos.x, y: pos.y }); // 거울 기준: 화면 오른쪽이 +
    while (now - h[0].t > 600) h.shift();
    if (now < sideCooldown[s] || h.length < 3) continue;

    // 최근 0.6초 안에서 지금 위치와 가장 멀리 떨어진 지점까지의 이동
    const lastP = h.at(-1);
    let dx = 0, dy = 0;
    for (const p of h) {
      if (Math.hypot(lastP.x - p.x, lastP.y - p.y) > Math.hypot(dx, dy)) {
        dx = lastP.x - p.x;
        dy = lastP.y - p.y;
      }
    }
    if (!(Math.abs(dx) > 0.8 * W && Math.abs(dy) < 0.6 * Math.abs(dx))) continue;
    const id = dx > 0 ? "swipeR" : "swipeL";
    if (backBlock[s] && backBlock[s].id === id && now < backBlock[s].until) {
      h.length = 0;
      continue;
    }
    pushMotion(s, id, now, seen);
    sideCooldown[s] = now + 500;
    backBlock[s] = { id: OPPOSITE[id], until: now + 1000 };
    h.length = 0;
  }
}

// 주먹을 쥐었다가 0.9초 안에 손바닥을 펴면 한 번
function detectFistOpen(handBySide, now, seen) {
  for (const s of SIDES) {
    const h = handBySide[s];
    if (!h?.shown) continue;
    if (h.shape === "fist") fistAt[s] = now;
    else if (h.shape === "palm" && fistAt[s] && now - fistAt[s] < 900) {
      pushMotion(s, "fistOpen", now, seen);
      fistAt[s] = 0;
    }
  }
}

/* ---------- 내 동작 (녹화한 한 손 자세와 비교) ---------- */

const UNKNOWN = 0.5; // 손가락이 안 보일 때

function featureOf(body, side, hand) {
  if (!body || body[side].s.v < 0.5) return null;
  const a = body[side];
  const pose = [];
  for (const k of ["e", "w", "i"]) pose.push((a[k].x - a.s.x) / body.W, (a[k].y - a.s.y) / body.W);
  return { pose, hand: hand ? hand.ext : Array(5).fill(UNKNOWN) };
}

function featDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.pose.length; i++) s += (a.pose[i] - b.pose[i]) ** 2;
  let h = 0;
  for (let i = 0; i < a.hand.length; i++) {
    if (a.hand[i] !== UNKNOWN && b.hand[i] !== UNKNOWN) h += Math.abs(a.hand[i] - b.hand[i]);
  }
  return Math.sqrt(s / a.pose.length) + (0.6 * h) / a.hand.length;
}

function matchCustom(f, side) {
  let best = null, bd = 0.35;
  for (const c of settings.custom) {
    if (c.side !== side) continue;
    const d = featDist(f, c.feat);
    if (d < bd) { bd = d; best = c.id; }
  }
  return best;
}

let recording = null;

recBtn.addEventListener("click", async () => {
  if (recording) return;
  recBtn.disabled = true;
  recBtn.textContent = "준비 중";
  try {
    await ensureCamera();
  } catch (err) {
    console.error(err);
    recBtn.disabled = false;
    recBtn.textContent = "녹화";
    return toast("카메라를 켜지 못했어요: " + err.message);
  }
  const side = customSide.value;
  const name = customName.value.trim() || `내 동작 ${settings.custom.length + 1}`;
  const now = performance.now();
  recording = { name, side, startAt: now + 3000, until: now + 5000, samples: [] };
  toast(`3초 뒤 ${SIDE_NAME[side]} 자세를 기록해요`);
});

function handleRecording(feats, now) {
  const r = recording;
  if (now < r.startAt) {
    const left = Math.ceil((r.startAt - now) / 1000);
    camStatus.textContent = `${left}초 뒤 ${SIDE_NAME[r.side]} 자세를 기록해요`;
    recBtn.textContent = `${left}…`;
    return;
  }
  if (now < r.until) {
    if (feats[r.side]) r.samples.push(feats[r.side]);
    camStatus.textContent = "기록 중… 그대로 멈춰 있어요";
    recBtn.textContent = "기록 중";
    return;
  }
  recording = null;
  recBtn.disabled = false;
  recBtn.textContent = "녹화";
  releaseCamera();
  if (r.samples.length < 10) return toast("몸이 잘 안 보여서 기록하지 못했어요");

  const n = r.samples.length;
  const pose = r.samples[0].pose.map((_, i) => r.samples.reduce((s, f) => s + f.pose[i], 0) / n);
  const hand = r.samples[0].hand.map((_, i) => {
    const seen = r.samples.map((f) => f.hand[i]).filter((v) => v !== UNKNOWN);
    if (seen.length < n / 2) return UNKNOWN;
    return Math.round(seen.reduce((s, v) => s + v, 0) / seen.length);
  });
  settings.custom.push({ id: `c${Date.now()}`, name: r.name, side: r.side, feat: { pose, hand } });
  saveSettings();
  customName.value = "";
  buildMapRows(); // 작업 중인 연결은 그대로 두고 목록만 새로 그림
  buildCustomList();
  toast(`${SIDE_NAME[r.side]} '${r.name}' 저장했어요. 위에서 기능에 연결해 보세요`);
}

/* ---------- 연결 판정 · 실행 ---------- */

const gstate = {}; // 연결 줄(key) → 유지 상태
const gState = (id) => (gstate[id] ||= { start: 0, armed: true, offSince: 0, lastOn: 0, active: false, progress: 0 });
const flashAt = {}; // 기능 id → 마지막 실행 시각
let lastFire = 0;

// true를 돌려주면 실행. 한 번 실행되면 자세를 풀었다가 다시 해야 재실행됨
function step(id, on, now, holdMs) {
  const g = gState(id);
  if (on) g.lastOn = now;
  else if (now - g.lastOn < 150) on = true; // 인식이 한두 프레임 끊겨도 이어서 셈
  g.active = on;
  if (on) {
    g.offSince = 0;
    if (!g.start) g.start = now;
    g.progress = g.armed ? Math.min(1, (now - g.start) / holdMs) : 0;
    if (g.armed && now - g.start >= holdMs) {
      g.armed = false;
      g.progress = 0;
      return true;
    }
  } else {
    g.start = 0;
    g.progress = 0;
    if (!g.offSince) g.offSince = now;
    if (now - g.offSince > 250) g.armed = true;
  }
  return false;
}

const satisfied = (b, act) => SIDES.every((s) => !b[s] || act[s].has(b[s]));

// act: { L: Set, R: Set } 지금 유지 중인 동작. dry = 실험 모드(실행하지 않고 판정만)
function evaluate(act, now, dry) {
  const bs = bindings();
  const holding = new Set(); // 지금 조건을 만족하는 기능
  const hits = [];

  for (const b of bs) {
    if (isMotion(b)) continue;
    let on = satisfied(b, act);
    // 한 손만 쓰는 연결은, 같은 동작이 양손 동작의 일부로 지금 쓰이는 중이면 쉼 (예: 오른손 손바닥 vs 양손 손바닥)
    if (on && !(b.L && b.R)) {
      const s = b.L ? "L" : "R";
      if (bs.some((c) => c !== b && c.L && c.R && c[s] === b[s] && act[other(s)].has(c[other(s)]))) on = false;
    }
    if (on) holding.add(b.action.id);
    if (b.action.continuous) continue; // 화면 이동은 유지 시간 없이 바로 작동
    if (!dry && step(b.key, on, now, holdOf(b))) hits.push(b);
  }

  // 움직임: 양손 동작을 먼저 맞춰봄
  pending = pending.filter((e) => now - e.t < 800 && !e.used);
  const motionBs = bs.filter(isMotion).sort((x, y) => (y.L && y.R ? 1 : 0) - (x.L && x.R ? 1 : 0));
  for (const b of motionBs) {
    if (b.action.continuous) continue;
    const evs = [];
    let ok = true;
    for (const s of SIDES) {
      if (!b[s]) continue;
      if (findHand(s, b[s]).kind === "motion") {
        const e = pending.find((e) => !e.used && e.side === s && e.id === b[s]);
        if (e) evs.push(e);
        else ok = false;
      } else if (!act[s].has(b[s])) ok = false;
    }
    if (!ok) continue;
    if (evs.length === 2 && Math.abs(evs[0].t - evs[1].t) > 500) continue;
    // 한 손 움직임은, 다른 손과 짝지을 양손 동작이 있으면 잠깐 기다려 봄
    if (evs.length === 1 && !(b.L && b.R)) {
      const e = evs[0];
      const partner = bs.some((c) => c !== b && c.L && c.R && c[e.side] === e.id);
      if (partner && now - e.t < 500) continue;
    }
    evs.forEach((e) => (e.used = true));
    hits.push(b);
  }
  return { holding, hits };
}

/* ---------- 손가락 커서: 이동 점(노란) · 그리기 점 ---------- */

const drawCursorEl = $("drawCursor");
const cursors = {
  move: { el: pointerEl, x: 0, y: 0, visible: false, last: null },
  draw: { el: drawCursorEl, x: 0, y: 0, visible: false, since: 0, lostAt: 0, stroke: null },
};

// 기능에 연결된 동작을 지금 하고 있는 손 (양손 동작이면 오른손)
function handOf(actionId, act, handBySide) {
  const b = bindings().find((b) => b.action.id === actionId && satisfied(b, act));
  if (!b) return null;
  return handBySide[b.def.side === "B" ? "R" : b.def.side];
}

// 손가락 끝을 몸 기준 상자 안에서 무대 좌표(0~1)로 바꿔 부드럽게 따라감 (거울 방향)
function trackCursor(c, hand, body) {
  let u, v;
  if (body) {
    const cx = (body.L.s.x + body.R.s.x) / 2;
    const boxW = 3 * body.W, boxH = 2.2 * body.W;
    u = 1 - (hand.tip.x - (cx - boxW / 2)) / boxW;
    v = (hand.tip.y - (body.shoulderY - 1.2 * body.W)) / boxH;
  } else {
    u = 1 - hand.tip.x / A;
    v = hand.tip.y;
  }
  u = clamp(u, 0, 1);
  v = clamp(v, 0, 1);
  if (!c.visible) {
    c.x = u;
    c.y = v;
  } else {
    c.x += (u - c.x) * 0.35;
    c.y += (v - c.y) * 0.35;
  }
  c.visible = true;
}

function placeCursor(c) {
  if (!c.visible) {
    c.el.style.display = "none";
    return null;
  }
  const st = stage.getBoundingClientRect();
  const x = c.x * st.width, y = c.y * st.height;
  c.el.style.display = "block";
  c.el.style.left = `${x}px`;
  c.el.style.top = `${y}px`;
  return { x, y, cx: st.left + x, cy: st.top + y };
}

// 노란 점: 확대했을 땐 상하좌우 화살표 모양이 되고, 움직이면 화면이 같이 끌려감
function updateMoveCursor(hand, body) {
  const c = cursors.move;
  if (hand) trackCursor(c, hand, body);
  else c.visible = false;
  const pos = placeCursor(c);
  const panning = zoom > 1 && !overview;
  pointerEl.classList.toggle("move", panning);
  if (pos && panning && c.last) movePan(pos.x - c.last.x, pos.y - c.last.y);
  c.last = pos && panning ? pos : null;

  // 목록 보기에서는 노란 점이 올라간 슬라이드를 선택
  if (pos && overview) {
    const el = document.elementFromPoint(pos.cx, pos.cy)?.closest(".thumb");
    if (el && +el.dataset.index !== selected) {
      selected = +el.dataset.index;
      markSelected();
    }
  }
}

// 그리기 점: 지금 도구의 색/모양. 0.2초 유지한 뒤부터 써짐 (자세를 바꾸는 중 생기는 낙서 방지)
function updateDrawCursor(hand, body, now) {
  const c = cursors.draw;
  if (hand) {
    c.lostAt = 0;
    trackCursor(c, hand, body);
    if (!c.since) c.since = now;
  } else if (c.visible) {
    if (!c.lostAt) c.lostAt = now;
    if (now - c.lostAt > 150) {
      c.visible = false; // 잠깐 놓친 건 이어서 쓰고, 오래 놓치면 획을 끝냄
      c.since = 0;
      c.stroke = null;
    }
  }
  const pos = placeCursor(c);
  if (pos && hand && now - c.since > 200 && !overview && slides.length) {
    const p = slidePoint(pos.cx, pos.cy);
    if (!c.stroke) c.stroke = beginStroke(p);
    else extendStroke(c.stroke, p);
  }
  drawCursorEl.classList.toggle("inking", !!c.stroke);
}

function hideCursors() {
  for (const c of Object.values(cursors)) {
    c.visible = false;
    c.el.style.display = "none";
  }
  cursors.draw.stroke = null;
  cursors.draw.since = 0;
  cursors.move.last = null;
}

/* ---------- 프레임마다 ---------- */

function onFrame(lm, hands, handedness, now) {
  A = video.videoWidth / video.videoHeight || 4 / 3;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const act = { L: new Set(), R: new Set() };
  let body = null;

  if (lm) {
    const L = armPoints(lm, "L");
    const R = armPoints(lm, "R");
    const W = Math.max(dist(L.s, R.s), 0.05);
    body = { L, R, W, shoulderY: (L.s.y + R.s.y) / 2, state: { L: analyzeArm(L, "L", W), R: analyzeArm(R, "R", W) } };
    for (const s of SIDES) {
      if (body.state[s].sideways) act[s].add("armOut");
      if (body.state[s].raised) act[s].add("armUp");
    }
    drawArm(ctx, L, body.state.L);
    drawArm(ctx, R, body.state.R);
  } else {
    hist.L.length = hist.R.length = 0;
  }

  const handInfos = hands.map((h, i) => handInfo(h, handedness[i]));
  const handBySide = assignHands(handInfos, body);
  for (const h of handInfos) {
    // 손을 가슴 높이 이상으로 들어 보여줄 때만 손 모양으로 인식
    h.shown = !body || h.wrist.y < body.shoulderY + 0.8 * body.W;
    drawHand(ctx, h);
    if (h.side && h.shown && h.shape) act[h.side].add(h.shape);
  }

  const feats = { L: featureOf(body, "L", handBySide.L), R: featureOf(body, "R", handBySide.R) };
  if (recording) return handleRecording(feats, now);
  for (const s of SIDES) {
    const m = feats[s] && matchCustom(feats[s], s);
    if (m) act[s].add(m);
  }
  const seen = labSeen;
  if (body) detectSwipes(body, handBySide, now, seen);
  detectFistOpen(handBySide, now, seen);

  const { holding, hits } = evaluate(act, now, labOpen);
  if (labOpen) return updateLab(lm, handInfos, act, holding, hits, now);
  if (!presenting) return; // 발표 중지 상태에서는 동작으로 아무것도 실행하지 않음

  for (const b of hits) {
    flashAt[b.action.id] = now;
    if (now - lastFire > 500) {
      lastFire = now;
      b.action.run();
    }
  }
  updateMoveCursor(holding.has("pan") && handOf("pan", act, handBySide), body);
  updateDrawCursor(holding.has("draw") && handOf("draw", act, handBySide), body, now);
  updateStatus(body, holding);
  if (!settingsEl.hidden) updateDots(holding, now);
}

function updateStatus(body, holding) {
  // 실행을 기다리는 연결이 있으면 진행도를 보여줌
  let best = null;
  for (const b of bindings()) {
    const g = gstate[b.key];
    if (g && g.progress > 0 && (!best || g.progress > best.p)) best = { b, p: g.progress };
  }
  if (best) {
    const n = Math.round(best.p * 5);
    camStatus.textContent = `${fullLabel(best.b.def)} → ${best.b.action.label}  ${"■".repeat(n)}${"□".repeat(5 - n)}`;
    return;
  }
  const parts = [];
  if (holding.has("pan") && zoom > 1) parts.push("화면 이동 중");
  if (holding.has("draw")) parts.push(`그리기: ${PENS[tool].label}`);
  if (overview) parts.push("목록 보기");
  if (zoom > 1) parts.push(`확대 ${Math.round(zoom * 100)}%`);
  parts.push(body ? "인식 중" : "사람이 안 보여요. 상반신이 나오게 서 주세요");
  camStatus.textContent = parts.join(" · ");
}

function updateDots(holding, now) {
  for (const row of mapRows.querySelectorAll(".map-block")) {
    const id = row.dataset.action;
    const dot = row.querySelector(".dot");
    dot.classList.toggle("on", holding.has(id));
    dot.classList.toggle("fire", now - (flashAt[id] ?? -Infinity) < 500);
  }
}

/* ---------- 카메라 화면 위 그림 ---------- */

const px = (p) => [(p.x / A) * overlay.width, p.y * overlay.height];

function drawArm(ctx, arm, state) {
  const color = state.sideways || state.raised ? "#3ddc97" : state.visible ? "#4f8cff" : "#666";
  const pts = [arm.s, arm.e, arm.w, arm.i];
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  pts.forEach((p, k) => (k ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
  ctx.stroke();
  ctx.fillStyle = "#fff";
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(...px(p), 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

const HAND_LINKS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17]];

// 손 뼈대 + 검지를 세웠으면 손가락 끝에 노란 점
function drawHandOn(ctx, h, at, color, width) {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  for (const chain of HAND_LINKS) {
    ctx.beginPath();
    chain.forEach((i, k) => (k ? ctx.lineTo(...at(h.pts[i])) : ctx.moveTo(...at(h.pts[i]))));
    ctx.stroke();
  }
  if (h.shown && h.shape === "point") {
    ctx.fillStyle = "#ffd400";
    ctx.beginPath();
    ctx.arc(...at(h.tip), width * 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawHand(ctx, h) {
  drawHandOn(ctx, h, px, h.shown && h.shape ? "#ffb547" : "#ffffff88", 2);
}

/* ================= 동작 실험하기 ================= */

const lab = $("lab"), labCanvas = $("labCanvas"), labMsg = $("labMsg"), labFn = $("labFn");
const labText = { L: $("labL"), R: $("labR") };
const labList = { L: $("labListL"), R: $("labListR"), B: $("labListB") };
let labOpen = false;
const labSeen = { L: {}, R: {} }; // 움직임은 순간이라 1초간 표시를 유지
const labFired = {}; // 기능 id → 마지막으로 맞은 시각

$("testBtn").addEventListener("click", async () => {
  labOpen = true;
  lab.hidden = false;
  if (!settingsEl.hidden) closeSettings();
  labMsg.textContent = "카메라 준비 중…";
  buildLabLists();
  try {
    await ensureCamera();
  } catch (err) {
    console.error(err);
    labMsg.textContent = "카메라/모델을 시작하지 못했어요: " + err.message;
  }
});
$("labClose").addEventListener("click", closeLab);

function closeLab() {
  labOpen = false;
  lab.hidden = true;
  releaseCamera(); // 발표 중이 아니면 카메라를 끔
}

// 오른손 · 왼손 · 양손 동작 목록을 만들고, 각 동작에 연결된 기능을 함께 적음
function buildLabLists() {
  const bs = bindings(true);
  for (const grp of gestureGroups()) {
    const ul = labList[grp.side];
    ul.innerHTML = "";
    for (const key of grp.keys) {
      const d = gestureDef(key);
      const li = document.createElement("li");
      li.dataset.key = key;
      li.textContent = d.label;
      const small = document.createElement("small");
      const uses = bs
        .filter((b) => b.def.key === key)
        .map((b) => b.action.label + (settings.enabled[b.action.id] ? "" : " (꺼짐)"));
      small.textContent = uses.length ? `→ ${uses.join(", ")}` : "연결된 기능 없음";
      li.append(small);
      ul.append(li);
    }
  }
}

function updateLab(lm, handInfos, act, holding, hits, now) {
  labMsg.textContent = lm ? "인식 중이에요. 동작 설정에 있는 동작을 해 보세요" : "사람이 안 보여요. 상반신이 나오게 서 주세요";
  // 한 손 동작이 지금 되고 있는지 (움직임은 1초간 유지)
  const on = (s, id) => act[s].has(id) || now - (labSeen[s][id] ?? -Infinity) < 1000;
  for (const s of SIDES) {
    const names = [];
    for (const li of labList[s].children) {
      const d = gestureDef(li.dataset.key);
      const hit = on(s, d[s]);
      li.classList.toggle("on", hit);
      if (hit) names.push(d.label);
    }
    labText[s].textContent = names.length ? names.join(" + ") : "—";
    labText[s].classList.toggle("idle", !names.length);
  }
  for (const li of labList.B.children) {
    const d = gestureDef(li.dataset.key);
    li.classList.toggle("on", on("L", d.L) && on("R", d.R));
  }

  for (const b of hits) labFired[b.action.id] = now;
  const fns = ACTIONS.filter((a) => holding.has(a.id) || now - (labFired[a.id] ?? -Infinity) < 1000);
  labFn.textContent = fns.length ? fns.map((a) => a.label).join(", ") : "없음";

  drawLab(lm, handInfos);
}

const POSE_LINKS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [0, 2], [0, 5], [2, 7], [5, 8], [9, 10],
];
const ARM_IDS = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);

function drawLab(lm, handInfos) {
  const w = video.videoWidth, h = video.videoHeight;
  if (labCanvas.width !== w) labCanvas.width = w;
  if (labCanvas.height !== h) labCanvas.height = h;
  const ctx = labCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);
  ctx.fillStyle = "#0006"; // 영상을 살짝 어둡게 해서 뼈대가 잘 보이게
  ctx.fillRect(0, 0, w, h);

  if (lm) {
    const ok = (i) => (lm[i].visibility ?? 1) > 0.5;
    const at = (i) => [lm[i].x * w, lm[i].y * h];
    ctx.lineCap = "round";
    for (const [a, b] of POSE_LINKS) {
      if (!ok(a) || !ok(b)) continue;
      const arm = ARM_IDS.has(a) && ARM_IDS.has(b);
      ctx.strokeStyle = arm ? "#3ddc97" : "#4f8cff";
      ctx.lineWidth = arm ? 7 : 5;
      ctx.beginPath();
      ctx.moveTo(...at(a));
      ctx.lineTo(...at(b));
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    for (let i = 0; i < 29; i++) {
      if (!ok(i)) continue;
      ctx.beginPath();
      ctx.arc(...at(i), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const hd of handInfos) {
    const at = (p) => [(p.x / A) * w, p.y * h];
    drawHandOn(ctx, hd, at, hd.side === "L" ? "#ffb547" : "#ff6bcb", 3); // 왼손 주황, 오른손 분홍
  }
}
