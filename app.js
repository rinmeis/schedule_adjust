import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  SLOTS,
  ALL_MASK,
  MAX_DAYS,
  toggleSlot,
  formatDate,
  dateRange,
  dayLabel,
  tally,
  ranking,
  encodeMask,
  decodeMask,
  mapDays,
} from "./logic.js?v=1.3.0"; // ?v= は古いキャッシュと混ざらないための指定。版を上げたら合わせる

const VERSION = "ver.1.3.0";
const HISTORY_KEY = "sc_history"; // 開いた日程調整の履歴
const NAME_KEY = "sc_name_"; // 最後に使った名前（後ろにアカウントのuidを付ける）

/* ══════════ データ保存層（Firebase / デモ） ══════════
   ?demo=1 を付けると、Firebaseを使わずその場限りのダミーデータで動く（見た目の確認用） */
const DEMO = new URLSearchParams(location.search).has("demo");

// 日程調整アプリ専用のFirebaseプロジェクト(schedule-adjust)の設定値
const firebaseConfig = {
  apiKey: "AIzaSyC8aTFqlJkW9pVq87yNIuLYZKlVyCF5GV8",
  authDomain: "schedule-adjust-9b646.firebaseapp.com",
  projectId: "schedule-adjust-9b646",
  storageBucket: "schedule-adjust-9b646.firebasestorage.app",
  messagingSenderId: "772147985861",
  appId: "1:772147985861:web:3c046deb08eaefed9a5fac",
};
const CONFIGURED = !!firebaseConfig.apiKey;

let db = null;
let auth = null;
if (!DEMO && CONFIGURED) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  auth.languageCode = "ja";
  db = getFirestore(fbApp);
}

function demoSchedule() {
  const s = new Date();
  s.setDate(s.getDate() + 1);
  const e = new Date(s);
  e.setDate(e.getDate() + 9);
  return { title: "デモの日程調整", startDate: formatDate(s), endDate: formatDate(e) };
}
const demoStore = { schedule: demoSchedule(), responses: [], listeners: [] };
function demoSeed() {
  const dates = dateRange(demoStore.schedule.startDate, demoStore.schedule.endDate);
  const mk = (uid, name, pattern) => {
    const days = {};
    dates.forEach((d, i) => {
      const m = pattern[i % pattern.length];
      if (m) days[d] = encodeMask(m);
    });
    return { uid, name, days };
  };
  demoStore.responses = [
    mk("d1", "さくら", [63, 48, 60, 0, 32]),
    mk("d2", "けんた", [60, 63, 32, 56, 0]),
    mk("d3", "みお", [48, 32, 63, 60, 56]),
  ];
}

const backend = {
  async createSchedule(data) {
    if (DEMO) return "demo";
    const ref = await addDoc(collection(db, "schedules"), {
      ...data,
      creatorUid: myUid,
      createdAt: serverTimestamp(),
    });
    return ref.id;
  },
  async getSchedule(id) {
    if (DEMO) return demoStore.schedule;
    const snap = await getDoc(doc(db, "schedules", id));
    return snap.exists() ? snap.data() : null;
  },
  async saveResponse(id, resp) {
    if (DEMO) {
      demoStore.responses = demoStore.responses.filter((r) => r.uid !== myUid);
      demoStore.responses.push({ uid: myUid, ...resp });
      demoStore.listeners.forEach((f) => f());
      return;
    }
    await setDoc(doc(db, "schedules", id, "responses", myUid), {
      uid: myUid,
      name: resp.name,
      days: resp.days,
      updatedAt: serverTimestamp(),
    });
  },
  subscribe(id, cb, onError) {
    if (DEMO) {
      const f = () => cb(demoStore.responses.slice());
      demoStore.listeners.push(f);
      f();
      return () => (demoStore.listeners = demoStore.listeners.filter((x) => x !== f));
    }
    return onSnapshot(
      collection(db, "schedules", id, "responses"),
      (snap) => cb(snap.docs.map((d) => d.data())),
      onError
    );
  },
};

