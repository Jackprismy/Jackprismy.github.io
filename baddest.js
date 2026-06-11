// ============================================
//  BADDEST.JS — Vocabulary App Core Logic
// ============================================

// ---- Firebase Config (ユーザーが設定) ----
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyArcz8EpMoYsYlz6srKxJMnBFxQrUS4-iw",
  authDomain: "baddest-1.firebaseapp.com",
  projectId: "baddest-1",
  storageBucket: "baddest-1.firebasestorage.app",
  messagingSenderId: "725409988165",
  appId: "1:725409988165:web:64b046886948aabc882d2c",
  measurementId: "G-BX019S8JCF"
};

// ============================================
//  Firebase セットアップ
// ============================================
let auth, db, currentUser;

function initFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    auth.onAuthStateChanged(user => {
      if (user) {
        currentUser = user;
        onUserLoggedIn();
      } else {
        currentUser = null;
        showScreen('login');
        hideLoading();
      }
    });
  } catch (e) {
    console.error('Firebase init error:', e);
    hideLoading();
    showToast('Firebase接続エラー。設定を確認してください。');
  }
}

// ============================================
//  データ構造 (Firestore)
// ============================================
/*
  users/{uid}/
    settings:     { dailyGoal: 50, autoPlay: false }
    progress:     {
                    dailyDate: "YYYY-MM-DD",
                    dailyCount: 0,
                    solvedBits: { "0": "AAAA....(base64 BitField)", "1": "..." }
                    // chunkId = floor((wordId-1)/240), bitPos内 = (wordId-1)%240
                    // 各チャンクを30バイト(240ビット)のUint8Arrayでbase64保存
                  }
    missed:       Map<wordId, { en, ja, pos, count, lastDate }>
                    → Firestore上は /missed/{docId} { words: { "1":..., "2":..., ... } }
                      1ドキュメントに最大500単語まで持つ
    customSession: { active: bool, rangeStart, rangeEnd, count, queue: [wordId,...], currentIdx, date }
*/

// ---- Firestore パス ----
const col = (path) => db.collection(path);
const doc = (path) => db.doc(path);

function userDoc(sub) { return doc(`users/${currentUser.uid}/${sub}`); }

// ============================================
//  設定
// ============================================
let settings = { dailyGoal: 50, autoPlay: false };

async function loadSettings() {
  try {
    const snap = await userDoc('settings').get();
    if (snap.exists) settings = { ...settings, ...snap.data() };
  } catch (e) { console.warn('settings load:', e); }
}
async function saveSettings() {
  try { await userDoc('settings').set(settings); } catch (e) { }
}

// ============================================
//  進捗 (解いた問題のBitField)
// ============================================
// Solved状態をBitFieldで管理。チャンクごとにbase64保存。
// wordId: 1-indexed
const CHUNK_SIZE = 240; // 30 bytes × 8 bits

let solvedBits = {}; // { chunkId: Uint8Array }
let dailyDate = '';
let dailyCount = 0;

function chunkOf(wordId) { return Math.floor((wordId - 1) / CHUNK_SIZE); }
function bitPos(wordId) { return (wordId - 1) % CHUNK_SIZE; }

