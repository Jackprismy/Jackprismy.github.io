// ============================================
//  BADDEST-2.JS
// ============================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyArcz8EpMoYsYlz6srKxJMnBFxQrUS4-iw",
  authDomain: "baddest-1.firebaseapp.com",
  projectId: "baddest-1",
  storageBucket: "baddest-1.firebasestorage.app",
  messagingSenderId: "725409988165",
  appId: "1:725409988165:web:64b046886948aabc882d2c"
};

// ============================================
//  Firebase
// ============================================
let auth, db, currentUser;

function initFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    auth.onAuthStateChanged(user => {
      if (user) { currentUser = user; onUserLoggedIn(); }
      else      { currentUser = null; showScreen('login'); hideLoading(); }
    });
  } catch (e) {
    console.error('Firebase init:', e);
    hideLoading();
    showToast('Firebase接続エラー');
  }
}

// ============================================
//  Firestore パス
//  ※ Firestoreは「コレクション/ドキュメント」を交互に繰り返す必要がある
//  正しいパス例: users/{uid}/data/progress  (4階層)
//  誤りのパス例: users/{uid}/progress       (3階層 → エラー)
// ============================================
function dataDoc(name) {
  // users/{uid}/data/{name}
  return db.collection('users').doc(currentUser.uid).collection('data').doc(name);
}
function missedCol() {
  // users/{uid}/missed/{chunkDoc}
  return db.collection('users').doc(currentUser.uid).collection('missed');
}

// ============================================
//  設定
// ============================================
let settings = { dailyGoal: 50, autoPlay: false };

async function loadSettings() {
  try {
    const snap = await dataDoc('settings').get();
    if (snap.exists) settings = { ...settings, ...snap.data() };
  } catch (e) { console.error('loadSettings:', e); }
}
async function saveSettings() {
  try { await dataDoc('settings').set(settings); }
  catch (e) { console.error('saveSettings:', e); }
}

// ============================================
//  進捗
//  Firestore保存形式:
//    { dailyDate: "YYYY-MM-DD", dailyCount: 12, solvedIds: [1, 5, 23, ...] }
//  シンプルに問題番号の配列だけ。
// ============================================
let solvedSet  = new Set(); // 解いた問題IDのSet
let dailyDate  = '';
let dailyCount = 0;