/* ══════════ 状態 ══════════ */
let myUid = null;
let scheduleId = null;
let schedule = null; // {title, startDate, endDate}
let dates = [];
let responses = [];
let unsub = null;
let loaded = false; // 回答の初回読み込みが済んだか
let accountName = ""; // ログイン中のGoogleアカウントの表示名
let draft = { name: "", days: {} }; // 入力中の回答
let dirty = false; // 未保存の変更があるか
let selCell = null; // 結果画面で選んだセル {di, si}
let hlUid = null; // 結果画面で色を変えて表示する人のuid（nullなら色分けなし）

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* 保存できなくても動作は続ける */
  }
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function showScreen(name) {
  ["loading", "login", "home", "schedule"].forEach((n) => $("screen-" + n).classList.toggle("active", n === name));
}

/* ══════════ ホーム ══════════ */
function stopListening() {
  if (unsub) {
    unsub();
    unsub = null;
  }
}

function renderHome() {
  stopListening();
  scheduleId = null;
  $("header-title").textContent = "日程調整";
  showScreen("home");
  const today = new Date();
  if (!$("in-start").value) $("in-start").value = formatDate(today);
  if (!$("in-end").value) {
    const e = new Date(today);
    e.setDate(e.getDate() + 13);
    $("in-end").value = formatDate(e);
  }
  const hist = lsGet(HISTORY_KEY, []);
  $("history-card").hidden = hist.length === 0;
  $("history-list").innerHTML = hist
    .map(
      (h) =>
        `<button class="hist-row" data-id="${esc(h.id)}">${esc(h.title)}<small>${esc(h.start)} 〜 ${esc(h.end)}</small></button>`
    )
    .join("");
}

$("history-list").addEventListener("click", (e) => {
  const b = e.target.closest(".hist-row");
  if (b) go(b.dataset.id);
});

$("btn-create").addEventListener("click", async () => {
  const title = $("in-title").value.trim() || "日程調整";
  const start = $("in-start").value;
  const end = $("in-end").value;
  const err = $("home-error");
  err.textContent = "";
  const range = dateRange(start, end);
  if (!start || !end) {
    err.textContent = "開始日と終了日を入力してください。";
    return;
  }
  if (!range) {
    err.textContent = end < start ? "終了日は開始日以降にしてください。" : "期間は最大" + MAX_DAYS + "日間です。";
    return;
  }
  $("btn-create").disabled = true;
  try {
    const id = await backend.createSchedule({ title, startDate: start, endDate: end });
    go(id);
  } catch (e) {
    err.textContent = "作成できませんでした。通信状況を確認して、もう一度試してください。";
  } finally {
    $("btn-create").disabled = false;
  }
});

/* ══════════ 日程調整の画面 ══════════ */
function go(id) {
  history.pushState(null, "", DEMO ? "?demo=1" : "?s=" + encodeURIComponent(id));
  openSchedule(id);
}

async function openSchedule(id) {
  stopListening();
  showScreen("loading");
  try {
    const s = await backend.getSchedule(id);
    if (!s) {
      toast("この日程調整は見つかりませんでした");
      history.replaceState(null, "", location.pathname);
      renderHome();
      return;
    }
    const range = dateRange(s.startDate, s.endDate);
    if (!range) throw new Error("bad range");
    scheduleId = id;
    schedule = s;
    dates = range;
    rememberHistory(id, s);
    draft = { name: lsGet(NAME_KEY + myUid, accountName), days: {} };
    dirty = false;
    selCell = null;
    hlUid = null;
    loaded = false;
    responses = [];
    $("header-title").textContent = s.title;
    $("in-name").value = draft.name;
    setTab("input");
    renderInput();
    renderResult();
    // 画面は回答の初回読み込み後に表示する（別の端末で入力した回答を上書きしないため）
    unsub = backend.subscribe(id, onResponses, () => {
      toast("回答を読み込めませんでした");
      renderHome();
    });
  } catch (e) {
    toast("読み込めませんでした。通信状況を確認してください");
    renderHome();
  }
}

