"use strict";

// ---- 要素参照 ----
const manuscriptEl = document.getElementById("manuscript");
const docTitleEl = document.getElementById("docTitle");
const instructionEl = document.getElementById("instruction");
const micBtn = document.getElementById("micBtn");
const micLabel = document.getElementById("micLabel");
const micHint = document.getElementById("micHint");
const proofreadBtn = document.getElementById("proofreadBtn");
const editsEl = document.getElementById("edits");
const editsHead = document.getElementById("editsHead");
const summaryEl = document.getElementById("summary");
const emptyState = document.getElementById("emptyState");
const applyAllBtn = document.getElementById("applyAllBtn");
const undoBtn = document.getElementById("undoBtn");
const charCount = document.getElementById("charCount");
const toast = document.getElementById("toast");
const docListEl = document.getElementById("docList");
const docEmptyEl = document.getElementById("docEmpty");
const newDocBtn = document.getElementById("newDocBtn");
const saveState = document.getElementById("saveState");
const previewToggle = document.getElementById("previewToggle");
const previewEl = document.getElementById("preview");
const backdropEl = document.getElementById("backdrop");
const backdropContent = document.getElementById("backdropContent");
const stylePresets = document.getElementById("stylePresets");
const autoToggle = document.getElementById("autoToggle");
const handsfreeToggle = document.getElementById("handsfreeToggle");
const sampleBtn = document.getElementById("sampleBtn");
const ttsBtn = document.getElementById("ttsBtn");
const histBtn = document.getElementById("histBtn");
const histModal = document.getElementById("histModal");
const histClose = document.getElementById("histClose");
const histList = document.getElementById("histList");
const histEmpty = document.getElementById("histEmpty");
const histExport = document.getElementById("histExport");

let currentEdits = [];
const undoStack = [];
let currentDocId = null;
let docs = [];
let saveTimer = null;
let creating = false;       // 新規作成の二重発火防止
let previewMode = false;

// ---- トースト ----
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

// ---- 文字数 ----
function updateCount() { charCount.textContent = manuscriptEl.value.length; }

// ---- 日時表示 ----
function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ============ 原稿管理 ============

async function loadDocs(selectId) {
  try {
    const res = await fetch("/api/docs");
    const data = await res.json();
    docs = data.docs || [];
  } catch (e) {
    showToast("原稿一覧の取得に失敗しました。");
    docs = [];
  }
  renderDocList();

  if (selectId) {
    openDoc(selectId);
  } else if (currentDocId && docs.some((d) => d.id === currentDocId)) {
    // 現在の選択を維持
  } else if (docs.length > 0) {
    openDoc(docs[0].id);
  } else {
    clearEditor();
  }
}

function renderDocList() {
  docListEl.innerHTML = "";
  docEmptyEl.classList.toggle("hidden", docs.length > 0);

  docs.forEach((d) => {
    const li = document.createElement("li");
    li.className = "doc-item" + (d.id === currentDocId ? " active" : "");
    li.dataset.id = d.id;
    li.innerHTML = `
      <span class="doc-name">${escapeHtml(d.title || "無題の原稿")}</span>
      <span class="doc-meta">
        <span class="doc-date">${fmtDate(d.updated_at)}</span>
        <button class="doc-del" title="削除"><i class="fa-regular fa-trash-can"></i></button>
      </span>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".doc-del")) return;
      openDoc(d.id);
    });
    li.querySelector(".doc-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDoc(d.id, d.title);
    });
    docListEl.appendChild(li);
  });
}

async function openDoc(id) {
  if (id === currentDocId) return;
  flushSave(); // 切替前に保存を確定
  try {
    const res = await fetch(`/api/docs/${id}`);
    if (!res.ok) { showToast("原稿を開けませんでした。"); return; }
    const doc = await res.json();
    currentDocId = id;
    docTitleEl.value = doc.title || "";
    manuscriptEl.value = doc.body || "";
    clearHighlight();
    resetReviewUI();
    undoStack.length = 0;
    undoBtn.disabled = true;
    enableEditor(true);
    updateCount();
    if (previewMode) renderPreview();
    renderDocList();
    saveState.textContent = "保存済み";
  } catch (e) {
    showToast("原稿の読み込みに失敗しました。");
  }
}

function clearEditor() {
  currentDocId = null;
  docTitleEl.value = "";
  manuscriptEl.value = "";
  enableEditor(false);
  updateCount();
  saveState.textContent = "";
}

function enableEditor(on) {
  manuscriptEl.disabled = !on;
  docTitleEl.disabled = !on;
  previewToggle.disabled = !on;
  termBtn.disabled = !on;
  ttsBtn.disabled = !on;
  histBtn.disabled = !on;
}

// 原稿を切り替えたら、前の原稿に対する案や読み上げは仕切り直す。
function resetReviewUI() {
  if (ttsActive) stopTTS();
  currentEdits = [];
  genQueue.length = 0;
  exchangeHistory.length = 0;
  editsEl.innerHTML = "";
  editsHead.classList.add("hidden");
  summaryEl.classList.add("hidden");
  emptyState.classList.remove("hidden");
  emptyState.querySelector("p").innerHTML =
    "プランシェットは静かに待っています。<br>原稿と声の指示があれば、赤入れ案がここに並びます。<br><small>案は採用ボタンを押すまで原稿に反映されません。</small>";
}

newDocBtn.addEventListener("click", async () => {
  if (creating) return;
  creating = true;
  flushSave();
  try {
    const res = await fetch("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "無題の原稿", body: "" }),
    });
    const meta = await res.json();
    await loadDocs(meta.id);
    docTitleEl.focus();
    docTitleEl.select();
  } catch (e) {
    showToast("原稿の作成に失敗しました。");
  } finally {
    creating = false;
  }
});

async function deleteDoc(id, title) {
  if (!confirm(`「${title || "無題の原稿"}」を削除します。よろしいですか？`)) return;
  try {
    await fetch(`/api/docs/${id}`, { method: "DELETE" });
    if (id === currentDocId) currentDocId = null;
    await loadDocs();
    showToast("原稿を削除しました。");
  } catch (e) {
    showToast("削除に失敗しました。");
  }
}

// ---- 自動保存 ----
function scheduleSave() {
  if (!currentDocId) return;
  saveState.textContent = "編集中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1000);
}

async function doSave() {
  if (!currentDocId) return;
  const payload = { title: docTitleEl.value, body: manuscriptEl.value };
  try {
    const res = await fetch(`/api/docs/${currentDocId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      saveState.textContent = "保存済み";
      // 一覧のタイトル・日時を更新
      const meta = await res.json();
      const item = docs.find((d) => d.id === currentDocId);
      if (item) { item.title = meta.title; item.updated_at = meta.updated_at; }
      renderDocList();
    } else {
      saveState.textContent = "保存失敗";
    }
  } catch (e) {
    saveState.textContent = "保存失敗";
  }
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; doSave(); }
}

