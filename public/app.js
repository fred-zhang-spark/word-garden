// 单词花园 · 前端
// 设计原则（对 9-12 岁孩子）：任何操作 3 秒内要有看得见的回报；
// 答错不惩罚；一次浇水只做 6 个词，宁可让孩子觉得没玩够。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  profileId: "p1",
  profiles: [],
  words: [],
  activity: [],
  aiReady: false,
  online: true,
};

/* ---------------- 网络 ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "出了点问题"), { data, status: res.status });
  return data;
}

async function loadState() {
  try {
    const data = await api(`/api/state?profile=${state.profileId}`);
    Object.assign(state, data, { online: true });
    localStorage.setItem("wg-cache", JSON.stringify(data));
  } catch {
    // 连不上服务器（比如带着 MacBook 出门了）：用上次的快照，至少能看和复习
    state.online = false;
    const cached = localStorage.getItem("wg-cache");
    if (cached) Object.assign(state, JSON.parse(cached));
    toast("现在连不上花园，先看看已经收好的词");
  }
}

/* ---------------- 小工具 ---------------- */

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => (el.hidden = true), 220);
  }, 2200);
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.85; // 孩子要听清
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const todayKey = () => new Date().toLocaleDateString("sv");

function faceHTML(word, cls = "word-face") {
  return word.photo
    ? `<div class="${cls}"><img src="${esc(word.photo)}" alt=""></div>`
    : `<div class="${cls}">${esc(word.emoji || "🌿")}</div>`;
}

const speakerSVG = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8h3l4-3v10l-4-3H4z"/><path d="M14 7.5a4 4 0 0 1 0 5" stroke-linecap="round"/></svg>`;

/* ---------------- 路由 ---------------- */

function go(view) {
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.go === view));
  window.scrollTo({ top: 0 });
  if (view === "garden") renderGarden();
  if (view === "book") renderBook();
  if (view === "quiz") startQuiz();
  if (view === "me") renderMe();
  if (view === "search") setTimeout(() => $("#search-input").focus(), 120);
}

/* ---------------- 花园首页 ---------------- */

function dueWords() {
  const now = Date.now();
  return state.words.filter((w) => w.dueAt <= now);
}