function rememberHistory(id, s) {
  const hist = lsGet(HISTORY_KEY, []).filter((h) => h.id !== id);
  hist.unshift({ id, title: s.title, start: s.startDate, end: s.endDate });
  lsSet(HISTORY_KEY, hist.slice(0, 20));
}

function onResponses(list) {
  responses = list
    .map((r) => ({ ...r, days: mapDays(r.days, decodeMask) })) // 保存形式 → 画面用
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
  const mine = responses.find((r) => r.uid === myUid);
  if (mine && !dirty) {
    draft = { name: mine.name, days: { ...(mine.days || {}) } };
    $("in-name").value = draft.name;
    renderInput();
  }
  renderResult();
  if (!loaded) {
    loaded = true;
    showScreen("schedule");
  }
}

/* ── 入力 ── */
function dateCell(date) {
  const l = dayLabel(date);
  const cls = l.weekday === 6 ? "sat" : l.weekday === 0 ? "sun" : "";
  return `<span class="date ${cls}">${l.text}</span>`;
}
function headRow() {
  return "<tr><th></th>" + SLOTS.map((s) => `<th>${s.replace(/(後|以降)$/, "<br>$1")}</th>`).join("") + "</tr>";
}

function renderInput() {
  let h = '<table class="grid">' + headRow();
  dates.forEach((date, di) => {
    const mask = draft.days[date] || 0;
    h += `<tr><td>${dateCell(date)}</td>`;
    SLOTS.forEach((s, si) => {
      h += `<td><button type="button" class="rb" data-di="${di}" data-si="${si}" aria-pressed="${!!(mask & (1 << si))}" aria-label="${dayLabel(date).text} ${s}"></button></td>`;
    });
    h += "</tr>";
  });
  $("input-table").innerHTML = h + "</table>";
  updateSaveState();
}

$("input-table").addEventListener("click", (e) => {
  const b = e.target.closest(".rb");
  if (!b) return;
  const date = dates[+b.dataset.di];
  const next = toggleSlot(draft.days[date] || 0, +b.dataset.si);
  if (next) draft.days[date] = next;
  else delete draft.days[date];
  dirty = true;
  // 該当行のボタンだけ更新（全体を作り直すとスクロールが乱れるため）
  b.closest("tr")
    .querySelectorAll(".rb")
    .forEach((x) => x.setAttribute("aria-pressed", String(!!(next & (1 << +x.dataset.si)))));
  updateSaveState();
});

$("in-name").addEventListener("input", () => {
  draft.name = $("in-name").value;
  dirty = true;
  updateSaveState();
});

function updateSaveState() {
  const el = $("save-state");
  const mine = responses.find((r) => r.uid === myUid);
  if (dirty) {
    el.textContent = "未保存の変更があります";
    el.className = "save-state dirty";
  } else {
    el.textContent = mine ? "保存済み" : "まだ回答していません";
    el.className = "save-state";
  }
}

$("btn-save").addEventListener("click", async () => {
  const name = draft.name.trim();
  const err = $("input-error");
  err.textContent = "";
  if (!name) {
    err.textContent = "名前を入力してください。";
    $("in-name").focus();
    return;
  }
  $("btn-save").disabled = true;
  try {
    const days = {};
    dates.forEach((d) => {
      const m = (draft.days[d] || 0) & ALL_MASK;
      if (m) days[d] = m;
    });
    await backend.saveResponse(scheduleId, { name, days: mapDays(days, encodeMask) });
    lsSet(NAME_KEY + myUid, name);
    draft.name = name;
    dirty = false;
    updateSaveState();
    toast("回答を保存しました");
  } catch (e) {
    err.textContent = "保存できませんでした。通信状況を確認して、もう一度試してください。";
  } finally {
    $("btn-save").disabled = false;
  }
});

