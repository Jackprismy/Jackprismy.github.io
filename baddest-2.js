// ============================================
//  BADDEST.JS — Vocabulary App Core Logic
// ============================================

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
    db   = firebase.firestore();
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
//  Firestore ユーティリティ
// ============================================
function userDoc(sub) { return db.doc(`users/${currentUser.uid}/${sub}`); }

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
  try { await userDoc('settings').set(settings); } catch (e) {}
}

// ============================================
//  進捗 BitField
// ============================================
const CHUNK_SIZE = 240;
let solvedBits = {};
let dailyDate  = '';
let dailyCount = 0;

function chunkOf(id) { return Math.floor((id - 1) / CHUNK_SIZE); }
function bitPos(id)  { return (id - 1) % CHUNK_SIZE; }

function isSolved(id) {
  const cid = chunkOf(id);
  if (!solvedBits[cid]) return false;
  const pos = bitPos(id);
  return !!(solvedBits[cid][Math.floor(pos/8)] & (1 << (pos%8)));
}
function markSolved(id) {
  const cid = chunkOf(id);
  if (!solvedBits[cid]) solvedBits[cid] = new Uint8Array(30);
  const pos = bitPos(id);
  solvedBits[cid][Math.floor(pos/8)] |= (1 << (pos%8));
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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadProgress() {
  try {
    const snap = await userDoc('progress').get();
    if (snap.exists) {
      const d = snap.data();
      dailyDate  = d.dailyDate || '';
      dailyCount = (d.dailyDate === todayStr()) ? (d.dailyCount || 0) : 0;
      solvedBits = {};
      for (const cid in (d.solvedBits || {})) solvedBits[cid] = b64ToBits(d.solvedBits[cid]);
    }
  } catch (e) { console.warn('progress load:', e); }
}

async function saveProgress() {
  const raw = {};
  for (const cid in solvedBits) raw[cid] = bitsToB64(solvedBits[cid]);
  try {
    await userDoc('progress').set({ dailyDate: todayStr(), dailyCount, solvedBits: raw });
  } catch (e) {}
}

// ============================================
//  間違えた問題
//  count の意味:
//    初回ミス → 2でセット (次の日 + さらにその次の日の2回分)
//    復習正解 → -1 (0になったら削除)
//    復習不正解 → +1 (上限4)
//  getReviewWords() は lastDate < today の単語を返す
// ============================================
const MISSED_CHUNK  = 500;
const MISSED_INIT   = 2;   // 初回ミス時のカウント初期値
const MISSED_MAX    = 2;   // カウント上限

let missedWords = {};

async function loadMissed() {
  missedWords = {};
  try {
    const snaps = await db.collection(`users/${currentUser.uid}/missed`).get();
    snaps.forEach(d => Object.assign(missedWords, d.data().words || {}));
  } catch (e) { console.warn('missed load:', e); }
}

async function saveMissed() {
  const entries = Object.entries(missedWords);
  const chunks = {};
  entries.forEach(([wid, data]) => {
    const cid = Math.floor(parseInt(wid) / MISSED_CHUNK);
    if (!chunks[cid]) chunks[cid] = {};
    chunks[cid][wid] = data;
  });
  const batch = db.batch();
  try {
    const existing = await db.collection(`users/${currentUser.uid}/missed`).get();
    existing.forEach(d => batch.delete(d.ref));
    for (const cid in chunks) {
      batch.set(
        db.collection(`users/${currentUser.uid}/missed`).doc(`chunk_${cid}`),
        { words: chunks[cid] }
      );
    }
    await batch.commit();
  } catch (e) { console.warn('missed save:', e); }
}

// 初回ミス: count=2 でセット。既存の場合は count を min(count+1, MAX) で増やす
function recordMissed(word) {
  const id = String(word.id);
  if (!missedWords[id]) {
    missedWords[id] = {
      en: word.word, pos: word.pos || '', ja: word.meaning,
      count: MISSED_INIT, lastDate: todayStr()
    };
  } else {
    missedWords[id].count = Math.min(missedWords[id].count + 1, MISSED_MAX);
    missedWords[id].lastDate = todayStr();
  }
}

// 復習正解: count-1 (0以下で削除)
function reduceMissed(wordId) {
  const id = String(wordId);
  if (!missedWords[id]) return;
  missedWords[id].count--;
  if (missedWords[id].count <= 0) delete missedWords[id];
}

// 復習不正解: count+1 (上限4)
function increaseMissed(wordId) {
  const id = String(wordId);
  if (!missedWords[id]) return;
  missedWords[id].count = Math.min(missedWords[id].count + 1, MISSED_MAX);
  missedWords[id].lastDate = todayStr();
}

// 翌日以降 (lastDate < today) の単語
function getReviewWords() {
  const today = todayStr();
  return Object.entries(missedWords)
    .filter(([_, d]) => d.lastDate < today)
    .map(([id, d]) => ({ id: parseInt(id), word: d.en, pos: d.pos, meaning: d.ja }));
}

// ============================================
//  セッション進捗 (全モード対応・Firebase保存)
// ============================================
/*
  currentSession: {
    active:     bool,
    mode:       'quick' | 'custom' | 'review',
    queue:      [wordId, ...],
    currentIdx: number,
    date:       'YYYY-MM-DD',
    // カスタム専用
    rangeStart: number,
    rangeEnd:   number,
    count:      number,
  }
*/
let currentSession = null;

async function loadCurrentSession() {
  try {
    const snap = await userDoc('currentSession').get();
    if (snap.exists) {
      const d = snap.data();
      if (d.active) currentSession = d;
    }
  } catch (e) {}
}

async function saveCurrentSession() {
  try {
    if (currentSession) {
      await userDoc('currentSession').set({ ...currentSession, active: true });
    } else {
      await userDoc('currentSession').set({ active: false });
    }
  } catch (e) {}
}

async function clearCurrentSession() {
  currentSession = null;
  await saveCurrentSession();
}

// ============================================
//  単語データ
// ============================================
let wordCache = {};
const WORDS_PER_FILE = 800;

function fileNumForId(id)  { return Math.floor((id - 1) / WORDS_PER_FILE) + 1; }
function idxInFile(id)     { return (id - 1) % WORDS_PER_FILE; }

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

async function getWord(id) {
  const data = await loadWordFile(fileNumForId(id));
  if (!data) return null;
  const idx = idxInFile(id);
  if (idx >= data.length) return null;
  return { id, ...data[idx] };
}

async function getTotalWordCount() {
  let total = 0;
  for (let n = 1; ; n++) {
    const data = await loadWordFile(n);
    if (!data || data.length === 0) break;
    total += data.length;
  }
  return total;
}

// ============================================
//  キュー構築
// ============================================
async function buildQuickQueue(count = 10) {
  const total = await getTotalWordCount();
  const unsolved = [];
  for (let i = 1; i <= total; i++) {
    if (!isSolved(i)) unsolved.push(i);
    if (unsolved.length >= count * 6) break;
  }
  shuffle(unsolved);
  const ids   = unsolved.slice(0, count);
  const words = [];
  for (const id of ids) { const w = await getWord(id); if (w) words.push(w); }
  return words;
}

async function buildCustomQueue(start, end, count) {
  const allIds = [];
  for (let i = start; i <= end; i++) allIds.push(i);
  shuffle(allIds);
  const words = [];
  for (const id of allIds.slice(0, count)) {
    const w = await getWord(id);
    if (w) words.push(w);
  }
  return words;
}

// ============================================
//  答え照合
// ============================================
function normalize(str) {
  return str
    .replace(/[A-Za-z～〜\s\u00A0]+/g, ' ')
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
    const j = Math.floor(Math.random() * (i+1));
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
  const nav = document.getElementById('bottom-nav');
  const noNav = ['login', 'study', 'result'];
  nav.style.display = noNav.includes(name) ? 'none' : 'flex';
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.screen === name)
  );
}