window.addEventListener("beforeunload", flushSave);

// ---- エディタ入力 ----
manuscriptEl.addEventListener("input", () => {
  updateCount();
  clearHighlight(); // 本文が変わったらハイライトの位置情報は古くなる
  if (previewMode) renderPreview();
  scheduleSave();
});
docTitleEl.addEventListener("input", scheduleSave);

// ============ プランシェット（原稿ハイライト） ============
// 赤入れ案にカーソルを乗せると、原稿の該当箇所へハイライトが滑っていく。
// textarea の背面に同じメトリクスのミラー層を置き、mark で印を付ける方式。

manuscriptEl.addEventListener("scroll", () => {
  backdropEl.scrollTop = manuscriptEl.scrollTop;
});

let flashTimer = null;

function showHighlight(target, { flash = false } = {}) {
  if (previewMode || !target) return false;
  const text = manuscriptEl.value;
  const i = text.indexOf(target);
  if (i === -1) return false;

  backdropContent.innerHTML =
    escapeHtml(text.slice(0, i)) +
    `<mark${flash ? ' class="flash"' : ""}>${escapeHtml(target)}</mark>` +
    escapeHtml(text.slice(i + target.length));

  // 印の位置まで、ぬるりとスクロールして指し示す。
  const mark = backdropContent.querySelector("mark");
  if (mark) {
    const top = mark.offsetTop - manuscriptEl.clientHeight / 2 + mark.offsetHeight / 2;
    manuscriptEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }
  return true;
}

function clearHighlight() {
  backdropContent.innerHTML = "";
}

function flashHighlight(target) {
  clearTimeout(flashTimer);
  if (showHighlight(target, { flash: true })) {
    flashTimer = setTimeout(clearHighlight, 1400);
  }
}

// ============ 文体プリセット ============
let currentStyle = "auto";
if (stylePresets) {
  stylePresets.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    currentStyle = chip.dataset.style || "auto";
    stylePresets.querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c === chip));
  });
}

// ---- プレビュー ----
previewToggle.addEventListener("click", () => {
  previewMode = !previewMode;
  if (previewMode) {
    renderPreview();
    previewEl.classList.remove("hidden");
    manuscriptEl.classList.add("hidden");
    previewToggle.innerHTML = '<i class="fa-regular fa-pen-to-square"></i> 編集';
  } else {
    previewEl.classList.add("hidden");
    manuscriptEl.classList.remove("hidden");
    previewToggle.innerHTML = '<i class="fa-regular fa-eye"></i> プレビュー';
  }
});

function renderPreview() {
  if (window.marked) {
    previewEl.innerHTML = window.marked.parse(manuscriptEl.value || "");
  } else {
    previewEl.textContent = manuscriptEl.value;
  }
}

// ---- 元に戻す ----
function pushHistory() {
  undoStack.push(manuscriptEl.value);
  undoBtn.disabled = undoStack.length === 0;
}
undoBtn.addEventListener("click", () => {
  if (undoStack.length === 0) return;
  manuscriptEl.value = undoStack.pop();
  undoBtn.disabled = undoStack.length === 0;
  updateCount();
  if (previewMode) renderPreview();
  scheduleSave();
  showToast("ひとつ前の原稿に戻しました。");
});

// ============ 音声録音（AmiVoice） ============
let mediaRecorder = null;
let chunks = [];
let recording = false;

// ---- 入力レベルメーター ----
// 録音中、マイクのRMSレベルを朱のバーで常時描画する。
// 「声が入っているか」が見えないと、止めて認識するまで不安が続くため。
const micMeter = document.getElementById("micMeter");
const meterCanvas = document.getElementById("meterCanvas");

let audioCtx = null;
let analyser = null;
let meterRaf = 0;
let silentSince = 0;
let silentWarned = false;
let meterPeak = 0;