/* ── 結果 ── */
function renderResult() {
  updateSaveState();
  const table = tally(dates, responses);
  const total = responses.length;
  const top = ranking(dates, table, 3);

  let t = "<h2>おすすめ</h2>";
  if (!total) {
    t += '<p class="empty">まだ回答がありません。</p>';
  } else if (!top.length) {
    t += '<p class="empty">空いている時間帯がある人はまだいません。</p>';
  } else {
    top.forEach((r, i) => {
      t += `<div class="top-row"><span class="top-no">${i + 1}</span><span class="top-main">${dateCell(r.date)}　${SLOTS[r.slot]}</span><span class="top-n">${r.n}/${total}人</span></div>`;
    });
  }
  t += `<div class="members">回答 ${total}人${total ? "：" + responses.map((r) => esc(r.name)).join("、") : ""}</div>`;
  $("result-top").innerHTML = t;

  if (hlUid && !responses.some((r) => r.uid === hlUid)) hlUid = null;
  const hl = responses.find((r) => r.uid === hlUid) || null;
  $("result-person-wrap").hidden = total === 0;
  $("result-person").innerHTML =
    `<button type="button" class="pchip${hl ? "" : " on"}" data-uid="">なし</button>` +
    responses
      .map((r) => `<button type="button" class="pchip${hl && r.uid === hl.uid ? " on" : ""}" data-uid="${esc(r.uid)}">${esc(r.name)}</button>`)
      .join("");
  $("result-legend").innerHTML = hl ? `<span class="swatch"></span>${esc(hl.name)}さんが空いている時間帯` : "";

  let max = 0;
  table.forEach((row) => row.forEach((c) => (max = Math.max(max, c.free.length))));
  let h = '<table class="grid">' + headRow();
  dates.forEach((date, di) => {
    h += `<tr><td>${dateCell(date)}</td>`;
    SLOTS.forEach((s, si) => {
      const n = table[di][si].free.length;
      const a = total ? (n / total) * 0.75 : 0;
      const hit = !!(hl && ((hl.days && hl.days[date]) || 0) & (1 << si)); // 選んだ人が空いている枠
      const bg = hit ? `rgba(234,88,12,${(0.3 + a * 0.6).toFixed(2)})` : `rgba(15,118,110,${a.toFixed(2)})`;
      const cls = "cell" + (max > 0 && n === max ? " best" : "") + (selCell && selCell.di === di && selCell.si === si ? " sel" : "");
      h += `<td><button type="button" class="${cls}" data-di="${di}" data-si="${si}" style="background:${bg}">${n}</button></td>`;
    });
    h += "</tr>";
  });
  $("result-table").innerHTML = h + "</table>";

  const d = $("result-detail");
  if (selCell && total) {
    const c = table[selCell.di][selCell.si];
    d.innerHTML =
      `<div><b>${dayLabel(dates[selCell.di]).text} ${SLOTS[selCell.si]}</b></div>` +
      `<div><span class="free">空いている ${c.free.length}人</span>：${c.free.map(esc).join("、") || "なし"}</div>` +
      `<div><span class="busy">空いていない ${c.busy.length}人</span>：${c.busy.map(esc).join("、") || "なし"}</div>`;
  } else {
    d.innerHTML = total ? '<span class="busy">数字を押すと、誰が空いているか見られます。</span>' : "";
  }
}

$("result-person").addEventListener("click", (e) => {
  const b = e.target.closest(".pchip");
  if (!b) return;
  hlUid = b.dataset.uid || null;
  renderResult();
});

$("result-table").addEventListener("click", (e) => {
  const b = e.target.closest(".cell");
  if (!b) return;
  const di = +b.dataset.di;
  const si = +b.dataset.si;
  selCell = selCell && selCell.di === di && selCell.si === si ? null : { di, si };
  renderResult();
});

/* ── タブ・共有 ── */
function setTab(name) {
  $("tab-input").classList.toggle("active", name === "input");
  $("tab-result").classList.toggle("active", name === "result");
  $("pane-input").hidden = name !== "input";
  $("pane-result").hidden = name !== "result";
}
$("tab-input").addEventListener("click", () => setTab("input"));
$("tab-result").addEventListener("click", () => setTab("result"));
$("btn-home").addEventListener("click", () => {
  history.pushState(null, "", location.pathname + (DEMO ? "?demo=1" : ""));
  renderHome();
});