function showLoading()  { document.getElementById('loading-overlay').classList.remove('hidden'); }
function hideLoading()  { document.getElementById('loading-overlay').classList.add('hidden'); }

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================
//  ログイン後の初期化
// ============================================
async function onUserLoggedIn() {
  showLoading();
  await loadSettings();
  await loadProgress();
  await loadMissed();
  await loadCurrentSession();
  updateMainMenu();
  showScreen('main');
  hideLoading();
}

// ============================================
//  メインメニュー更新
// ============================================
function updateMainMenu() {
  const goal   = settings.dailyGoal || 50;
  const done   = dailyDate === todayStr() ? dailyCount : 0;
  const pct    = Math.min(done / goal, 1);
  const pctInt = Math.round(pct * 100);

  document.getElementById('ring-fraction').textContent = `${done}/${goal}`;
  document.getElementById('ring-percent').textContent  = `${pctInt}%`;

  const R  = 70, C = 2 * Math.PI * R;
  const fg = document.getElementById('ring-fg');
  fg.setAttribute('stroke-dasharray', C);
  fg.setAttribute('stroke-dashoffset', C - (C * pct));

  // 復習ボタン
  document.getElementById('review-btn-wrap')
    .classList.toggle('visible', getReviewWords().length > 0);

  // 再開バナー
  const banner = document.getElementById('resume-banner');
  if (currentSession && currentSession.active) {
    banner.classList.add('visible');
    const rem = currentSession.queue.length - currentSession.currentIdx;
    const modeLabel = { quick:'クイック', custom:'カスタム', review:'復習' };
    document.getElementById('resume-info').textContent =
      `${modeLabel[currentSession.mode] || ''}セッション (残り${rem}問)`;
  } else {
    banner.classList.remove('visible');
  }

  document.getElementById('setting-daily').value       = settings.dailyGoal || 50;
  document.getElementById('setting-autoplay').checked  = settings.autoPlay  || false;

  updateDataScreen();
}