function startMeter(stream, onLevel) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);

  micMeter.classList.remove("hidden");
  const data = new Uint8Array(analyser.fftSize);
  const ctx = meterCanvas.getContext("2d");
  const W = meterCanvas.width;
  const H = meterCanvas.height;
  const BARS = 21;
  const gap = 3;
  const barW = (W - gap * (BARS - 1)) / BARS;

  silentSince = performance.now();
  silentWarned = false;
  meterPeak = 0;

  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 4); // 感度補正。ふつうの声量で7割くらい振れる
    meterPeak = Math.max(meterPeak * 0.96, level); // ピークはゆっくり落とす

    ctx.clearRect(0, 0, W, H);
    const lit = Math.round(level * BARS);
    const peakBar = Math.round(meterPeak * BARS);
    for (let i = 0; i < BARS; i++) {
      const h = H * (0.35 + 0.65 * (i / (BARS - 1))); // 右ほど背の高いバー
      if (i < lit) ctx.fillStyle = "rgba(188, 59, 38, .85)";        // 朱
      else if (i === peakBar - 1) ctx.fillStyle = "rgba(188, 59, 38, .45)"; // ピークホールド
      else ctx.fillStyle = "rgba(33, 28, 22, .14)";                 // 消灯
      ctx.fillRect(i * (barW + gap), H - h, barW, h);
    }

    if (onLevel) onLevel(level);

    // 無音の見張り。2.5秒入力が無ければ知らせる（戻ったら元の表示に）。
    // ハンズフリー中は無音が通常状態なので見張らない。
    if (hfActive) {
      // noop
    } else if (level > 0.06) {
      silentSince = performance.now();
      if (silentWarned) {
        micHint.textContent = "録音中… 指示を話し終えたら停止してください。";
        silentWarned = false;
      }
    } else if (!silentWarned && performance.now() - silentSince > 2500) {
      micHint.textContent = "マイクに声が入っていないようです。マイクの位置・音量をご確認ください。";
      silentWarned = true;
    }

    meterRaf = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  analyser = null;
  micMeter.classList.add("hidden");
}

micBtn.addEventListener("click", async () => {
  if (micBtn.disabled) return;
  if (!recording) await startRecording();
  else stopRecording();
});

async function startRecording() {
  // 読み上げ中なら止める（マイクが読み上げ音声を拾わないように）。認識後に再開する。
  if (ttsActive && !ttsPaused) {
    speechSynthesis.pause();
    ttsPaused = true;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      sendAudio(new Blob(chunks, { type: "audio/webm" }));
    };
    mediaRecorder.start();
    recording = true;
    startMeter(stream);
    micBtn.classList.add("recording");
    micLabel.textContent = "停止して認識";
    micHint.textContent = "録音中… 指示を話し終えたら停止してください。";
    // スペース起動で、マイク準備中にもうキーが離されていたら即座に締める。
    if (pttSession && !pttDown) {
      stopRecording();
      pttSession = false;
    }
  } catch (e) {
    showToast("マイクを使用できませんでした。ブラウザの権限をご確認ください。");
    micHint.textContent = String(e);
    pttSession = false;
  }
}

function stopRecording() {
  if (mediaRecorder && recording) {
    mediaRecorder.stop();
    recording = false;
    stopMeter();
    micBtn.classList.remove("recording");
    micLabel.textContent = "声で指示";
    micHint.textContent = "音声を認識しています…";
  }
}

// ---- プッシュ・トゥ・トーク（スペース長押し） ----
// スペースを押している間だけ録音し、離した瞬間に認識へ。
// 「話したらそこで一区切り」のリズムを崩さないための入力方式。
// 入力欄にフォーカスがあるときは通常のスペース入力を優先する。
let pttDown = false;     // いまスペースが押されているか
let pttSession = false;  // この録音がスペース起動か

function isTypingTarget(el) {
  return el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
}

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  if (isTypingTarget(document.activeElement)) return;
  if (micBtn.disabled || hfActive) return;
  if (!termModal.classList.contains("hidden")) return;
  if (!histModal.classList.contains("hidden")) return;
  e.preventDefault(); // ページスクロールやボタン押下を抑止
  if (recording) return;
  pttDown = true;
  pttSession = true;
  startRecording();
});