function shareUrl() {
  // openExternalBrowser=1: LINEで開いたときに外部ブラウザへ切り替える指定（Googleログインのため）
  return location.origin + location.pathname + (DEMO ? "?demo=1" : "?s=" + encodeURIComponent(scheduleId) + "&openExternalBrowser=1");
}
async function copyText(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("URLをコピーしました");
  } catch (e) {
    window.prompt("このURLをコピーして共有してください", url);
  }
}
$("btn-copy").addEventListener("click", () => copyText(shareUrl()));
if (navigator.share) {
  $("btn-share").hidden = false;
  $("btn-share").addEventListener("click", () => {
    navigator.share({ title: schedule.title, url: shareUrl() }).catch(() => {});
  });
}

/* ══════════ ログイン ══════════ */
// LINEなどのアプリ内ブラウザではGoogleログインがブロックされる
const IN_APP = /Line\/|FBAN|FBAV|Instagram|MicroMessenger|; wv\)/i.test(navigator.userAgent);

function renderLogin(message) {
  stopListening();
  scheduleId = null;
  $("header-title").textContent = "日程調整";
  $("account").hidden = true;
  $("login-error").textContent = message || "";
  $("inapp-note").hidden = !IN_APP;
  $("btn-copy-login").hidden = !IN_APP;
  showScreen("login");
}

function loginErrorMessage(code) {
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "ログインが中止されました。もう一度押してください。";
    case "auth/popup-blocked":
      return "ログイン画面がブロックされました。ブラウザのポップアップ設定を確認してください。";
    case "auth/unauthorized-domain":
      return "このサイトはログインが許可されていません（Firebaseの承認済みドメインの設定が必要です）。";
    case "auth/operation-not-allowed":
      return "Googleログインが有効になっていません（Firebaseの設定が必要です）。";
    default:
      return "ログインできませんでした。通信状況を確認して、もう一度試してください。";
  }
}

$("btn-login").addEventListener("click", () => {
  if (!auth) return;
  $("login-error").textContent = "";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  // iPhoneのSafariでポップアップが止められないよう、タップ直後にそのまま呼ぶ
  signInWithPopup(auth, provider).catch((e) => {
    $("login-error").textContent = loginErrorMessage(e.code);
  });
});
$("btn-copy-login").addEventListener("click", () => copyText(location.href));
$("btn-logout").addEventListener("click", () => {
  if (dirty && !window.confirm("未保存の変更があります。ログアウトしますか？")) return;
  signOut(auth).catch(() => toast("ログアウトできませんでした"));
});

/* ══════════ 起動 ══════════ */
function route() {
  if (!myUid) return;
  const id = DEMO ? "demo" : new URLSearchParams(location.search).get("s");
  if (id) openSchedule(id);
  else renderHome();
}
window.addEventListener("popstate", route);
$("header-ver").textContent = VERSION;

if (DEMO) {
  myUid = "me";
  demoSeed();
  // デモはログインとホームを飛ばして、作成済みの日程調整を直接開く
  route();
} else if (!CONFIGURED) {
  renderLogin("Firebaseの設定がまだ入っていません。");
} else {
  onAuthStateChanged(auth, (user) => {
    // Googleでログインしている人だけを通す
    const ok = !!user && user.providerData.some((p) => p.providerId === "google.com");
    if (!ok) {
      myUid = null;
      accountName = "";
      draft = { name: "", days: {} };
      dirty = false;
      responses = [];
      renderLogin();
      return;
    }
    if (user.uid === myUid) return;
    myUid = user.uid;
    accountName = (user.displayName || "").slice(0, 20);
    $("account-name").textContent = (user.displayName || "Googleアカウント") + " でログイン中";
    $("account").hidden = false;
    route();
  });
}