function updateDataScreen() {
  const totalSolved = Object.values(solvedBits).reduce((a, arr) => {
    let c = 0; arr.forEach(b => { for(let i=0;i<8;i++) if(b&(1<<i)) c++; }); return a+c;
  }, 0);
  document.getElementById('stat-solved').textContent  = totalSolved;
  document.getElementById('stat-daily').textContent   = dailyDate === todayStr() ? dailyCount : 0;
  document.getElementById('stat-missed').textContent  = Object.keys(missedWords).length;
  document.getElementById('stat-goal').textContent    = settings.dailyGoal || 50;

  // リストから復習ボタンの有効/無効
  const reviewListBtn = document.getElementById('btn-review-from-list');
  if (reviewListBtn) reviewListBtn.disabled = Object.keys(missedWords).length === 0;

  const list = document.getElementById('missed-word-list');
  list.innerHTML = '';
  Object.entries(missedWords)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0, 30)
    .forEach(([id, d]) => {
      const row = document.createElement('div');
      row.className = 'missed-word-row';
      row.innerHTML = `
        <div class="missed-word-row-left">
          <div class="missed-word-en">${esc(d.en)}</div>
          <div class="missed-word-ja">${esc(d.ja)}</div>
        </div>
        <div class="missed-count">${d.count}</div>`;
      list.appendChild(row);
    });
}

// ============================================
//  発音
// ============================================
function pronounceWord(word) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(word);
  utt.lang   = 'en-US';
  utt.rate   = 0.9;
  const btn  = document.getElementById('btn-pronounce');
  btn.classList.add('speaking');
  utt.onend  = () => btn.classList.remove('speaking');
  utt.onerror = () => btn.classList.remove('speaking');
  speechSynthesis.speak(utt);
}