function isSolved(id) { return solvedSet.has(id); }
function markSolved(id) { solvedSet.add(id); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadProgress() {
  try {
    const snap = await dataDoc('progress').get();
    if (snap.exists) {
      const d = snap.data();
      dailyDate  = d.dailyDate  || '';
      dailyCount = (d.dailyDate === todayStr()) ? (d.dailyCount || 0) : 0;
      solvedSet  = new Set((d.solvedIds || []).map(Number));
    }
  } catch (e) { console.error('loadProgress:', e); }
}

async function saveProgress() {
  try {
    await dataDoc('progress').set({
      dailyDate:  todayStr(),
      dailyCount: dailyCount,
      solvedIds:  Array.from(solvedSet)
    });
  } catch (e) { console.error('saveProgress:', e); }
}

// ============================================
//  間違えた問題
//  Firestore保存形式:
//    missed/chunk_0: { words: { "1": { count:2, lastDate:"2026-06-13" }, ... } }
//  単語テキストはJSONから毎回引くのでFirestoreには問題番号と日付だけ保存。
// ============================================
const MISSED_CHUNK = 500;
const MISSED_INIT  = 2;
const MISSED_MAX   = 2;

let missedWords = {};
// missedWords[wordId] = { count: number, lastDate: "YYYY-MM-DD" }
// ※ en/pos/jaはJSONから都度取得するため保存しない

async function loadMissed() {
  missedWords = {};
  try {
    const snaps = await missedCol().get();
    snaps.forEach(d => Object.assign(missedWords, d.data().words || {}));
  } catch (e) { console.error('loadMissed:', e); }
}

async function saveMissed() {
  // チャンク分割して保存
  const entries = Object.entries(missedWords);
  const chunks  = {};
  entries.forEach(([wid, data]) => {
    const cid = Math.floor(parseInt(wid) / MISSED_CHUNK);
    if (!chunks[cid]) chunks[cid] = {};
    chunks[cid][wid] = data;
  });
  try {
    const batch    = db.batch();
    const existing = await missedCol().get();
    existing.forEach(d => batch.delete(d.ref));
    for (const cid in chunks) {
      batch.set(missedCol().doc(`chunk_${cid}`), { words: chunks[cid] });
    }
    await batch.commit();
  } catch (e) { console.error('saveMissed:', e); }
}

function recordMissed(wordId) {
  const id = String(wordId);
  if (!missedWords[id]) {
    missedWords[id] = { count: MISSED_INIT, lastDate: todayStr() };
  } else {
    missedWords[id].count    = Math.min(missedWords[id].count + 1, MISSED_MAX);
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
  if (!missedWords[id]) return;
  missedWords[id].count    = Math.min(missedWords[id].count + 1, MISSED_MAX);
  missedWords[id].lastDate = todayStr();
}

// 翌日以降の単語 (lastDate < today)
function getReviewWordIds() {
  const today = todayStr();
  return Object.keys(missedWords)
    .filter(id => missedWords[id].lastDate < today)
    .map(Number);
}

// ============================================
//  セッション進捗
//  Firestore保存形式:
//    { active: true, mode: "quick", queue: [1,5,23,...], currentIdx: 3, date: "..." }
// ============================================
let currentSession = null;

async function loadCurrentSession() {
  try {
    const snap = await dataDoc('session').get();
    if (snap.exists) {
      const d = snap.data();
      if (d.active) currentSession = d;
    }
  } catch (e) { console.error('loadCurrentSession:', e); }
}
async function saveCurrentSession() {
  try {
    if (currentSession) {
      await dataDoc('session').set({ ...currentSession, active: true });
    } else {
      await dataDoc('session').set({ active: false });
    }
  } catch (e) { console.error('saveCurrentSession:', e); }
}
async function clearCurrentSession() {
  currentSession = null;
  await saveCurrentSession();
}

// ============================================
//  単語データ (JSONファイル)
// ============================================
let wordCache = {};
const WORDS_PER_FILE = 800;

function fileNumForId(id) { return Math.floor((id - 1) / WORDS_PER_FILE) + 1; }
function idxInFile(id)    { return (id - 1) % WORDS_PER_FILE; }

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
  const total    = await getTotalWordCount();
  const unsolved = [];
  for (let i = 1; i <= total; i++) {
    if (!isSolved(i)) unsolved.push(i);
    if (unsolved.length >= count * 6) break;
  }
  shuffle(unsolved);
  const words = [];
  for (const id of unsolved.slice(0, count)) {
    const w = await getWord(id); if (w) words.push(w);
  }
  return words;
}

async function buildCustomQueue(start, end, count) {
  const allIds = [];
  for (let i = start; i <= end; i++) allIds.push(i);
  shuffle(allIds);
  const words = [];
  for (const id of allIds.slice(0, count)) {
    const w = await getWord(id); if (w) words.push(w);
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
  const noNav = ['login', 'study', 'result'];
  document.getElementById('bottom-nav').style.display = noNav.includes(name) ? 'none' : 'flex';
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.screen === name)
  );
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

  const R = 70, C = 2 * Math.PI * R;
  const fg = document.getElementById('ring-fg');
  fg.setAttribute('stroke-dasharray', C);
  fg.setAttribute('stroke-dashoffset', C - C * pct);

  // 復習ボタン
  document.getElementById('review-btn-wrap')
    .classList.toggle('visible', getReviewWordIds().length > 0);

  // 再開バナー
  const banner = document.getElementById('resume-banner');
  if (currentSession && currentSession.active) {
    banner.classList.add('visible');
    const rem = currentSession.queue.length - currentSession.currentIdx;
    const label = { quick:'クイック', custom:'カスタム', review:'復習' };
    document.getElementById('resume-info').textContent =
      `${label[currentSession.mode] || ''}セッション (残り${rem}問)`;
  } else {
    banner.classList.remove('visible');
  }

  document.getElementById('setting-daily').value      = settings.dailyGoal || 50;
  document.getElementById('setting-autoplay').checked = settings.autoPlay  || false;

  updateDataScreen();
}