function streakDays() {
  const days = new Set(state.activity || []);
  for (const w of state.words) days.add(new Date(w.createdAt).toLocaleDateString("sv"));
  let n = 0;
  const cursor = new Date();
  // 今天还没用过也不算断——从昨天开始数，孩子今天来了就是 +1
  if (!days.has(todayKey())) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    if (!days.has(cursor.toLocaleDateString("sv"))) break;
    n += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

function renderGarden() {
  const words = state.words;
  const today = words.filter((w) => new Date(w.createdAt).toLocaleDateString("sv") === todayKey());
  const hour = new Date().getHours();
  $("#greeting").textContent =
    hour < 11 ? "早上好呀，" : hour < 18 ? "下午好呀，" : "晚上好呀，";

  $("#stat-total").textContent = words.length;
  $("#stat-today").textContent = today.length ? `+${today.length}` : "0";
  $("#stat-streak").textContent = streakDays();

  drawHill(words);

  const due = dueWords();
  const weak = due.filter((w) => w.wrongCount > 0).length;
  const title = $("#quiz-title");
  const sub = $("#quiz-sub");
  if (!words.length) {
    title.textContent = "花园还空着";
    sub.textContent = "先收几个词，就能来浇水啦";
  } else if (!due.length) {
    title.textContent = "今天都浇过啦";
    sub.textContent = "苗都喝饱了，去收点新词吧 🌤";
  } else {
    title.textContent = "浇水时间到啦";
    sub.textContent = `${Math.min(due.length, 6)} 个词等你复习${weak ? `，其中 ${weak} 个有点渴 💧` : ""}`;
  }

  const recent = [...words].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  $("#recent").innerHTML = recent
    .map(
      (w) => `<button class="chip" data-word="${esc(w.id)}">
        ${w.photo ? `<img src="${esc(w.photo)}" alt="">` : `<em>${esc(w.emoji || "🌿")}</em>`}
        ${esc(w.en)} <i>${esc(w.zh)}</i></button>`,
    )
    .join("");
  $("#garden-empty").hidden = words.length > 0;
}

// 每个词一棵苗；记牢了（box>=4）的开花。最多画 14 棵，再多就长不下了。
function drawHill(words) {
  const shown = words.slice(-14);
  const W = 360, H = 86;
  const step = shown.length ? W / (shown.length + 1) : W;
  const plants = shown
    .map((w, i) => {
      const x = Math.round(step * (i + 1));
      const h = 16 + ((w.box || 1) * 4) + ((i * 7) % 9);
      const top = 66 - h;
      const bloom = (w.box || 1) >= 4;
      const hue = ["#8CBF87", "#A5D19F", "#7FB37B"][i % 3];
      return `<g>
        <path d="M${x} 66v-${h}" stroke="#6E9B6C" stroke-width="2" stroke-linecap="round"/>
        <ellipse cx="${x - 6}" cy="${top + 6}" rx="7" ry="4.6" fill="${hue}"/>
        <ellipse cx="${x + 6}" cy="${top + 9}" rx="6" ry="4" fill="${hue}"/>
        ${bloom ? `<circle cx="${x}" cy="${top - 2}" r="5.2" fill="#F0B07E"/><circle cx="${x}" cy="${top - 2}" r="1.9" fill="#FFF3E4"/>` : ""}
      </g>`;
    })
    .join("");

  $("#hill").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 60c48-16 92 6 138-4s84-28 130-18 62 22 92 18v30H0z" fill="#E4F0E3"/>
    <path d="M0 68c54-10 96 4 150-2s96-16 150-8 60 10 60 10v18H0z" fill="#CFE6CE"/>
    ${plants}
  </svg>`;
}

/* ---------------- 查词 ---------------- */

function loadingHTML(text) {
  return `<div class="loading"><div class="dots"><span></span><span></span><span></span></div><p>${esc(text)}</p></div>`;
}

function wordCardHTML(word, { action = "plant", photo = null } = {}) {
  const w = { ...word, photo: photo || word.photo };
  return `<div class="word-card">
    <div class="face">
      ${faceHTML(w)}
      <div style="min-width:0">
        <div class="word-en">${esc(w.en)}</div>
        <div class="word-meta">${esc(w.phonetic || "")} ${esc(w.pos || "")}</div>
        <div class="word-zh">${esc(w.zh)}</div>
      </div>
      <button class="speak" type="button" data-speak="${esc(w.en)}" aria-label="听发音">${speakerSVG}</button>
    </div>
    ${w.example_en ? `<div class="word-ex"><b>${esc(w.example_en)}</b><span>${esc(w.example_zh || "")}</span></div>` : ""}
    ${action === "plant" ? `<div class="row"><button class="btn btn-plant" type="button" data-plant>种进花园 🌱</button></div>` : ""}
  </div>`;
}

let pendingWord = null;

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = $("#search-input").value.trim();
  if (!query) return;
  const box = $("#search-result");
  box.innerHTML = loadingHTML("正在找这个词…");
  try {
    const result = await api("/api/lookup", { method: "POST", body: JSON.stringify({ query }) });
    if (!result.found || !result.word) {
      box.innerHTML = `<div class="empty">${esc(result.message || "没找到这个词，换个说法试试？")}</div>`;
      return;
    }
    pendingWord = result.word;
    box.innerHTML = wordCardHTML(result.word);
    speak(result.word.en);
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}${err.data?.hint ? `<br><br>${esc(err.data.hint)}` : ""}</div>`;
  }
});

/* ---------------- 拍照 ---------------- */

// 手机原图好几 MB，先压到 1280px 再传，省流量也省 token
function compress(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error("这张照片打不开")));
    img.src = url;
  });
}