// ============================================
//  スクロール制御 (学習画面)
// ============================================
function updateStudyScroll() {
  const screen = document.getElementById('screen-study');
  const card   = document.getElementById('word-card');
  const body   = document.getElementById('study-body');
  if (!card || !body) return;
  // カードの実高さがbodyより大きい場合のみスクロール許可
  const cardH  = card.scrollHeight;
  const bodyH  = body.clientHeight;
  screen.classList.toggle('allow-scroll', cardH > bodyH - 20);
}

// ============================================
//  学習セッション
// ============================================
let studyQueue         = [];
let studyIdx           = 0;
let studyMode          = 'quick';
let sessionResults     = { correct: [], wrong: [] };
let currentWord        = null;
let waitingForAction   = false;
let isShowingWrong     = false;

// --- セッション開始ロジック ---
async function startQuick() {
  showLoading();
  const words = await buildQuickQueue(10);
  if (!words.length) { hideLoading(); showToast('未解の問題がありません'); return; }
  currentSession = {
    active: true, mode: 'quick',
    queue: words.map(w => w.id), currentIdx: 0, date: todayStr()
  };
  await saveCurrentSession();
  beginSession('quick', words);
  hideLoading();
}

async function startCustom() {
  const start = parseInt(document.getElementById('custom-start').value) || 1;
  const end   = parseInt(document.getElementById('custom-end').value)   || 800;
  const count = parseInt(document.getElementById('custom-count').value) || 50;
  if (start > end) { showToast('範囲が不正です'); return; }

  showLoading();
  const words = await buildCustomQueue(start, end, count);
  if (!words.length) { hideLoading(); showToast('問題を読み込めませんでした'); return; }
  currentSession = {
    active: true, mode: 'custom',
    queue: words.map(w => w.id), currentIdx: 0, date: todayStr(),
    rangeStart: start, rangeEnd: end, count
  };
  await saveCurrentSession();
  beginSession('custom', words);
  hideLoading();
}

async function resumeSession() {
  if (!currentSession) return;
  showLoading();
  const sliced = currentSession.queue.slice(currentSession.currentIdx);
  const words  = [];
  for (const id of sliced) { const w = await getWord(id); if (w) words.push(w); }
  if (!words.length) {
    await clearCurrentSession();
    hideLoading();
    showToast('セッションが終了しています');
    updateMainMenu();
    return;
  }
  beginSession(currentSession.mode, words, true);
  hideLoading();
}

async function startReview() {
  showLoading();
  const all   = getReviewWords();
  shuffle(all);
  const batch = all.slice(0, 10);
  if (!batch.length) { hideLoading(); showToast('復習する問題がありません'); return; }
  currentSession = {
    active: true, mode: 'review',
    queue: batch.map(w => w.id), currentIdx: 0, date: todayStr()
  };
  await saveCurrentSession();
  beginSession('review', batch);
  hideLoading();
}

// データ画面の「リストから復習」— missedWords全件からシャッフルして10問ずつ
async function startReviewFromList() {
  const all = Object.entries(missedWords).map(([id, d]) => ({
    id: parseInt(id), word: d.en, pos: d.pos, meaning: d.ja
  }));
  if (!all.length) { showToast('間違えた単語がありません'); return; }
  showLoading();
  shuffle(all);
  const batch = all.slice(0, 10);
  currentSession = {
    active: true, mode: 'review',
    queue: batch.map(w => w.id), currentIdx: 0, date: todayStr()
  };
  await saveCurrentSession();
  beginSession('review', batch);
  hideLoading();
}

// resumed: 再開フラグ (studyIdxは0から始める = wordsがsliced済みの場合)
function beginSession(mode, words, resumed = false) {
  studyMode      = mode;
  studyQueue     = words;
  studyIdx       = 0;
  sessionResults = { correct: [], wrong: [] };
  showScreen('study');
  renderWord();
}