async function updateDataScreen() {
  document.getElementById('stat-solved').textContent  = solvedSet.size;
  document.getElementById('stat-daily').textContent   = dailyDate === todayStr() ? dailyCount : 0;
  document.getElementById('stat-missed').textContent  = Object.keys(missedWords).length;
  document.getElementById('stat-goal').textContent    = settings.dailyGoal || 50;

  const reviewListBtn = document.getElementById('btn-review-from-list');
  if (reviewListBtn) reviewListBtn.disabled = Object.keys(missedWords).length === 0;

  // missedWordsのIDからJSONで単語テキストを引いて表示
  const list    = document.getElementById('missed-word-list');
  list.innerHTML = '';
  const entries = Object.entries(missedWords).sort((a,b) => b[1].count - a[1].count).slice(0, 30);
  for (const [id, d] of entries) {
    const w   = await getWord(parseInt(id));
    const row = document.createElement('div');
    row.className = 'missed-word-row';
    row.innerHTML = `
      <div class="missed-word-row-left">
        <div class="missed-word-en">${esc(w ? w.word    : `#${id}`)}</div>
        <div class="missed-word-ja">${esc(w ? w.meaning : '?')}</div>
      </div>
      <div class="missed-count">${d.count}</div>`;
    list.appendChild(row);
  }
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
//  スクロール制御
// ============================================
function updateStudyScroll() {
  const screen = document.getElementById('screen-study');
  const card   = document.getElementById('word-card');
  const body   = document.getElementById('study-body');
  if (!card || !body) return;
  screen.classList.toggle('allow-scroll', card.scrollHeight > body.clientHeight - 20);
}

// ============================================
//  学習セッション
// ============================================
let studyQueue       = [];
let studyIdx         = 0;
let studyMode        = 'quick';
let sessionResults   = { correct: [], wrong: [] };
let currentWord      = null;
let waitingForAction = false;
let isShowingWrong   = false;

async function startQuick() {
  showLoading();
  const words = await buildQuickQueue(10);
  if (!words.length) { hideLoading(); showToast('未解の問題がありません'); return; }
  currentSession = { active:true, mode:'quick', queue:words.map(w=>w.id), currentIdx:0, date:todayStr() };
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
  currentSession = { active:true, mode:'custom', queue:words.map(w=>w.id), currentIdx:0, date:todayStr(), rangeStart:start, rangeEnd:end, count };
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
    await clearCurrentSession(); hideLoading(); showToast('セッションが終了しています'); updateMainMenu(); return;
  }
  beginSession(currentSession.mode, words, true);
  hideLoading();
}

async function startReview() {
  showLoading();
  const ids   = getReviewWordIds();
  shuffle(ids);
  const batch = ids.slice(0, 10);
  if (!batch.length) { hideLoading(); showToast('復習する問題がありません'); return; }
  const words = [];
  for (const id of batch) { const w = await getWord(id); if (w) words.push(w); }
  currentSession = { active:true, mode:'review', queue:words.map(w=>w.id), currentIdx:0, date:todayStr() };
  await saveCurrentSession();
  beginSession('review', words);
  hideLoading();
}

async function startReviewFromList() {
  const ids = Object.keys(missedWords).map(Number);
  if (!ids.length) { showToast('間違えた単語がありません'); return; }
  showLoading();
  shuffle(ids);
  const words = [];
  for (const id of ids.slice(0, 10)) { const w = await getWord(id); if (w) words.push(w); }
  currentSession = { active:true, mode:'review', queue:words.map(w=>w.id), currentIdx:0, date:todayStr() };
  await saveCurrentSession();
  beginSession('review', words);
  hideLoading();
}

function beginSession(mode, words, resumed = false) {
  studyMode      = mode;
  studyQueue     = words;
  studyIdx       = 0;
  sessionResults = { correct: [], wrong: [] };
  showScreen('study');
  renderWord();
}

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
  document.getElementById('wrong-overlay').classList.remove('visible', 'fading');
  document.getElementById('feedback-overlay').innerHTML = '';

  setTimeout(updateStudyScroll, 50);

  if (settings.autoPlay && 'speechSynthesis' in window) pronounceWord(currentWord.word);
  input.focus();
}

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
  const today = todayStr();
  if (dailyDate !== today) { dailyDate = today; dailyCount = 0; }
  dailyCount++;
}

async function markCorrect() {
  sessionResults.correct.push(currentWord);
  markSolved(currentWord.id);
  incrementDailyCount();
  if (studyMode === 'review') {
    reduceMissed(currentWord.id);
    await saveMissed();
  }
  await saveProgress();
  await nextWord();
}

async function onCorrectBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;
  showFeedback('great');
  markSolved(currentWord.id);
  incrementDailyCount();
  sessionResults.correct.push(currentWord);
  if (studyMode === 'review') {
    reduceMissed(currentWord.id);
    await saveMissed();
  }
  await saveProgress();
  setTimeout(nextWord, 400);
}

let wrongDismissTimer = null;

async function onWrongBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;

  document.getElementById('reveal-area').classList.remove('visible');
  document.getElementById('action-buttons').classList.remove('visible');

  const overlay = document.getElementById('wrong-overlay');
  document.getElementById('wrong-word-en').textContent = currentWord.word;
  document.getElementById('wrong-word-ja').textContent = currentWord.meaning;
  overlay.classList.remove('visible', 'fading');
  void overlay.offsetWidth;
  overlay.classList.add('visible');
  isShowingWrong = true;

  sessionResults.wrong.push(currentWord);
  if (studyMode === 'review') increaseMissed(currentWord.id);
  else                        recordMissed(currentWord.id);
  await saveMissed();

  clearTimeout(wrongDismissTimer);
  wrongDismissTimer = setTimeout(() => {
    overlay.classList.add('fading');
    setTimeout(() => {
      overlay.classList.remove('visible', 'fading');
      isShowingWrong = false;
      nextWord();
    }, 200);
  }, 500);
}

function dismissWrong() {
  if (!isShowingWrong) return;
  clearTimeout(wrongDismissTimer);
  document.getElementById('wrong-overlay').classList.remove('visible', 'fading');
  isShowingWrong = false;
  nextWord();
}

async function nextWord() {
  studyIdx++;
  if (currentSession) {
    currentSession.currentIdx++;
    await saveCurrentSession();
  }
  if (studyIdx >= studyQueue.length) finishSession();
  else                               renderWord();
}

// ============================================
//  フィードバック
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
//  セッション終了・結果
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
    header.innerHTML = `<div class="congrats-text">🎉 Congratulations!</div><div class="result-subtitle">全問正解！</div>`;
  } else {
    header.innerHTML = `<div class="result-title">結果</div><div class="result-subtitle">正解 ${correct.length} / 間違い ${wrong.length}</div>`;
  }

  const wrongSec = document.getElementById('result-wrong-section');
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
  row.innerHTML = `<span class="word-row-en">${esc(w.word)}</span><span class="word-row-ja">${esc(w.meaning)}</span>`;
  return row;
}

function retrySession() {
  beginSession(studyMode, shuffle([...sessionResults.wrong]));
}
async function nextSession() {
  updateMainMenu(); showScreen('main');
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
  showLoading();
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (e) { hideLoading(); document.getElementById('login-error').textContent = getAuthError(e.code); }
}
function logout() {
  auth.signOut().then(() => {
    solvedSet = new Set(); dailyCount = 0; missedWords = {}; currentSession = null;
    showScreen('login');
  });
}
function getAuthError(code) {
  const map = {
    'auth/user-not-found':       'ユーザーが見つかりません',
    'auth/wrong-password':       'パスワードが違います',
    'auth/email-already-in-use': 'このメールは使用中です',
    'auth/invalid-email':        'メールアドレスが不正です',
    'auth/weak-password':        'パスワードが弱すぎます',
    'auth/popup-closed-by-user': 'ポップアップが閉じられました',
    'auth/invalid-credential':   'メールまたはパスワードが正しくありません',
  };
  return map[code] || `エラー: ${code}`;
}

// ============================================
//  設定
// ============================================
function onDailyGoalChange(val) {
  settings.dailyGoal = parseInt(val) || 50;
  saveSettings(); updateMainMenu();
}
function onAutoPlayChange(checked) {
  settings.autoPlay = checked; saveSettings();
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
  document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key==='Enter') loginEmail(); });

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const s = el.dataset.screen;
      if (s) { showScreen(s); if (s==='main') updateMainMenu(); if (s==='data') updateDataScreen(); }
    });
  });

  // Main
  document.getElementById('btn-quick').addEventListener('click',  startQuick);
  document.getElementById('btn-review').addEventListener('click', startReview);
  document.getElementById('btn-resume').addEventListener('click', resumeSession);
  document.getElementById('btn-resume-dismiss').addEventListener('click', async e => {
    e.stopPropagation();
    await clearCurrentSession();
    updateMainMenu();
    showToast('セッションを破棄しました');
  });
  document.getElementById('btn-custom-toggle').addEventListener('click', () => {
    const panel   = document.getElementById('custom-panel');
    const chevron = document.querySelector('.custom-chevron');
    const open    = panel.classList.toggle('open');
    chevron.classList.toggle('open', open);
  });
  document.getElementById('btn-custom-start').addEventListener('click', startCustom);

  // Data
  document.getElementById('btn-review-from-list').addEventListener('click', startReviewFromList);

  // Study
  document.getElementById('answer-input').addEventListener('keydown', e => { if (e.key==='Enter') handleAnswer(); });
  document.getElementById('btn-correct').addEventListener('click',   onCorrectBtn);
  document.getElementById('btn-wrong').addEventListener('click',     onWrongBtn);
  document.getElementById('wrong-overlay').addEventListener('click', dismissWrong);
  document.getElementById('btn-exit-study').addEventListener('click', () => { showScreen('main'); updateMainMenu(); });
  document.getElementById('btn-pronounce').addEventListener('click', () => { if (currentWord) pronounceWord(currentWord.word); });

  // Result
  document.getElementById('btn-retry').addEventListener('click',       retrySession);
  document.getElementById('btn-next').addEventListener('click',        nextSession);
  document.getElementById('btn-home-result').addEventListener('click', () => { showScreen('main'); updateMainMenu(); });

  // Settings
  document.getElementById('setting-daily').addEventListener('change', e => onDailyGoalChange(e.target.value));
  document.getElementById('setting-autoplay').addEventListener('change', e => onAutoPlayChange(e.target.checked));
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Resize
  window.addEventListener('resize', updateStudyScroll);

  // ページ離脱時の保険的保存（問題ごとにawaitしているため基本は不要）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentUser) {
      saveCurrentSession();
      saveProgress();
    }
  });
  window.addEventListener('pagehide', () => {
    if (currentUser) { saveCurrentSession(); saveProgress(); }
  });
});
