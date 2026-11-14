// 발표자 화면: 발표 창(index.html)과 BroadcastChannel로 주고받음
// 받는 것: { type: "state", deck, i, n, note, timer, presenting, paused, cur, next }
// 보내는 것: hello / bye / { type: "cmd", cmd } / { type: "note", i, text }

const $ = (id) => document.getElementById(id);
const ch = new BroadcastChannel("gesture-slides");
const send = (m) => ch.postMessage(m);

let state = null;
let shownIndex = -1;
const urls = { cur: null, next: null };

function setImage(which, blob) {
  const img = $(which === "cur" ? "pCur" : "pNext");
  if (urls[which]) URL.revokeObjectURL(urls[which]);
  urls[which] = blob ? URL.createObjectURL(blob) : null;
  if (urls[which]) img.src = urls[which];
  else img.removeAttribute("src");
  img.parentElement.classList.toggle("has", !!blob);
}

function apply(m) {
  state = m;
  $("pDeck").textContent = m.deck || "";
  $("pCount").textContent = m.n ? `${m.i + 1} / ${m.n}` : "– / –";
  $("pCurEmpty").textContent = "발표 창에서 자료를 열어주세요";
  $("pNextEmpty").textContent = m.n ? "마지막 슬라이드예요" : "";
  setImage("cur", m.cur || null);
  setImage("next", m.next || null);

  const st = $("pState");
  st.textContent = !m.presenting ? "발표 전 (동작 인식 꺼짐)" : m.paused ? "동작 인식 멈춤" : "발표 중";
  st.className = "p-state" + (m.presenting ? (m.paused ? " paused" : " live") : "");
  const pb = $("pPause");
  pb.textContent = m.paused ? "동작 인식 다시 시작" : "동작 인식 멈춤";
  pb.classList.toggle("on", !!m.paused);
  pb.disabled = !m.presenting;
  pb.title = m.paused ? `${m.pauseHow}로 다시 시작` : "동작 인식 잠시 멈춤 / 다시 시작 (P)";

  // 메모: 슬라이드가 바뀌었거나 지금 쓰는 중이 아닐 때만 덮어씀
  const note = $("pNote");
  note.disabled = !m.n;
  if (m.i !== shownIndex || document.activeElement !== note) note.value = m.note || "";
  shownIndex = m.i;
  tick();
}

function fmtTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
function tick() {
  const d = new Date();
  $("pClock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (!state) return;
  const t = state.timer;
  const ms = t.acc + (t.start ? Date.now() - t.start : 0);
  $("pTime").textContent = fmtTime(ms);
  $("pTime").classList.toggle("stopped", !t.start);
}
setInterval(tick, 500);
tick();

ch.onmessage = ({ data: m }) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "state") apply(m);
  else if (m.type === "main-ready") send({ type: "hello" }); // 발표 창을 새로고침함
};
send({ type: "hello" });
addEventListener("pagehide", () => send({ type: "bye" }));

// 발표 창이 없으면 알려줌
setTimeout(() => {
  if (!state) {
    $("pState").textContent = "발표 창을 찾지 못했어요. 팔짓 슬라이드 창을 먼저 열어 두세요";
    $("pCurEmpty").textContent = "발표 창(팔짓 슬라이드)이 열려 있어야 해요";
  }
}, 1500);

for (const b of document.querySelectorAll("[data-cmd]")) {
  b.addEventListener("click", () => send({ type: "cmd", cmd: b.dataset.cmd }));
}
$("pTimerReset").addEventListener("click", () => send({ type: "cmd", cmd: "timerReset" }));

let noteTimer;
$("pNote").addEventListener("input", (e) => {
  if (!state?.n) return;
  const i = state.i, text = e.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => send({ type: "note", i, text }), 300);
});
// 슬라이드를 넘기기 전에 쓰던 메모를 바로 보냄
function flushNote() {
  if (!noteTimer) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  if (state?.n) send({ type: "note", i: shownIndex, text: $("pNote").value });
}

addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const k = e.key;
  let cmd = null;
  if (["ArrowRight", "PageDown", " "].includes(k)) cmd = "next";
  else if (["ArrowLeft", "PageUp"].includes(k)) cmd = "prev";
  else if (k === "Home") cmd = "first";
  else if (k === "End") cmd = "last";
  else if (e.code === "KeyP") cmd = "pause";
  if (!cmd) return;
  e.preventDefault();
  flushNote();
  send({ type: "cmd", cmd });
});
for (const b of document.querySelectorAll("[data-cmd]")) b.addEventListener("pointerdown", flushNote);