// --- 問題描画 ---
function renderWord() {
  currentWord = studyQueue[studyIdx];
  if (!currentWord) { finishSession(); return; }

  isShowingWrong   = false;
  waitingForAction = false;

  const total = studyQueue.length;
  document.getElementById('study-progress-text').textContent = `${studyIdx+1} / ${total}`;
  document.getElementById('study-progress-fill').style.width = `${(studyIdx/total)*100}%`;

  document.getElementById('word-pos').textContent = currentWord.pos || '';
  document.getElementById('word-en').textContent  = currentWord.word;

  const input = document.getElementById('answer-input');
  input.value     = '';
  input.className = 'answer-input';
  input.disabled  = false;

  document.getElementById('reveal-area').classList.remove('visible');
  document.getElementById('action-buttons').classList.remove('visible');
  document.getElementById('wrong-overlay').classList.remove('visible');
  document.getElementById('feedback-overlay').innerHTML = '';

  // スクロール制御更新
  setTimeout(updateStudyScroll, 50);

  if (settings.autoPlay && 'speechSynthesis' in window) {
    pronounceWord(currentWord.word);
  }
  input.focus();
}

// --- 答え処理 ---
function handleAnswer() {
  if (isShowingWrong || waitingForAction) return;
  const input    = document.getElementById('answer-input');
  const inputVal = input.value.trim();

  if (!inputVal) {
    input.disabled = true;
    showReveal(inputVal, true);
    return;
  }
  if (checkAnswer(inputVal, currentWord.meaning)) {
    input.className = 'answer-input correct';
    input.disabled  = true;
    showFeedback('perfect');
    setTimeout(markCorrect, 400);
  } else {
    input.className = 'answer-input wrong';
    input.disabled  = true;
    showReveal(inputVal, false);
    setTimeout(updateStudyScroll, 50);
  }
}

function showReveal(inputVal, isEmpty) {
  waitingForAction = true;
  document.getElementById('reveal-correct').textContent = currentWord.meaning;
  document.getElementById('reveal-yours').textContent   = isEmpty ? '(未入力)' : inputVal;
  document.getElementById('reveal-area').classList.add('visible');
  document.getElementById('action-buttons').classList.add('visible');
  setTimeout(updateStudyScroll, 50);
}

function incrementDailyCount() {
  // 日付が変わっていたらリセットしてから加算
  const today = todayStr();
  if (dailyDate !== today) {
    dailyDate  = today;
    dailyCount = 0;
  }
  dailyCount++;
}

function markCorrect() {
  sessionResults.correct.push(currentWord);
  markSolved(currentWord.id);
  incrementDailyCount();
  // 復習モードなら reduceMissed
  if (studyMode === 'review') {
    reduceMissed(currentWord.id);
    saveMissed();
  }
  saveProgress();
  nextWord();
}

function onCorrectBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;
  showFeedback('great');
  markSolved(currentWord.id);
  incrementDailyCount();
  sessionResults.correct.push(currentWord);
  if (studyMode === 'review') {
    reduceMissed(currentWord.id);
    saveMissed();
  }
  saveProgress();
  setTimeout(nextWord, 400);
}

let wrongDismissTimer = null;

function onWrongBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;

  document.getElementById('reveal-area').classList.remove('visible');
  document.getElementById('action-buttons').classList.remove('visible');

  const overlay = document.getElementById('wrong-overlay');
  document.getElementById('wrong-word-en').textContent = currentWord.word;
  document.getElementById('wrong-word-ja').textContent = currentWord.meaning;

  // visible を一旦外してアニメーションをリセットしてから再付与（再表示時にshakeを再トリガー）
  overlay.classList.remove('visible', 'fading');
  void overlay.offsetWidth; // reflow
  overlay.classList.add('visible');
  isShowingWrong = true;

  sessionResults.wrong.push(currentWord);

  if (studyMode === 'review') {
    increaseMissed(currentWord.id);
  } else {
    recordMissed(currentWord);
  }
  saveMissed();

  // 0.7秒後に自動でフェードアウト → 次の問題へ
  clearTimeout(wrongDismissTimer);
  wrongDismissTimer = setTimeout(() => {
    overlay.classList.add('fading');
    setTimeout(() => {
      overlay.classList.remove('visible', 'fading');
      isShowingWrong = false;
      nextWord();
    }, 200); // フェードアウト時間 (0.2s)
  }, 500); // 表示時間: 0.5s + 0.2s フェード = 0.7s
}

function dismissWrong() {
  if (!isShowingWrong) return;
  // タップで即スキップ（タイマーキャンセル）
  clearTimeout(wrongDismissTimer);
  const overlay = document.getElementById('wrong-overlay');
  overlay.classList.remove('visible', 'fading');
  isShowingWrong = false;
  nextWord();
}

async function nextWord() {
  studyIdx++;
  // Firebaseのセッション進捗を更新
  if (currentSession) {
    currentSession.currentIdx++;
    await saveCurrentSession();
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
  el.className  = `feedback-text ${type}`;
  el.textContent = type === 'perfect' ? 'PERFECT!!' : 'Great.';
  overlay.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'feedback-fade 0.4s forwards';
    setTimeout(() => { overlay.innerHTML = ''; }, 400);
  }, 320);
}

// ============================================
//  セッション終了
// ============================================
async function finishSession() {
  await clearCurrentSession();
  showResultScreen();
}

function showResultScreen() {
  showScreen('result');

  const wrong  = sessionResults.wrong;
  const correct = sessionResults.correct;
  const allOK  = wrong.length === 0;

  const header = document.getElementById('result-header');
  if (allOK) {
    header.innerHTML = `<div class="congrats-text">🎉 Congratulations!</div>
      <div class="result-subtitle">全問正解！</div>`;
  } else {
    header.innerHTML = `<div class="result-title">結果</div>
      <div class="result-subtitle">正解 ${correct.length} / 間違い ${wrong.length}</div>`;
  }

  const wrongSec  = document.getElementById('result-wrong-section');
  const wrongList = document.getElementById('result-wrong-list');
  wrongList.innerHTML = '';
  if (wrong.length > 0) {
    wrongSec.style.display = '';
    wrong.forEach(w => wrongList.appendChild(makeWordRow(w, 'missed')));
  } else {
    wrongSec.style.display = 'none';
  }

  const correctList = document.getElementById('result-correct-list');
  correctList.innerHTML = '';
  correct.forEach(w => correctList.appendChild(makeWordRow(w, 'correct')));

  document.getElementById('btn-retry').style.display       = allOK ? 'none' : '';
  document.getElementById('btn-next').style.display        = allOK ? '' : 'none';
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
  const retryWords = shuffle([...sessionResults.wrong]);
  beginSession(studyMode, retryWords);
}

async function nextSession() {
  updateMainMenu();
  showScreen('main');
}

// ============================================
//  認証
// ============================================
async function loginEmail() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const err   = document.getElementById('login-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'メールとパスワードを入力してください'; return; }
  showLoading();
  try { await auth.signInWithEmailAndPassword(email, pass); }
  catch (e) { hideLoading(); err.textContent = getAuthError(e.code); }
}

async function signupEmail() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const err   = document.getElementById('login-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'メールとパスワードを入力してください'; return; }
  if (pass.length < 6) { err.textContent = 'パスワードは6文字以上'; return; }
  showLoading();
  try { await auth.createUserWithEmailAndPassword(email, pass); }
  catch (e) { hideLoading(); err.textContent = getAuthError(e.code); }
}

async function loginGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  showLoading();
  try { await auth.signInWithPopup(provider); }
  catch (e) {
    hideLoading();
    document.getElementById('login-error').textContent = getAuthError(e.code);
  }
}