// ---- キーボードで採用 ----
// 1〜9 で対応する番号の案を適用、U でひとつ前に戻す。
// 左手はスペース、右手は数字キーだけで校正が回る。
document.addEventListener("keydown", (e) => {
  if (isTypingTarget(document.activeElement)) return;
  if (!termModal.classList.contains("hidden")) return;
  if (!histModal.classList.contains("hidden")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.code === "KeyU") {
    if (!undoBtn.disabled) {
      e.preventDefault();
      undoBtn.click();
    }
    return;
  }
  const m = /^Digit([1-9])$/.exec(e.code);
  if (m) {
    const actionable = editsEl.querySelectorAll(".edit-card:not(.applied):not(.notfound)");
    const card = actionable[Number(m[1]) - 1];
    if (card) {
      e.preventDefault();
      const btn = card.querySelector(".apply-one");
      if (btn && !btn.disabled) btn.click();
    }
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  pttDown = false;
  if (pttSession && recording) {
    e.preventDefault();
    stopRecording();
    pttSession = false;
  }
});

async function sendAudio(blob) {
  const fd = new FormData();
  fd.append("audio", blob, "instruction.webm");
  try {
    const res = await fetch("/api/transcribe", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      micHint.textContent = data.error || "認識に失敗しました。";
      showToast("音声認識に失敗しました。");
      return;
    }
    const text = (data.text || "").trim();
    if (!text) {
      micHint.textContent = "認識結果が空でした。もう一度お試しください。";
      return;
    }
    instructionEl.value = instructionEl.value
      ? instructionEl.value.replace(/\s*$/, "") + " " + text
      : text;
    // オート時はそのまま生成キューへ。読み上げ → 思いついたら話す → 案が並ぶ、を止めない。
    if (autoToggle && autoToggle.checked) {
      const instruction = instructionEl.value.trim();
      instructionEl.value = "";
      micHint.textContent = "認識しました。校正案を生成します…";
      enqueueProofread(instruction);
    } else {
      micHint.textContent = "認識しました。内容を確認・修正してから生成してください。";
    }
  } catch (e) {
    micHint.textContent = "通信エラー: " + e;
  } finally {
    // 耳校正の読み上げを録音のために止めていたら再開する。
    if (ttsPaused) {
      speechSynthesis.resume();
      ttsPaused = false;
    }
  }
}

// ============ 校正案の生成（キュー） ============
// 生成中に次の発話が来ても取りこぼさないよう、指示はキューで順に処理する。
// 未採用の案は消さず、新しい案を上に積む。
const genQueue = [];
let generating = false;
// 直前のやりとり。「いや、その字は学校の校」のような言い直しを
// Claude が解釈できるよう、直近3回ぶんの指示と案を一緒に送る。
const exchangeHistory = [];

function enqueueProofread(instruction) {
  if (!instruction) return;
  genQueue.push(instruction);
  processQueue();
}

async function processQueue() {
  if (generating) return;
  const instruction = genQueue.shift();
  if (instruction === undefined) return;

  const manuscript = manuscriptEl.value.trim();
  if (!manuscript) {
    showToast("原稿を入力してください。");
    genQueue.length = 0;
    return;
  }

  generating = true;
  proofreadBtn.disabled = true;
  proofreadBtn.innerHTML =
    '<i class="fa-solid fa-spinner fa-spin"></i> 生成中…' +
    (genQueue.length ? `（待ち ${genQueue.length}）` : "");
  try {
    const res = await fetch("/api/proofread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manuscript, instruction, style: currentStyle,
        history: exchangeHistory.slice(-3),
      }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "生成に失敗しました。"); return; }
    renderResult(data);
    exchangeHistory.push({
      instruction,
      edits: (data.edits || []).map((e) => ({ before: e.before, after: e.after })),
    });
    if (exchangeHistory.length > 3) exchangeHistory.shift();
  } catch (e) {
    showToast("通信エラー: " + e);
  } finally {
    generating = false;
    proofreadBtn.disabled = false;
    proofreadBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 校正案を生成';
    processQueue(); // 待ちがあれば続けて処理
  }
}

proofreadBtn.addEventListener("click", () => {
  const instruction = instructionEl.value.trim();
  if (!instruction) { showToast("指示を入力してください。"); return; }
  instructionEl.value = ""; // 案にした指示は役目を終えたのでクリア
  micHint.textContent = "";
  enqueueProofread(instruction);
});

function renderResult(data) {
  const newEdits = (data.edits || []).map((e) => ({ ...e, applied: false }));

  if (data.summary) {
    summaryEl.textContent = data.summary;
    summaryEl.classList.remove("hidden");
  }

  if (newEdits.length === 0) {
    if (!editsEl.querySelector(".edit-card")) {
      editsHead.classList.add("hidden");
      emptyState.classList.remove("hidden");
      emptyState.querySelector("p").textContent = "修正が必要な箇所は見つかりませんでした。";
    } else {
      showToast("追加の修正は見つかりませんでした。");
    }
    return;
  }

  emptyState.classList.add("hidden");
  editsHead.classList.remove("hidden");

  // 配列は伸ばすだけにして idx を安定させ、新しい案ほど上に並べる。
  const baseIdx = currentEdits.length;
  currentEdits.push(...newEdits);
  for (let i = newEdits.length - 1; i >= 0; i--) {
    editsEl.prepend(buildCard(newEdits[i], baseIdx + i, newEdits.length - 1 - i));
  }
  renumberCards();
}

// 採用待ちのカードに 1〜9 の番号バッジを振り直す（数字キー採用用）。
function renumberCards() {
  editsEl.querySelectorAll(".kbd-num").forEach((el) => el.remove());
  const actionable = editsEl.querySelectorAll(".edit-card:not(.applied):not(.notfound)");
  actionable.forEach((card, i) => {
    if (i >= 9) return;
    const b = document.createElement("span");
    b.className = "kbd-num";
    b.textContent = i + 1;
    card.appendChild(b);
  });
}