let captureMode = "object";
let capturePicks = new Set();
let captureItems = [];
let capturePhoto = null;

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;

  go("capture");
  const body = $("#capture-body");
  $("#capture-title").textContent = captureMode === "object" ? "照片里的东西" : "这张单词表";
  body.innerHTML = loadingHTML(captureMode === "object" ? "正在看这是什么…" : "正在认这些单词…");

  try {
    capturePhoto = await compress(file, captureMode === "object" ? 1280 : 1600);
    const endpoint = captureMode === "object" ? "/api/vision" : "/api/ocr";
    const { items } = await api(endpoint, { method: "POST", body: JSON.stringify({ image: capturePhoto }) });
    captureItems = items || [];
    capturePicks = new Set(captureItems.length ? [0] : []);
    if (captureMode === "list") capturePicks = new Set(captureItems.map((_, i) => i));
    renderCapture();
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}${err.data?.hint ? `<br><br>${esc(err.data.hint)}` : ""}</div>`;
  }
});

function renderCapture() {
  const body = $("#capture-body");
  if (!captureItems.length) {
    body.innerHTML = `<img class="shot" src="${capturePhoto}" alt="刚拍的照片">
      <div class="empty">没认出来 😅<br>离近一点、光亮一点，再拍一张试试</div>`;
    return;
  }
  const picks = captureItems
    .map(
      (item, i) => `<button class="pick ${capturePicks.has(i) ? "on" : ""}" type="button" data-pick="${i}">
        ${faceHTML(item)}
        <div style="min-width:0">
          <div class="word-en">${esc(item.en)}</div>
          <div class="word-meta">${esc(item.phonetic || "")} ${esc(item.zh)}</div>
        </div>
        <span class="check">✓</span>
      </button>`,
    )
    .join("");

  body.innerHTML = `
    <img class="shot" src="${capturePhoto}" alt="刚拍的照片">
    <h2 class="sec">${captureMode === "object" ? "这是不是你想问的？" : `认出了 ${captureItems.length} 个词`}</h2>
    ${picks}
    <div class="row"><button class="btn btn-plant" type="button" data-plant-picks>把选中的种进花园 🌱</button></div>`;
}

/* ---------------- 收词 ---------------- */

async function collect(items, source, photo) {
  if (!items.length) return toast("先选一个词");
  try {
    const data = await api("/api/collect", {
      method: "POST",
      body: JSON.stringify({ items, source, photo, profileId: state.profileId }),
    });
    state.words = data.words;
    const n = data.added.length;
    const dup = data.skipped.length;
    if (n) speak(data.added[0].en);
    toast(
      n && dup ? `种下 ${n} 个，${dup} 个早就有啦`
      : n ? (n === 1 ? `「${data.added[0].en}」种进花园啦 🌱` : `种下 ${n} 个新词 🌱`)
      : "这些词花园里已经有啦",
    );
    go("garden");
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- 单词本 ---------------- */

function renderBook(filter = "") {
  const key = filter.trim().toLowerCase();
  const list = [...state.words]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((w) => !key || w.en.toLowerCase().includes(key) || (w.zh || "").includes(key));

  $("#book-list").innerHTML = list.length
    ? list
        .map(
          (w) => `<div class="book-row">
            ${faceHTML(w)}
            <div style="min-width:0">
              <div class="en">${esc(w.en)}</div>
              <div class="zh">${esc(w.phonetic || "")} ${esc(w.zh)}</div>
            </div>
            <button class="speak" type="button" data-speak="${esc(w.en)}" aria-label="听发音">${speakerSVG}</button>
            <span class="grow" title="记牢程度">${[1, 2, 3, 4, 5]
              .map((i) => `<i class="${(w.box || 1) >= i ? "f" : ""}"></i>`)
              .join("")}</span>
          </div>`,
        )
        .join("")
    : `<div class="empty">${key ? "没有这个词" : "单词本还是空的，去花园收几个吧"}</div>`;
}

$("#book-filter").addEventListener("input", (e) => renderBook(e.target.value));

/* ---------------- 浇水（自适应测验） ---------------- */

const quiz = { list: [], index: 0, right: 0, startedAt: 0, answered: false };
const FALLBACK_WORDS = ["apple", "river", "window", "quiet", "travel", "bridge", "yellow", "garden"];

function pickDistractors(word, count = 3) {
  const others = state.words.filter((w) => w.id !== word.id).map((w) => w.en);
  const pool = [...new Set([...others, ...FALLBACK_WORDS])].filter((en) => en !== word.en);
  const out = [];
  while (out.length < count && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// 单词里万一带了正则特殊字符（比如 "self-made"），不转义会让挖空崩掉
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

function makeQuestion(word) {
  const box = word.box || 1;
  const canCloze = word.example_en && new RegExp(`\\b${escRe(word.en)}\\b`, "i").test(word.example_en);
  // 刚种下的先认脸（选择题），熟一点了挖例句，记牢了才让拼
  let kind = "choice";
  if (box >= 4 && word.en.length <= 11 && /^[a-zA-Z ]+$/.test(word.en)) kind = "spell";
  else if (box >= 2 && canCloze) kind = "cloze";

  if (kind === "spell") return { kind, word };
  const options = shuffle([word.en, ...pickDistractors(word)]);
  return { kind, word, options };
}

function startQuiz() {
  const now = Date.now();
  const due = state.words.filter((w) => w.dueAt <= now);
  // 到期的先做；没到期的话也让孩子玩，挑最久没见的
  const pool = due.length ? due : [...state.words].sort((a, b) => a.dueAt - b.dueAt);
  const sorted = [...pool].sort(
    (a, b) => b.wrongCount - a.wrongCount || a.dueAt - b.dueAt || a.seenCount - b.seenCount,
  );
  quiz.list = sorted.slice(0, 6).map(makeQuestion);
  quiz.index = 0;
  quiz.right = 0;
  renderQuestion();
}

function renderQuestion() {
  const body = $("#quiz-body");
  const bar = $("#quiz-progress");

  if (!state.words.length) {
    bar.style.width = "0%";
    body.innerHTML = `<div class="empty">花园还是空的，先去收几个词吧</div>`;
    return;
  }
  if (quiz.index >= quiz.list.length) return renderDone();

  const q = quiz.list[quiz.index];
  bar.style.width = `${(quiz.index / quiz.list.length) * 100}%`;
  quiz.answered = false;
  quiz.startedAt = Date.now();

  if (q.kind === "spell") {
    body.innerHTML = `<div class="q-card">
        <div class="q-kind">拼出来</div>
        <div class="q-main">${esc(q.word.zh)}</div>
        <div class="q-hint">${esc(q.word.phonetic || "")} · ${q.word.en.length} 个字母</div>
        <button class="speak" type="button" data-speak="${esc(q.word.en)}" style="margin:14px auto 0" aria-label="听发音">${speakerSVG}</button>
      </div>
      <input class="spell-in" id="spell-in" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="……" enterkeyhint="done">
      <div class="row"><button class="btn btn-plant" type="button" data-answer="">写好了</button></div>`;
    const input = $("#spell-in");
    setTimeout(() => input.focus(), 150);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") answer(input.value);
    });
    speak(q.word.en);
    return;
  }

  const head =
    q.kind === "cloze"
      ? `<div class="q-kind">填进句子里</div>
         <div class="q-cloze">${esc(q.word.example_en).replace(new RegExp(`\\b${escRe(q.word.en)}\\b`, "i"), "<u></u>")}</div>
         <div class="q-hint">${esc(q.word.zh)}</div>`
      : `<div class="q-kind">这个词的英文是</div>
         <div class="q-main">${esc(q.word.zh)}</div>
         <div class="q-hint">${q.word.photo ? "你自己拍的" : esc(q.word.pos || "")}</div>`;

  body.innerHTML = `<div class="q-card">
      ${q.word.photo && q.kind === "choice" ? `<img class="shot" src="${esc(q.word.photo)}" alt="" style="margin:0 0 12px;max-height:180px;object-fit:cover">` : ""}
      ${head}
    </div>
    <div class="opts">${q.options.map((o) => `<button class="opt" type="button" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
}

async function answer(value) {
  if (quiz.answered) return;
  quiz.answered = true;

  const q = quiz.list[quiz.index];
  const given = String(value || "").trim().toLowerCase();
  const correct = given === q.word.en.toLowerCase();
  const hesitated = Date.now() - quiz.startedAt > 8000;
  if (correct) quiz.right += 1;

  // 标出对错：选错了也把正确答案点亮，孩子要看见对的长什么样
  $$("[data-answer]").forEach((btn) => {
    const v = btn.dataset.answer.toLowerCase();
    if (v === q.word.en.toLowerCase()) btn.classList.add("right");
    else if (v === given && v) btn.classList.add("wrong");
  });
  const input = $("#spell-in");
  if (input) input.disabled = true;

  speak(q.word.en);

  const verdict = document.createElement("div");
  verdict.className = `verdict ${correct ? "ok" : "no"}`;
  verdict.innerHTML = correct
    ? `${hesitated ? "答对啦，再熟一点就更好 🌿" : "答对啦！这棵苗长高了 🌱"}`
    : `是 <b>${esc(q.word.en)}</b>${q.word.phonetic ? ` ${esc(q.word.phonetic)}` : ""}
       <small>这棵苗有点渴，等下再浇一次 💧</small>`;
  $("#quiz-body").append(verdict);

  try {
    const { word } = await api("/api/review", {
      method: "POST",
      body: JSON.stringify({ id: q.word.id, correct, hesitated, profileId: state.profileId }),
    });
    const i = state.words.findIndex((w) => w.id === word.id);
    if (i >= 0) state.words[i] = word;
  } catch {
    /* 离线也让孩子做完这一轮，成绩下次联网再说 */
  }

  // 答对了自己往下走；答错了让孩子看一眼正确答案再点
  if (correct) {
    setTimeout(next, 1100);
  } else {
    const btn = document.createElement("button");
    btn.className = "btn btn-plant";
    btn.type = "button";
    btn.textContent = "知道啦";
    btn.style.marginTop = "14px";
    btn.addEventListener("click", next);
    $("#quiz-body").append(btn);
  }
}

function next() {
  quiz.index += 1;
  renderQuestion();
}

function renderDone() {
  $("#quiz-progress").style.width = "100%";
  const total = quiz.list.length;
  const thirsty = total - quiz.right;
  $("#quiz-body").innerHTML = `<div class="done">
      <div class="big">${quiz.right === total ? "🌻" : "🌱"}</div>
      <h2>浇完啦！</h2>
      <p>${total} 棵苗喝到水${quiz.right ? `，${quiz.right} 棵长高了` : ""}${thirsty ? `，${thirsty} 棵明天还要再浇` : ""}</p>
      <div class="row" style="max-width:320px;margin:20px auto 0">
        <button class="btn btn-ghost" type="button" data-go="garden">回花园</button>
        <button class="btn btn-plant" type="button" data-again>再来一轮</button>
      </div>
    </div>`;
}

/* ---------------- 我的 ---------------- */

function renderMe() {
  const mastered = state.words.filter((w) => (w.box || 1) >= 4).length;
  const fromPhoto = state.words.filter((w) => w.source === "photo").length;
  $("#me-body").innerHTML = `
    <div class="me-card">
      <h3>${esc(state.profiles[0]?.name || "小园丁")}的花园</h3>
      <p>一共 ${state.words.length} 个词，记牢了 ${mastered} 个，其中 ${fromPhoto} 个是自己拍来的。</p>
    </div>
    <div class="me-card">
      <h3>数据存在哪</h3>
      <p>所有单词都存在家里那台电脑上（<code>data/garden.json</code>），清浏览记录、换设备都不会丢。想备份的话，把这个文件复制走就行。</p>
    </div>
    <div class="me-card">
      <h3>导出单词本</h3>
      <p><a href="#" data-export>下载一份 CSV</a>（可以拿去打印，或者导进别的背单词软件）</p>
    </div>
    ${state.aiReady ? "" : `<div class="me-card"><h3>还没配 API key</h3><p>查词和拍照识物需要在 <code>.env</code> 里填 <code>ANTHROPIC_API_KEY</code>，填完重启服务就好。单词本和浇水不受影响。</p></div>`}`;
}

function exportCSV() {
  const rows = [["英文", "音标", "词性", "中文", "例句", "例句翻译", "记牢程度", "收集方式"]];
  for (const w of state.words) {
    rows.push([w.en, w.phonetic, w.pos, w.zh, w.example_en, w.example_zh, w.box, w.source]);
  }
  const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `单词花园-${todayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 事件总线 ---------------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go],[data-camera],[data-plant],[data-plant-picks],[data-pick],[data-answer],[data-speak],[data-again],[data-export],[data-word]");
  if (!t) return;

  if (t.dataset.go) return go(t.dataset.go);

  if (t.dataset.camera) {
    captureMode = t.dataset.camera;
    const input = $("#file-input");
    // 拍实物直接开相机；拍词表允许从相册里选（可能是别人发的照片）
    if (captureMode === "object") input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    return input.click();
  }

  if (t.hasAttribute("data-speak")) return speak(t.dataset.speak);

  if (t.hasAttribute("data-plant")) {
    if (!pendingWord) return;
    const word = pendingWord;
    pendingWord = null;
    $("#search-input").value = "";
    $("#search-result").innerHTML = "";
    return collect([word], "search");
  }

  if (t.dataset.pick !== undefined) {
    const i = Number(t.dataset.pick);
    if (captureMode === "object") capturePicks = new Set([i]);
    else capturePicks.has(i) ? capturePicks.delete(i) : capturePicks.add(i);
    return renderCapture();
  }

  if (t.hasAttribute("data-plant-picks")) {
    const items = [...capturePicks].sort().map((i) => captureItems[i]).filter(Boolean);
    // 拍实物时把孩子自己拍的照片留下来——这是他自己的花园，不是别人的图库
    return collect(items, captureMode === "object" ? "photo" : "list", captureMode === "object" ? capturePhoto : null);
  }

  if (t.hasAttribute("data-answer")) {
    const input = $("#spell-in");
    return answer(input ? input.value : t.dataset.answer);
  }

  if (t.hasAttribute("data-again")) return startQuiz();
  if (t.hasAttribute("data-export")) return (e.preventDefault(), exportCSV());

  if (t.dataset.word) {
    const w = state.words.find((x) => x.id === t.dataset.word);
    if (w) speak(w.en);
  }
});

/* ---------------- 启动 ---------------- */

await loadState();
go("garden");

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