function isSolved(wordId) {
  const cid = chunkOf(wordId);
  if (!solvedBits[cid]) return false;
  const pos = bitPos(wordId);
  return !!(solvedBits[cid][Math.floor(pos / 8)] & (1 << (pos % 8)));
}
function markSolved(wordId) {
  const cid = chunkOf(wordId);
  if (!solvedBits[cid]) solvedBits[cid] = new Uint8Array(30);
  const pos = bitPos(wordId);
  solvedBits[cid][Math.floor(pos / 8)] |= (1 << (pos % 8));
}
function bitsToB64(arr) {
  let s = '';
  arr.forEach(b => s += String.fromCharCode(b));
  return btoa(s);
}
function b64ToBits(str) {
  const raw = atob(str);
  const arr = new Uint8Array(30);
  for (let i = 0; i < raw.length && i < 30; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadProgress() {
  try {
    const snap = await userDoc('progress').get();
    if (snap.exists) {
      const d = snap.data();
      const today = todayStr();
      dailyDate = d.dailyDate || '';
      dailyCount = (d.dailyDate === today) ? (d.dailyCount || 0) : 0;
      const rawBits = d.solvedBits || {};
      solvedBits = {};
      for (const cid in rawBits) {
        solvedBits[cid] = b64ToBits(rawBits[cid]);
      }
    }
  } catch (e) { console.warn('progress load:', e); }
}

async function saveProgress() {
  const raw = {};
  for (const cid in solvedBits) raw[cid] = bitsToB64(solvedBits[cid]);
  try {
    await userDoc('progress').set({
      dailyDate: todayStr(),
      dailyCount: dailyCount,
      solvedBits: raw
    });
  } catch (e) { }
}

// ============================================
//  間違えた問題 (Missed Words)
// ============================================
// /missed/chunk_{n} にまとめて保存。
// { words: { "wordId": { en, pos, ja, count, lastDate } } }
const MISSED_CHUNK = 500;
let missedWords = {}; // { wordId: { en, pos, ja, count, lastDate } }

async function loadMissed() {
  missedWords = {};
  try {
    const snaps = await db.collection(`users/${currentUser.uid}/missed`).get();
    snaps.forEach(d => {
      const words = d.data().words || {};
      Object.assign(missedWords, words);
    });
  } catch (e) { console.warn('missed load:', e); }
}

async function saveMissed() {
  // チャンクに分けて保存
  const entries = Object.entries(missedWords);
  const chunks = {};
  entries.forEach(([wid, data]) => {
    const cid = Math.floor(parseInt(wid) / MISSED_CHUNK);
    if (!chunks[cid]) chunks[cid] = {};
    chunks[cid][wid] = data;
  });
  const batch = db.batch();
  // 全チャンク削除してから書き直し（差分更新は複雑なため）
  try {
    const existing = await db.collection(`users/${currentUser.uid}/missed`).get();
    existing.forEach(d => batch.delete(d.ref));
    for (const cid in chunks) {
      const ref = db.collection(`users/${currentUser.uid}/missed`).doc(`chunk_${cid}`);
      batch.set(ref, { words: chunks[cid] });
    }
    await batch.commit();
  } catch (e) { console.warn('missed save:', e); }
}

function recordMissed(word) {
  const id = String(word.id);
  if (!missedWords[id]) {
    missedWords[id] = { en: word.word, pos: word.pos || '', ja: word.meaning, count: 1, lastDate: todayStr() };
  } else {
    missedWords[id].count++;
    missedWords[id].lastDate = todayStr();
  }
}
function reduceMissed(wordId) {
  const id = String(wordId);
  if (!missedWords[id]) return;
  missedWords[id].count--;
  if (missedWords[id].count <= 0) delete missedWords[id];
}
function increaseMissed(wordId) {
  const id = String(wordId);
  if (missedWords[id]) {
    missedWords[id].count++;
    missedWords[id].lastDate = todayStr();
  }
}

// 翌日以降に解くべき単語を返す
function getReviewWords() {
  const today = todayStr();
  return Object.entries(missedWords)
    .filter(([_, d]) => d.lastDate < today)
    .map(([id, d]) => ({ id: parseInt(id), word: d.en, pos: d.pos, meaning: d.ja }));
}

// ============================================
//  カスタムセッション進捗
// ============================================
let customSession = null;

async function loadCustomSession() {
  try {
    const snap = await userDoc('customSession').get();
    if (snap.exists) {
      const d = snap.data();
      if (d.active) customSession = d;
    }
  } catch (e) { }
}
async function saveCustomSession() {
  try {
    if (customSession) {
      await userDoc('customSession').set({ ...customSession, active: true });
    } else {
      await userDoc('customSession').set({ active: false });
    }
  } catch (e) { }
}

// ============================================
//  単語データ (JSON読み込み)
// ============================================
// word1.json: 1-800, word2.json: 801-1600, ...
// 各JSONはArray of {word, pos, meaning}。インデックスがID-1。

let wordCache = {}; // { fileNum: [{word,pos,meaning},...] }
const WORDS_PER_FILE = 800;

function fileNumForId(wordId) {
  return Math.floor((wordId - 1) / WORDS_PER_FILE) + 1;
}
function idxInFile(wordId) {
  return (wordId - 1) % WORDS_PER_FILE;
}

async function loadWordFile(num) {
  if (wordCache[num]) return wordCache[num];
  try {
    const res = await fetch(`word${num}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    wordCache[num] = data;
    return data;
  } catch (e) { return null; }
}

async function getWord(wordId) {
  const num = fileNumForId(wordId);
  const data = await loadWordFile(num);
  if (!data) return null;
  const idx = idxInFile(wordId);
  if (idx >= data.length) return null;
  return { id: wordId, ...data[idx] };
}

async function getTotalWordCount() {
  // word1.json, word2.json, ... を順番にチェック
  let total = 0;
  for (let n = 1; ; n++) {
    const data = await loadWordFile(n);
    if (!data || data.length === 0) break;
    total += data.length;
  }
  return total;
}

// ============================================
//  クイックスタート (未解の問題10問)
// ============================================
async function buildQuickQueue(count = 10) {
  const total = await getTotalWordCount();
  const unsolved = [];
  for (let i = 1; i <= total; i++) {
    if (!isSolved(i)) unsolved.push(i);
    if (unsolved.length >= count * 5) break; // 十分集まったら止める
  }
  shuffle(unsolved);
  const ids = unsolved.slice(0, count);
  const words = [];
  for (const id of ids) {
    const w = await getWord(id);
    if (w) words.push(w);
  }
  return words;
}

// ============================================
//  カスタムスタート
// ============================================
async function buildCustomQueue(start, end, count) {
  const allIds = [];
  for (let i = start; i <= end; i++) allIds.push(i);
  shuffle(allIds);
  const ids = allIds.slice(0, count);
  const words = [];
  for (const id of ids) {
    const w = await getWord(id);
    if (w) words.push(w);
  }
  return words;
}

// ============================================
//  答え照合ロジック
// ============================================
// 英語を除いた意味と一致するかを調べる
// 「Oを強く要求する」→英字[A-Za-z]を除いて一致チェック
function normalize(str) {
  return str
    .replace(/[A-Za-z～〜\s\u00A0]+/g, ' ')  // 英字・スペース系を単一スペースに
    .replace(/[・、。，．]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function checkAnswer(input, meaning) {
  return normalize(input) === normalize(meaning);
}

// ============================================
//  ユーティリティ
// ============================================
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================
//  UI ヘルパー
// ============================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = document.getElementById(`screen-${name}`);
  if (s) s.classList.add('active');

  // Nav表示制御
  const nav = document.getElementById('bottom-nav');
  const noNav = ['login', 'study', 'result'];
  nav.style.display = noNav.includes(name) ? 'none' : 'flex';

  // Nav active
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === name);
  });
}

function showLoading() { document.getElementById('loading-overlay').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading-overlay').classList.add('hidden'); }

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ============================================
//  ログイン後の初期化
// ============================================
async function onUserLoggedIn() {
  showLoading();
  await loadSettings();
  await loadProgress();
  await loadMissed();
  await loadCustomSession();
  updateMainMenu();
  showScreen('main');
  hideLoading();
}

// ============================================
//  メインメニュー更新
// ============================================
function updateMainMenu() {
  // Daily progress ring
  const goal = settings.dailyGoal || 50;
  const done = dailyDate === todayStr() ? dailyCount : 0;
  const pct = Math.min(done / goal, 1);
  const pctInt = Math.round(pct * 100);

  document.getElementById('ring-fraction').textContent = `${done}/${goal}`;
  document.getElementById('ring-percent').textContent = `${pctInt}%`;

  const R = 70, C = 2 * Math.PI * R;
  const fg = document.getElementById('ring-fg');
  fg.setAttribute('stroke-dasharray', C);
  fg.setAttribute('stroke-dashoffset', C - (C * pct));

  // Review button
  const reviewWords = getReviewWords();
  const reviewWrap = document.getElementById('review-btn-wrap');
  reviewWrap.classList.toggle('visible', reviewWords.length > 0);

  // Resume banner
  const banner = document.getElementById('resume-banner');
  if (customSession && customSession.active) {
    banner.classList.add('visible');
    const rem = customSession.queue.length - customSession.currentIdx;
    document.getElementById('resume-info').textContent = `カスタムセッション (残り ${rem}問)`;
  } else {
    banner.classList.remove('visible');
  }

  // Settings display
  document.getElementById('setting-daily').value = settings.dailyGoal || 50;
  document.getElementById('setting-autoplay').checked = settings.autoPlay || false;

  // Data screen
  updateDataScreen();
}

function updateDataScreen() {
  document.getElementById('stat-solved').textContent = Object.values(solvedBits).reduce((a, arr) => {
    let c = 0; arr.forEach(b => { for (let i = 0; i < 8; i++) if (b & (1 << i)) c++; }); return a + c;
  }, 0);
  document.getElementById('stat-daily').textContent = dailyDate === todayStr() ? dailyCount : 0;
  document.getElementById('stat-missed').textContent = Object.keys(missedWords).length;
  document.getElementById('stat-goal').textContent = settings.dailyGoal || 50;

  // Missed list
  const list = document.getElementById('missed-word-list');
  list.innerHTML = '';
  const entries = Object.entries(missedWords).sort((a, b) => b[1].count - a[1].count);
  entries.slice(0, 30).forEach(([id, d]) => {
    const row = document.createElement('div');
    row.className = 'missed-word-row';
    row.innerHTML = `
      <div class="missed-word-row-left">
        <div class="missed-word-en">${esc(d.en)}</div>
        <div class="missed-word-ja">${esc(d.ja)}</div>
      </div>
      <div class="missed-count">${d.count}</div>
    `;
    list.appendChild(row);
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================
//  学習セッション
// ============================================
let studyQueue = [];
let studyIdx = 0;
let studyMode = 'quick'; // 'quick' | 'custom' | 'review'
let sessionResults = { correct: [], wrong: [] };
let currentWord = null;
let waitingForAction = false;
let isShowingWrong = false;

async function startQuick() {
  showLoading();
  studyQueue = await buildQuickQueue(10);
  if (!studyQueue.length) { hideLoading(); showToast('未解の問題がありません'); return; }
  beginSession('quick', studyQueue);
  hideLoading();
}

async function startCustom() {
  const start = parseInt(document.getElementById('custom-start').value) || 1;
  const end = parseInt(document.getElementById('custom-end').value) || 800;
  const count = parseInt(document.getElementById('custom-count').value) || 50;
  if (start > end) { showToast('範囲が不正です'); return; }

  showLoading();
  const queue = await buildCustomQueue(start, end, count);
  if (!queue.length) { hideLoading(); showToast('問題を読み込めませんでした'); return; }
  customSession = {
    active: true, rangeStart: start, rangeEnd: end, count: count,
    queue: queue.map(w => w.id), currentIdx: 0, date: todayStr()
  };
  await saveCustomSession();
  beginSession('custom', queue);
  hideLoading();
}

async function resumeCustom() {
  if (!customSession) return;
  showLoading();
  const sliced = customSession.queue.slice(customSession.currentIdx);
  const words = [];
  for (const id of sliced) {
    const w = await getWord(id);
    if (w) words.push(w);
  }
  beginSession('custom', words);
  hideLoading();
}

async function startReview() {
  showLoading();
  const all = getReviewWords();
  shuffle(all);
  const batch = all.slice(0, 10);
  if (!batch.length) { hideLoading(); showToast('復習する問題がありません'); return; }
  beginSession('review', batch);
  hideLoading();
}

function beginSession(mode, words) {
  studyMode = mode;
  studyQueue = words;
  studyIdx = 0;
  sessionResults = { correct: [], wrong: [] };
  showScreen('study');
  renderWord();
}

function renderWord() {
  currentWord = studyQueue[studyIdx];
  if (!currentWord) { finishSession(); return; }

  isShowingWrong = false;
  waitingForAction = false;

  // Progress bar
  const total = studyQueue.length;
  document.getElementById('study-progress-text').textContent = `${studyIdx + 1} / ${total}`;
  document.getElementById('study-progress-fill').style.width = `${(studyIdx / total) * 100}%`;

  // Word
  document.getElementById('word-pos').textContent = currentWord.pos || '';
  document.getElementById('word-en').textContent = currentWord.word;

  // Reset input
  const input = document.getElementById('answer-input');
  input.value = '';
  input.className = 'answer-input';
  input.disabled = false;

  // Hide overlays
  document.getElementById('reveal-area').classList.remove('visible');
  document.getElementById('action-buttons').classList.remove('visible');
  document.getElementById('wrong-overlay').classList.remove('visible');
  document.getElementById('feedback-overlay').innerHTML = '';

  // Auto-play pronunciation
  if (settings.autoPlay && 'speechSynthesis' in window) {
    const utt = new SpeechSynthesisUtterance(currentWord.word);
    utt.lang = 'en-US';
    speechSynthesis.speak(utt);
  }

  input.focus();
}

function handleAnswer() {
  if (isShowingWrong) return;

  const input = document.getElementById('answer-input');
  const inputVal = input.value.trim();

  if (waitingForAction) return;

  // 空欄でエンター → 答えを表示
  if (!inputVal) {
    input.disabled = true;
    showReveal(inputVal, true);
    return;
  }

  const correct = checkAnswer(inputVal, currentWord.meaning);

  if (correct) {
    input.className = 'answer-input correct';
    input.disabled = true;
    showFeedback('perfect');
    setTimeout(() => {
      markCorrect();
    }, 400);
  } else {
    input.className = 'answer-input wrong';
    input.disabled = true;
    showReveal(inputVal, false);
  }
}

function showReveal(inputVal, isEmpty) {
  waitingForAction = true;
  document.getElementById('reveal-correct').textContent = currentWord.meaning;
  document.getElementById('reveal-yours').textContent = isEmpty ? '(未入力)' : inputVal;
  document.getElementById('reveal-area').classList.add('visible');
  document.getElementById('action-buttons').classList.add('visible');
}

function markCorrect() {
  sessionResults.correct.push(currentWord);
  markSolved(currentWord.id);
  dailyCount++;
  if (dailyDate !== todayStr()) { dailyDate = todayStr(); dailyCount = 1; }
  saveProgress();
  nextWord();
}
function markWrong() {
  sessionResults.wrong.push(currentWord);
  recordMissed(currentWord);
  saveMissed();
  nextWord();
}

function onCorrectBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;
  showFeedback('great');
  markSolved(currentWord.id);
  dailyCount++;
  if (dailyDate !== todayStr()) { dailyDate = todayStr(); dailyCount = 1; }
  saveProgress();
  sessionResults.correct.push(currentWord);
  setTimeout(nextWord, 400);
}

function onWrongBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;

  document.getElementById('reveal-area').classList.remove('visible');
  document.getElementById('action-buttons').classList.remove('visible');

  // Show wrong overlay
  const overlay = document.getElementById('wrong-overlay');
  document.getElementById('wrong-word-en').textContent = currentWord.word;
  document.getElementById('wrong-word-ja').textContent = currentWord.meaning;
  overlay.classList.add('visible');
  isShowingWrong = true;

  sessionResults.wrong.push(currentWord);
  recordMissed(currentWord);
  saveMissed();
}

function dismissWrong() {
  if (!isShowingWrong) return;
  isShowingWrong = false;
  document.getElementById('wrong-overlay').classList.remove('visible');
  nextWord();
}

function nextWord() {
  studyIdx++;
  if (studyMode === 'custom' && customSession) {
    customSession.currentIdx++;
    saveCustomSession();
  }
  if (studyIdx >= studyQueue.length) {
    finishSession();
  } else {
    renderWord();
  }
}

// ============================================
//  フィードバック表示
// ============================================
function showFeedback(type) {
  const overlay = document.getElementById('feedback-overlay');
  overlay.innerHTML = '';
  const el = document.createElement('div');
  el.className = `feedback-text ${type}`;
  el.textContent = type === 'perfect' ? 'PERFECT!!' : 'Great.';
  overlay.appendChild(el);

  // 0.6秒後にフェードアウト
  setTimeout(() => {
    el.style.animation = 'feedback-fade 0.4s forwards';
    setTimeout(() => { overlay.innerHTML = ''; }, 400);
  }, 320);
}

// ============================================
//  セッション終了
// ============================================
function finishSession() {
  if (studyMode === 'custom' && customSession) {
    if (customSession.currentIdx >= customSession.queue.length) {
      customSession = null;
      saveCustomSession();
    }
  }
  showResultScreen();
}

function showResultScreen() {
  showScreen('result');

  const wrong = sessionResults.wrong;
  const correct = sessionResults.correct;
  const allOK = wrong.length === 0;

  // Header
  const header = document.getElementById('result-header');
  if (allOK) {
    header.innerHTML = `<div class="congrats-text">🎉 Congratulations!</div>
      <div class="result-subtitle">全問正解！</div>`;
  } else {
    header.innerHTML = `<div class="result-title">結果</div>
      <div class="result-subtitle">正解 ${correct.length} / 間違い ${wrong.length}</div>`;
  }

  // Wrong list
  const wrongSec = document.getElementById('result-wrong-section');
  const wrongList = document.getElementById('result-wrong-list');
  wrongList.innerHTML = '';
  if (wrong.length > 0) {
    wrongSec.style.display = '';
    wrong.forEach(w => {
      wrongList.appendChild(makeWordRow(w, 'missed'));
    });
  } else {
    wrongSec.style.display = 'none';
  }

  // Correct list
  const correctList = document.getElementById('result-correct-list');
  correctList.innerHTML = '';
  correct.forEach(w => {
    correctList.appendChild(makeWordRow(w, 'correct'));
  });

  // Buttons
  document.getElementById('btn-retry').style.display = allOK ? 'none' : '';
  document.getElementById('btn-next').style.display = allOK ? '' : 'none';
  document.getElementById('btn-home-result').style.display = '';
}

function makeWordRow(w, cls) {
  const row = document.createElement('div');
  row.className = `word-row ${cls}`;
  row.innerHTML = `<span class="word-row-en">${esc(w.word)}</span>
    <span class="word-row-ja">${esc(w.meaning)}</span>`;
  return row;
}

function retrySession() {
  const retryWords = [...sessionResults.wrong];
  shuffle(retryWords);
  beginSession(studyMode, retryWords);
}

async function nextSession() {
  if (studyMode === 'quick') {
    updateMainMenu();
    showScreen('main');
  } else if (studyMode === 'review') {
    updateMainMenu();
    showScreen('main');
  } else {
    showScreen('main');
  }
  updateMainMenu();
}

// ============================================
//  認証
// ============================================
async function loginEmail() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'メールとパスワードを入力してください'; return; }
  showLoading();
  try {
    await auth.signInWithEmailAndPassword(email, pass);
  } catch (e) {
    hideLoading();
    err.textContent = getAuthError(e.code);
  }
}

async function signupEmail() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'メールとパスワードを入力してください'; return; }
  if (pass.length < 6) { err.textContent = 'パスワードは6文字以上'; return; }
  showLoading();
  try {
    await auth.createUserWithEmailAndPassword(email, pass);
  } catch (e) {
    hideLoading();
    err.textContent = getAuthError(e.code);
  }
}

async function loginGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  showLoading();
  try {
    await auth.signInWithPopup(provider);
  } catch (e) {
    hideLoading();
    document.getElementById('login-error').textContent = getAuthError(e.code);
  }
}

function logout() {
  auth.signOut().then(() => {
    solvedBits = {}; dailyCount = 0; missedWords = {}; customSession = null;
    showScreen('login'); updateMainMenu();
  });
}

function getAuthError(code) {
  const map = {
    'auth/user-not-found': 'ユーザーが見つかりません',
    'auth/wrong-password': 'パスワードが違います',
    'auth/email-already-in-use': 'このメールは使用中です',
    'auth/invalid-email': 'メールアドレスが不正です',
    'auth/weak-password': 'パスワードが弱すぎます',
    'auth/popup-closed-by-user': 'ポップアップが閉じられました',
  };
  return map[code] || `エラー: ${code}`;
}

// ============================================
//  設定保存
// ============================================
function onDailyGoalChange(val) {
  settings.dailyGoal = parseInt(val) || 50;
  saveSettings();
  updateMainMenu();
}
function onAutoPlayChange(checked) {
  settings.autoPlay = checked;
  saveSettings();
}

// ============================================
//  DOMイベント登録
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();

  // ---- Login ----
  document.getElementById('btn-login').addEventListener('click', loginEmail);
  document.getElementById('btn-signup').addEventListener('click', signupEmail);
  document.getElementById('btn-google').addEventListener('click', loginGoogle);

  document.getElementById('login-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') loginEmail();
  });

  // ---- Nav ----
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const screen = el.dataset.screen;
      if (screen) { showScreen(screen); if (screen === 'main') updateMainMenu(); }
    });
  });

  // ---- Main Menu ----
  document.getElementById('btn-quick').addEventListener('click', startQuick);
  document.getElementById('btn-review').addEventListener('click', startReview);
  document.getElementById('btn-resume').addEventListener('click', resumeCustom);

  // Custom panel toggle
  document.getElementById('btn-custom-toggle').addEventListener('click', () => {
    const panel = document.getElementById('custom-panel');
    const chevron = document.querySelector('.custom-chevron');
    const open = panel.classList.toggle('open');
    chevron.classList.toggle('open', open);
  });
  document.getElementById('btn-custom-start').addEventListener('click', startCustom);

  // ---- Study ----
  document.getElementById('answer-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAnswer();
  });
  document.getElementById('btn-correct').addEventListener('click', onCorrectBtn);
  document.getElementById('btn-wrong').addEventListener('click', onWrongBtn);
  document.getElementById('wrong-overlay').addEventListener('click', dismissWrong);
  document.getElementById('btn-exit-study').addEventListener('click', () => {
    showScreen('main'); updateMainMenu();
  });

  // ---- Result ----
  document.getElementById('btn-retry').addEventListener('click', retrySession);
  document.getElementById('btn-next').addEventListener('click', nextSession);
  document.getElementById('btn-home-result').addEventListener('click', () => {
    showScreen('main'); updateMainMenu();
  });

  // ---- Settings ----
  document.getElementById('setting-daily').addEventListener('change', e => onDailyGoalChange(e.target.value));
  document.getElementById('setting-autoplay').addEventListener('change', e => onAutoPlayChange(e.target.checked));
  document.getElementById('btn-logout').addEventListener('click', logout);
});