// 適用済みカードはひと呼吸おいてからすっと消す（履歴には残る）。
function fadeRemoveCard(card) {
  setTimeout(() => {
    card.classList.add("fade-out");
    setTimeout(() => {
      card.remove();
      renumberCards();
      if (!editsEl.querySelector(".edit-card")) {
        editsHead.classList.add("hidden");
        emptyState.classList.remove("hidden");
        emptyState.querySelector("p").textContent = "すべて反映しました。続きをどうぞ。";
      }
    }, 380);
  }, 1100);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// before/after の共通部分を取り除き、実際に変わった中身だけを強調する。
// 共通の前置き・後置きを剥がすだけの軽い差分（典型的な置換ならこれで十分効く）。
function diffParts(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return {
    pre: a.slice(0, p),
    aMid: a.slice(p, a.length - s),
    bMid: b.slice(p, b.length - s),
    suf: s ? a.slice(a.length - s) : "",
  };
}

function diffHtml(text, mid, pre, suf) {
  if (!mid || (!pre && !suf)) return escapeHtml(text); // 全部変わったなら強調しない
  return (
    escapeHtml(pre) +
    `<span class="diff-core">${escapeHtml(mid)}</span>` +
    escapeHtml(suf)
  );
}

const TYPE_CLASS = {
  "誤字脱字": "t-typo",
  "表記ゆれ": "t-orth",
  "文体": "t-style",
  "冗長": "t-verbose",
  "その他": "t-other",
};

function buildCard(edit, idx, animPos = 0) {
  const card = document.createElement("div");
  card.className = "edit-card";
  card.dataset.idx = idx;
  card.style.animationDelay = `${animPos * 70}ms`; // 一枚ずつ滑り込む

  const found = manuscriptEl.value.includes(edit.before);
  const d = diffParts(edit.before, edit.after || "");
  const afterDisplay = edit.after === ""
    ? '<span class="after">（削除）</span>'
    : `<span class="after">${diffHtml(edit.after, d.bMid, d.pre, d.suf)}</span>`;
  const typeTag = edit.type
    ? `<span class="type-tag ${TYPE_CLASS[edit.type] || "t-other"}">${escapeHtml(edit.type)}</span>`
    : "";

  card.innerHTML = `
    <div class="edit-top">
      <label>
        <input type="checkbox" class="pick" ${found ? "checked" : ""} ${found ? "" : "disabled"}>
        採用
      </label>
      ${typeTag}
    </div>
    <div class="edit-diff">
      <span class="before">${diffHtml(edit.before, d.aMid, d.pre, d.suf)}</span>
      <span class="arrow"><i class="fa-solid fa-arrow-right-long"></i></span>
      ${afterDisplay}
    </div>
    ${edit.reason ? `<div class="edit-reason"><i class="fa-regular fa-comment"></i> ${escapeHtml(edit.reason)}</div>` : ""}
    ${found ? `<div class="row"><button class="btn small apply-one"><i class="fa-solid fa-check"></i> この修正を適用</button></div>`
            : `<div class="edit-reason"><i class="fa-solid fa-triangle-exclamation"></i> 原稿内に該当文字列が見つかりませんでした（手動でご確認ください）。</div>`}
  `;

  if (!found) card.classList.add("notfound");

  // プランシェット: カードに触れると原稿の該当箇所を指し示す。
  if (found) {
    card.addEventListener("mouseenter", () => {
      if (!currentEdits[idx].applied) showHighlight(currentEdits[idx].before);
    });
    card.addEventListener("mouseleave", clearHighlight);
  }

  const applyOne = card.querySelector(".apply-one");
  if (applyOne) {
    applyOne.addEventListener("click", () => {
      if (applyEdit(idx)) {
        card.classList.add("applied");
        applyOne.disabled = true;
        renumberCards();
        fadeRemoveCard(card);
      }
    });
  }
  return card;
}

// 適用イベントをサーバの履歴に残す（戻す・編集ログ用）。失敗しても本流は止めない。
function postHistory(bodyBefore, edits) {
  if (!currentDocId) return;
  fetch(`/api/docs/${currentDocId}/history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body_before: bodyBefore, edits }),
  }).catch(() => {});
}

function applyEdit(idx) {
  const edit = currentEdits[idx];
  if (edit.applied) return false;
  if (!manuscriptEl.value.includes(edit.before)) {
    showToast("該当箇所が見つかりませんでした。");
    return false;
  }
  // 耳校正の途中なら止める（本文が変わると読み上げ位置がずれるため）。
  if (ttsActive) stopTTS();
  const bodyBefore = manuscriptEl.value;
  pushHistory();
  manuscriptEl.value = manuscriptEl.value.replace(edit.before, edit.after);
  edit.applied = true;
  postHistory(bodyBefore, [edit]);
  updateCount();
  if (previewMode) renderPreview();
  scheduleSave();
  if (edit.after) flashHighlight(edit.after); // 直した箇所を一拍だけ緑で示す
  showToast("修正を適用しました。");
  return true;
}

applyAllBtn.addEventListener("click", () => {
  const cards = editsEl.querySelectorAll(".edit-card");
  const appliedEdits = [];
  let pushed = false;
  const bodyBefore = manuscriptEl.value;
  if (ttsActive) stopTTS();
  cards.forEach((card) => {
    const idx = Number(card.dataset.idx);
    const pick = card.querySelector(".pick");
    const edit = currentEdits[idx];
    if (!pick || !pick.checked || edit.applied) return;
    if (!manuscriptEl.value.includes(edit.before)) return;
    if (!pushed) { pushHistory(); pushed = true; }
    manuscriptEl.value = manuscriptEl.value.replace(edit.before, edit.after);
    edit.applied = true;
    card.classList.add("applied");
    const btn = card.querySelector(".apply-one");
    if (btn) btn.disabled = true;
    appliedEdits.push(edit);
    fadeRemoveCard(card);
  });
  updateCount();
  if (previewMode) renderPreview();
  if (appliedEdits.length > 0) {
    scheduleSave();
    postHistory(bodyBefore, appliedEdits);
    renumberCards();
  }
  showToast(appliedEdits.length > 0 ? `${appliedEdits.length} 件の修正を適用しました。` : "適用できる修正がありませんでした。");
});

// ============ 単語登録の候補 ============
const termBtn = document.getElementById("termBtn");
const termModal = document.getElementById("termModal");
const termClose = document.getElementById("termClose");
const termLoading = document.getElementById("termLoading");
const termBody = document.getElementById("termBody");
const termListEl = document.getElementById("termList");
const termEmptyEl = document.getElementById("termEmpty");
const termCountEl = document.getElementById("termCount");
const termAllBtn = document.getElementById("termAll");
const termNoneBtn = document.getElementById("termNone");
const termRegisterBtn = document.getElementById("termRegister");
const termDownloadBtn = document.getElementById("termDownload");

function closeTermModal() { termModal.classList.add("hidden"); }
termClose.addEventListener("click", closeTermModal);
termModal.addEventListener("click", (e) => { if (e.target === termModal) closeTermModal(); });

termBtn.addEventListener("click", async () => {
  const manuscript = manuscriptEl.value.trim();
  if (!manuscript) { showToast("原稿を入力してください。"); return; }
  termModal.classList.remove("hidden");
  termLoading.classList.remove("hidden");
  termBody.classList.add("hidden");
  try {
    const res = await fetch("/api/extract-terms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manuscript }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "抽出に失敗しました。"); closeTermModal(); return; }
    renderTerms(data.terms || []);
  } catch (e) {
    showToast("通信エラー: " + e);
    closeTermModal();
  } finally {
    termLoading.classList.add("hidden");
    termBody.classList.remove("hidden");
  }
});

function renderTerms(terms) {
  termListEl.innerHTML = "";
  termEmptyEl.classList.toggle("hidden", terms.length > 0);
  terms.forEach((t) => {
    const row = document.createElement("label");
    row.className = "term-row";
    row.innerHTML = `
      <input type="checkbox" class="term-pick" checked>
      <span class="term-surface">${escapeHtml(t.term)}</span>
      <input class="term-reading" type="text" value="${escapeHtml(t.reading)}">
      <span class="term-cat">${escapeHtml(t.category || "—")}</span>
      ${t.note ? `<span class="term-note">${escapeHtml(t.note)}</span>` : ""}`;
    const pick = row.querySelector(".term-pick");
    const reading = row.querySelector(".term-reading");
    reading.addEventListener("click", (e) => e.stopPropagation()); // 読み編集でチェックが切り替わらないように
    pick.addEventListener("change", () => {
      row.classList.toggle("off", !pick.checked);
      updateTermCount();
    });
    termListEl.appendChild(row);
  });
  updateTermCount();
}

function updateTermCount() {
  const total = termListEl.querySelectorAll(".term-row").length;
  const picked = termListEl.querySelectorAll(".term-pick:checked").length;
  termCountEl.textContent = total ? `${picked} / ${total} 件を選択中` : "";
}

termAllBtn.addEventListener("click", () => {
  termListEl.querySelectorAll(".term-row").forEach((row) => {
    row.querySelector(".term-pick").checked = true;
    row.classList.remove("off");
  });
  updateTermCount();
});
termNoneBtn.addEventListener("click", () => {
  termListEl.querySelectorAll(".term-row").forEach((row) => {
    row.querySelector(".term-pick").checked = false;
    row.classList.add("off");
  });
  updateTermCount();
});

function selectedTermsText() {
  const lines = [];
  termListEl.querySelectorAll(".term-row").forEach((row) => {
    if (!row.querySelector(".term-pick").checked) return;
    const surface = row.querySelector(".term-surface").textContent;
    const reading = row.querySelector(".term-reading").value.trim();
    // AmiVoice 形式: 表記［タブ］読み（読みが空なら表記のみ）
    lines.push(reading ? `${surface}\t${reading}` : surface);
  });
  return lines.join("\n");
}

function selectedTermsList() {
  const list = [];
  termListEl.querySelectorAll(".term-row").forEach((row) => {
    if (!row.querySelector(".term-pick").checked) return;
    const term = row.querySelector(".term-surface").textContent;
    const reading = row.querySelector(".term-reading").value.trim();
    list.push({ term, reading });
  });
  return list;
}

termRegisterBtn.addEventListener("click", async () => {
  const words = selectedTermsList();
  if (!words.length) { showToast("選択された語がありません。"); return; }
  if (words.some((w) => !w.reading)) {
    showToast("読みが空の語があります。読みを入力してから登録してください。");
    return;
  }
  termRegisterBtn.disabled = true;
  const orig = termRegisterBtn.innerHTML;
  termRegisterBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 登録中…';
  try {
    const res = await fetch("/api/register-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "登録に失敗しました。"); return; }
    showToast(`${data.added} 件を登録しました（辞書合計 ${data.total} 件）。`);
    closeTermModal();
  } catch (e) {
    showToast("通信エラー: " + e);
  } finally {
    termRegisterBtn.disabled = false;
    termRegisterBtn.innerHTML = orig;
  }
});

termDownloadBtn.addEventListener("click", () => {
  const text = selectedTermsText();
  if (!text) { showToast("選択された語がありません。"); return; }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "amivoice_words.txt";
  a.click();
  URL.revokeObjectURL(url);
  showToast("amivoice_words.txt を保存しました。");
});

// ============ ハンズフリー（無音で自動区切り） ============
// マイクを開きっぱなしにして、話し終わり（約1.5秒の無音）で自動的に
// そこまでを一区切りとして認識に送る。スペースすら押さない読み上げ用。
let hfActive = false;
let hfStream = null;
let hfRecorder = null;
let hfChunks = [];
let hfSpeech = false;     // この区間で一度でも声が入ったか
let hfLastVoice = 0;
let hfSegStart = 0;

const HF_VOICE_LEVEL = 0.09;   // これを超えたら「話している」
const HF_SILENCE_MS = 1500;    // 話し終わりとみなす無音時間
const HF_IDLE_RESET_MS = 20000; // 無音だけの区間はこの長さで仕切り直す

if (handsfreeToggle) {
  handsfreeToggle.addEventListener("change", () => hfToggle(handsfreeToggle.checked));
}

async function hfToggle(on) {
  if (on) {
    if (recording) { // PTT・ボタン録音中は開始しない
      handsfreeToggle.checked = false;
      showToast("録音中はハンズフリーに切り替えられません。");
      return;
    }
    if (ttsActive) stopTTS(); // 読み上げ音声をマイクが拾ってしまうため
    try {
      hfStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      handsfreeToggle.checked = false;
      showToast("マイクを使用できませんでした。ブラウザの権限をご確認ください。");
      return;
    }
    hfActive = true;
    micBtn.disabled = true;
    micBtn.classList.add("recording");
    micLabel.textContent = "ハンズフリー中";
    startMeter(hfStream, hfOnLevel);
    hfStartSegment();
    micHint.textContent = "ハンズフリー: 話し終わり（約1.5秒の無音）で自動的に区切ります。";
  } else {
    hfActive = false;
    if (hfRecorder && hfRecorder.state === "recording") {
      hfRecorder.stop(); // onstop 側で hfActive=false を見て打ち切る
    }
    stopMeter();
    if (hfStream) {
      hfStream.getTracks().forEach((t) => t.stop());
      hfStream = null;
    }
    micBtn.disabled = false;
    micBtn.classList.remove("recording");
    micLabel.textContent = "声で指示";
    micHint.textContent = "";
  }
}

function hfStartSegment() {
  if (!hfActive || !hfStream) return;
  hfChunks = [];
  hfSpeech = false;
  hfSegStart = performance.now();
  hfRecorder = new MediaRecorder(hfStream);
  hfRecorder.ondataavailable = (e) => { if (e.data.size > 0) hfChunks.push(e.data); };
  hfRecorder.onstop = () => {
    const blob = new Blob(hfChunks, { type: "audio/webm" });
    const hadSpeech = hfSpeech;
    if (hfActive) hfStartSegment(); // すぐ次の区間の録音を始める（聞き漏らさない）
    if (hadSpeech && blob.size > 2000) {
      micHint.textContent = "一区切り。音声を認識しています…";
      sendAudio(blob);
    }
  };
  hfRecorder.start();
}

function hfOnLevel(level) {
  if (!hfActive || !hfRecorder || hfRecorder.state !== "recording") return;
  const now = performance.now();
  if (level > HF_VOICE_LEVEL) {
    hfSpeech = true;
    hfLastVoice = now;
  }
  if (hfSpeech && now - hfLastVoice > HF_SILENCE_MS) {
    hfRecorder.stop(); // 話し終わり → ここで一区切り
  } else if (!hfSpeech && now - hfSegStart > HF_IDLE_RESET_MS) {
    hfRecorder.stop(); // 無音だけの長い区間は捨てて仕切り直す
  }
}

// ============ 耳校正（原稿の読み上げ） ============
// ブラウザのSpeechSynthesisで原稿を一文ずつ読み上げ、読んでいる文を
// 藍色のハイライトで追いかける。耳で聞くと黙読で滑る誤字に気づける。
// 録音（PTT/ボタン）すると読み上げは一時停止し、認識が終わると再開する。
let ttsActive = false;
let ttsPaused = false;
let ttsSentences = [];
let ttsIndex = 0;

function highlightRange(start, len) {
  const text = manuscriptEl.value;
  backdropContent.innerHTML =
    escapeHtml(text.slice(0, start)) +
    `<mark class="read">${escapeHtml(text.slice(start, start + len))}</mark>` +
    escapeHtml(text.slice(start + len));
  const mark = backdropContent.querySelector("mark");
  if (mark) {
    const top = mark.offsetTop - manuscriptEl.clientHeight / 2 + mark.offsetHeight / 2;
    manuscriptEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }
}

function splitSentences(text) {
  // 「。」「！」「？」と改行で区切り、位置（オフセット）付きで返す。
  const out = [];
  const re = /[^\n。！？]+[。！？]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[0];
    if (t.trim()) out.push({ start: m.index, text: t });
  }
  return out;
}

ttsBtn.addEventListener("click", () => {
  if (ttsActive) { stopTTS(); return; }
  startTTS();
});

function startTTS() {
  if (!window.speechSynthesis) {
    showToast("このブラウザは読み上げに対応していません。");
    return;
  }
  if (hfActive) {
    showToast("ハンズフリー中は読み上げを使えません（マイクが拾ってしまうため）。");
    return;
  }
  const text = manuscriptEl.value;
  if (!text.trim()) { showToast("原稿が空です。"); return; }

  ttsSentences = splitSentences(text);
  if (ttsSentences.length === 0) return;
  ttsActive = true;
  ttsPaused = false;
  ttsIndex = 0;
  ttsBtn.classList.add("tts-active");
  ttsBtn.innerHTML = '<i class="fa-solid fa-stop"></i> 停止';
  micHint.textContent = "読み上げ中。直したくなったらスペースを押して話してください。";
  speakNext();
}

function speakNext() {
  if (!ttsActive || ttsIndex >= ttsSentences.length) {
    if (ttsActive) showToast("最後まで読み上げました。");
    stopTTS();
    return;
  }
  const s = ttsSentences[ttsIndex];
  highlightRange(s.start, s.text.length);
  const u = new SpeechSynthesisUtterance(s.text);
  u.lang = "ja-JP";
  const v = speechSynthesis.getVoices().find((vo) => vo.lang && vo.lang.startsWith("ja"));
  if (v) u.voice = v;
  u.onend = () => { ttsIndex++; if (ttsActive) speakNext(); };
  u.onerror = () => { ttsIndex++; if (ttsActive) speakNext(); };
  speechSynthesis.speak(u);
}

function stopTTS() {
  ttsActive = false;
  ttsPaused = false;
  speechSynthesis.cancel();
  clearHighlight();
  ttsBtn.classList.remove("tts-active");
  ttsBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i> 読み上げ';
}

// 原稿が手で編集されたら読み上げ位置がずれるので止める。
manuscriptEl.addEventListener("input", () => { if (ttsActive) stopTTS(); });

// ============ サンプル原稿 ============
const SAMPLE_TITLE = "サンプル：星を数える夜";
const SAMPLE_BODY = `　夜空を見上げると、無数の星がまたたいていた。ぼくは子どものころから、星を数えるのが好きだった。
　「今日は何個見れるかな」とぼくは言った。隣で姉が笑う。姉は天文学を専攻していて、星の名前にとてもとても詳しい。
　ぼくたちは丘の上にレジャーシートを敷いて、温かいココアを飲みながら、流れ星が流れるのを待った。流れ星が流れたら、願いごとを三回唱えるのだ。
　でも、ぼくの願いはもう叶っている気もする。こうして姉とと一緒に、静かな夜を過すこと。それが、ぼくのいちばんの願いだったからだ。`;

if (sampleBtn) {
  sampleBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: SAMPLE_TITLE, body: SAMPLE_BODY }),
      });
      const meta = await res.json();
      await loadDocs(meta.id);
      showToast("サンプル原稿を読み込みました。「全体の誤字脱字と冗長な表現を見て」と話してみてください。");
    } catch (e) {
      showToast("サンプルの作成に失敗しました。");
    }
  });
}

// ============ 採用履歴 ============
let histEntries = [];

function closeHistModal() { histModal.classList.add("hidden"); }
histClose.addEventListener("click", closeHistModal);
histModal.addEventListener("click", (e) => { if (e.target === histModal) closeHistModal(); });

histBtn.addEventListener("click", async () => {
  if (!currentDocId) return;
  histModal.classList.remove("hidden");
  histList.innerHTML = "";
  try {
    const res = await fetch(`/api/docs/${currentDocId}/history`);
    const data = await res.json();
    histEntries = data.history || [];
  } catch (e) {
    histEntries = [];
  }
  renderHistory();
});

function renderHistory() {
  histList.innerHTML = "";
  histEmpty.classList.toggle("hidden", histEntries.length > 0);
  // 新しい順に表示
  [...histEntries].reverse().forEach((entry) => {
    const row = document.createElement("div");
    row.className = "hist-row";
    const editsHtml = (entry.edits || [])
      .map((ed) => `<div class="hist-edit">「${escapeHtml(ed.before)}」→「${escapeHtml(ed.after || "（削除）")}」</div>`)
      .join("");
    row.innerHTML = `
      <div class="hist-meta">
        <span class="hist-time">${fmtDate(entry.ts)}</span>
        <span class="hist-count">${(entry.edits || []).length} 件適用</span>
        <button class="btn small ghost hist-restore"><i class="fa-solid fa-rotate-left"></i> この時点に戻す</button>
      </div>
      ${editsHtml}`;
    row.querySelector(".hist-restore").addEventListener("click", () => restoreHistory(entry.index));
    histList.appendChild(row);
  });
}

async function restoreHistory(index) {
  if (!currentDocId) return;
  if (!confirm("この修正を適用する前の原稿に戻します。よろしいですか？")) return;
  try {
    const res = await fetch(`/api/docs/${currentDocId}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "戻せませんでした。"); return; }
    pushHistory(); // 「戻す前」にも戻れるように
    manuscriptEl.value = data.body || "";
    updateCount();
    if (previewMode) renderPreview();
    saveState.textContent = "保存済み";
    closeHistModal();
    showToast("適用前の原稿に戻しました。");
  } catch (e) {
    showToast("通信エラー: " + e);
  }
}

histExport.addEventListener("click", () => {
  if (!histEntries.length) { showToast("履歴がありません。"); return; }
  const title = docTitleEl.value || "原稿";
  const lines = [`# 編集ログ — ${title}`, ""];
  histEntries.forEach((entry) => {
    lines.push(`## ${fmtDate(entry.ts)}（${(entry.edits || []).length} 件適用）`);
    (entry.edits || []).forEach((ed) => {
      const t = ed.type ? ` [${ed.type}]` : "";
      const r = ed.reason ? ` — ${ed.reason}` : "";
      lines.push(`- 「${ed.before}」→「${ed.after || "（削除）"}」${r}${t}`);
    });
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}-編集ログ.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("編集ログを書き出しました。");
});

// ---- 初期化 ----
loadDocs();