function logout() {
  auth.signOut().then(() => {
    solvedBits = {}; dailyCount = 0; missedWords = {}; currentSession = null;
    showScreen('login');
  });
}

function getAuthError(code) {
  const map = {
    'auth/user-not-found':      'ユーザーが見つかりません',
    'auth/wrong-password':      'パスワードが違います',
    'auth/email-already-in-use':'このメールは使用中です',
    'auth/invalid-email':       'メールアドレスが不正です',
    'auth/weak-password':       'パスワードが弱すぎます',
    'auth/popup-closed-by-user':'ポップアップが閉じられました',
    'auth/invalid-credential':  'メールまたはパスワードが正しくありません',
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

  // Login
  document.getElementById('btn-login').addEventListener('click',  loginEmail);
  document.getElementById('btn-signup').addEventListener('click', signupEmail);
  document.getElementById('btn-google').addEventListener('click', loginGoogle);
  document.getElementById('login-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') loginEmail();
  });

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const screen = el.dataset.screen;
      if (screen) { showScreen(screen); if (screen === 'main') updateMainMenu(); }
    });
  });

  // Main Menu
  document.getElementById('btn-quick').addEventListener('click',  startQuick);
  document.getElementById('btn-review').addEventListener('click', startReview);
  document.getElementById('btn-resume').addEventListener('click', resumeSession);

  // Data screen — リストから復習
  document.getElementById('btn-review-from-list').addEventListener('click', startReviewFromList);

  document.getElementById('btn-custom-toggle').addEventListener('click', () => {
    const panel   = document.getElementById('custom-panel');
    const chevron = document.querySelector('.custom-chevron');
    const open    = panel.classList.toggle('open');
    chevron.classList.toggle('open', open);
  });
  document.getElementById('btn-custom-start').addEventListener('click', startCustom);

  // Study
  document.getElementById('answer-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAnswer();
  });
  document.getElementById('btn-correct').addEventListener('click',     onCorrectBtn);
  document.getElementById('btn-wrong').addEventListener('click',       onWrongBtn);
  document.getElementById('wrong-overlay').addEventListener('click',   dismissWrong);
  document.getElementById('btn-exit-study').addEventListener('click', async () => {
    // 中断: currentSession は保存済みなのでそのまま
    showScreen('main');
    updateMainMenu();
  });

  // 発音ボタン
  document.getElementById('btn-pronounce').addEventListener('click', () => {
    if (currentWord) pronounceWord(currentWord.word);
  });

  // Result
  document.getElementById('btn-retry').addEventListener('click',       retrySession);
  document.getElementById('btn-next').addEventListener('click',        nextSession);
  document.getElementById('btn-home-result').addEventListener('click', () => {
    showScreen('main'); updateMainMenu();
  });

  // Settings
  document.getElementById('setting-daily').addEventListener('change', e => onDailyGoalChange(e.target.value));
  document.getElementById('setting-autoplay').addEventListener('change', e => onAutoPlayChange(e.target.checked));
  document.getElementById('btn-logout').addEventListener('click', logout);

  // リサイズ時のスクロール制御更新
  window.addEventListener('resize', updateStudyScroll);

  // ページ離脱・スリープ時にセッション進捗を保存
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentSession) {
      // navigator.sendBeacon は Firestore REST で代替困難なので
      // visibilitychange hidden で非同期保存（ほぼ間に合う）
      saveCurrentSession();
      saveProgress();
    }
  });
  window.addEventListener('pagehide', () => {
    if (currentSession) saveCurrentSession();
    saveProgress();
  });

  // セッション破棄ボタン
  document.getElementById('btn-resume-dismiss').addEventListener('click', async (e) => {
    e.stopPropagation();
    await clearCurrentSession();
    updateMainMenu();
    showToast('セッションを破棄しました');
  });
});
