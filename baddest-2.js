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
    setLoadingStatus('接続中...', 'Firebaseに接続しています');
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
//  Firestore パス (コレクション/Doc/コレクション/Doc = 4階層)
// ============================================
function dataDoc(name) {
  return db.collection('users').doc(currentUser.uid).collection('data').doc(name);
}
function missedCol() {
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
//  進捗 (解いた問題番号と日次カウント)
// ============================================
let solvedSet  = new Set();
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
//  間違えた問題 (問題番号+日付+回数のみ保存)
// ============================================
const MISSED_CHUNK = 500;
const MISSED_INIT  = 2;
const MISSED_MAX   = 2;

let missedWords = {};
// { wordId: { count, lastDate } }

async function loadMissed() {
  missedWords = {};
  try {
    const snaps = await missedCol().get();
    snaps.forEach(d => Object.assign(missedWords, d.data().words || {}));
  } catch (e) { console.error('loadMissed:', e); }
}
async function saveMissed() {
  const chunks = {};
  Object.entries(missedWords).forEach(([wid, data]) => {
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
function getReviewWordIds() {
  const today = todayStr();
  return Object.keys(missedWords).filter(id => missedWords[id].lastDate < today).map(Number);
}

// ============================================
//  クイック/復習セッション
// ============================================
let currentSession = null;

async function loadCurrentSession() {
  try {
    const snap = await dataDoc('session').get();
    if (snap.exists) { const d = snap.data(); if (d.active) currentSession = d; }
  } catch (e) { console.error('loadCurrentSession:', e); }
}
async function saveCurrentSession() {
  try {
    if (currentSession) await dataDoc('session').set({ ...currentSession, active: true });
    else                await dataDoc('session').set({ active: false });
  } catch (e) { console.error('saveCurrentSession:', e); }
}
async function clearCurrentSession() {
  currentSession = null;
  await saveCurrentSession();
}

// ============================================
//  カスタムコース
//  Firestore: data/customCourse
//  {
//    active:       true,
//    rangeStart:   1,
//    rangeEnd:     800,
//    totalInRange: 780,      // 実際に存在する問題数（初回起動時のみカウント）
//    completedIds: [1,5,...], // このコースで正解済みのID
//    currentBatch: [10,44,...], // 今解いている10問のID
//    batchIdx:     3          // currentBatch内の進捗（中断再開用）
//  }
// ============================================
let customCourse = null;

async function loadCustomCourse() {
  try {
    const snap = await dataDoc('customCourse').get();
    if (snap.exists) { const d = snap.data(); if (d.active) customCourse = d; }
  } catch (e) { console.error('loadCustomCourse:', e); }
}
async function saveCustomCourse() {
  try {
    if (customCourse) await dataDoc('customCourse').set({ ...customCourse, active: true });
    else              await dataDoc('customCourse').set({ active: false });
  } catch (e) { console.error('saveCustomCourse:', e); }
}
async function clearCustomCourse() {
  customCourse = null;
  await saveCustomCourse();
}

function customCourseProgress() {
  if (!customCourse || !customCourse.totalInRange) return 0;
  return customCourse.completedIds.length / customCourse.totalInRange;
}

// ============================================
//  単語データ
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

// 範囲内で実際に存在するIDを取得（JSON読み込み済みを活用して高速化）
async function getRangeIds(start, end) {
  // まず対象ファイルをすべてプリロード
  const fileNums = new Set();
  for (let id = start; id <= end; id++) fileNums.add(fileNumForId(id));
  await Promise.all([...fileNums].map(n => loadWordFile(n)));

  const ids = [];
  for (let id = start; id <= end; id++) {
    const data = wordCache[fileNumForId(id)];
    if (data && idxInFile(id) < data.length) ids.push(id);
  }
  return ids;
}

// ============================================
//  答え照合
// ============================================
function normalizeMeaning(str) {
  return str
    .replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')
    .replace(/(?<![A-Za-z])[A-Z](?![a-z])/g, '')
    .replace(/[A-Za-z\s\u00A0～〜]+/g, ' ')
    .replace(/[・、。，．]/g, '')
    .trim().replace(/\s+/g, ' ');
}
function checkAnswer(input, meaning) {
  return normalizeMeaning(input) === normalizeMeaning(meaning);
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

function showLoading(status = '', step = '') {
  document.getElementById('loading-overlay').classList.remove('hidden');
  setLoadingStatus(status, step);
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}
function setLoadingStatus(status, step = '') {
  const elStatus = document.getElementById('loader-status');
  const elStep   = document.getElementById('loader-step');
  if (!elStatus) return;
  // タイマー競合を避けるため即時更新
  if (status) elStatus.textContent = status;
  if (elStep)  elStep.textContent  = step;
}

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
  showLoading('認証確認中...', 'ユーザー情報を取得しています');
  setLoadingStatus('データを読み込んでいます', '設定・進捗・単語データを同時取得中...');
  await Promise.all([
    loadSettings(),
    loadProgress(),
    loadMissed(),
    loadCurrentSession(),
    loadCustomCourse(),
  ]);
  setLoadingStatus('準備完了！', 'メニューを表示します');
  // 画面切り替えを先に行ってからローディングを消す
  showScreen('main');
  updateMainMenu();
  // 非同期のupdateDataScreenが走り終わるのを待たずにローディングを即消す
  hideLoading();
}

// ============================================
//  メインメニュー更新
// ============================================
function updateMainMenu() {
  const goal   = settings.dailyGoal || 50;
  const done   = dailyDate === todayStr() ? dailyCount : 0;
  const pct    = done / goal;
  const pctInt = Math.round(pct * 100);
  const lap    = Math.floor(pct);

  document.getElementById('ring-fraction').textContent = `${done}/${goal}`;
  document.getElementById('ring-percent').textContent  = `${pctInt}%`;

  const R = 70, C = 2 * Math.PI * R;
  const fg = document.getElementById('ring-fg');
  const lapPct = pct - lap;
  fg.setAttribute('stroke-dasharray', C);
  fg.setAttribute('stroke-dashoffset', C - C * lapPct);
  fg.className = '';
  const pctEl = document.getElementById('ring-percent');
  pctEl.className = 'ring-percent';
  if (lap > 0) {
    const lapClass = `lap-${Math.min(lap, 5)}`;
    fg.classList.add(lapClass);
    pctEl.classList.add(lapClass);
  }

  // 復習ボタン
  document.getElementById('review-btn-wrap')
    .classList.toggle('visible', getReviewWordIds().length > 0);

  // クイック/復習セッション再開バナー
  const banner = document.getElementById('resume-banner');
  if (currentSession && currentSession.active) {
    banner.classList.add('visible');
    const rem   = currentSession.queue.length - currentSession.currentIdx;
    const label = { quick:'クイック', review:'復習' };
    document.getElementById('resume-info').textContent =
      `${label[currentSession.mode] || ''}セッション (残り${rem}問)`;
  } else {
    banner.classList.remove('visible');
  }

  // カスタムコース進行ボタン
  const courseBtn    = document.getElementById('btn-custom-course');
  const courseToggle = document.getElementById('btn-custom-toggle');
  if (customCourse && customCourse.active) {
    courseBtn.style.display    = '';
    courseToggle.style.display = 'none';
    const prog    = customCourseProgress();
    const progPct = Math.round(prog * 100);
    const total   = customCourse.totalInRange || 0;
    const done2   = customCourse.completedIds.length;
    document.getElementById('custom-course-fill').style.width  = `${progPct}%`;
    document.getElementById('custom-course-title').textContent =
      `カスタム (${customCourse.rangeStart}〜${customCourse.rangeEnd})`;
    document.getElementById('custom-course-info').textContent  =
      `${done2} / ${total} 問完了`;
    document.getElementById('custom-course-pct').textContent   = `${progPct}%`;
  } else {
    courseBtn.style.display    = 'none';
    courseToggle.style.display = '';
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

  const list = document.getElementById('missed-word-list');
  list.innerHTML = '';
  const entries = Object.entries(missedWords).sort((a,b) => b[1].count - a[1].count).slice(0, 30);
  for (const [id, d] of entries) {
    const w   = await getWord(parseInt(id));
    const row = document.createElement('div');
    row.className = 'missed-word-row';
    const posHtml = (w && w.pos) ? `<span class="missed-word-row-pos">${esc(w.pos)}</span>` : '';
    row.innerHTML = `
      <div class="missed-word-row-left">
        <div class="missed-word-en">${esc(w ? w.word : `#${id}`)} ${posHtml}</div>
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
  const utt   = new SpeechSynthesisUtterance(word);
  utt.lang    = 'en-US'; utt.rate = 0.9;
  const btn   = document.getElementById('btn-pronounce');
  btn.classList.add('speaking');
  utt.onend   = () => btn.classList.remove('speaking');
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
let studyMode        = 'quick';   // 'quick' | 'review' | 'custom'
let sessionResults   = { correct: [], wrong: [] };
let currentWord      = null;
let waitingForAction = false;
let isShowingWrong   = false;

// ---- クイックスタート ----
async function startQuick() {
  showLoading('クイックスタート準備中', '未解の問題を選んでいます...');
  const total    = await getTotalWordCount();
  const unsolved = [];
  for (let i = 1; i <= total; i++) {
    if (!isSolved(i)) unsolved.push(i);
    if (unsolved.length >= 60) break;
  }
  shuffle(unsolved);
  const words = [];
  for (const id of unsolved.slice(0, 10)) { const w = await getWord(id); if (w) words.push(w); }
  if (!words.length) { hideLoading(); showToast('未解の問題がありません'); return; }
  currentSession = { active:true, mode:'quick', queue:words.map(w=>w.id), currentIdx:0, date:todayStr() };
  await saveCurrentSession();
  beginSession('quick', words);
  hideLoading();
}

// ---- カスタムコース開始 ----
async function startCustomCourse() {
  const start = parseInt(document.getElementById('custom-start').value) || 1;
  const end   = parseInt(document.getElementById('custom-end').value)   || 800;
  if (start > end) { showToast('範囲が不正です'); return; }

  showLoading('カスタムコース開始', `${start}〜${end}番の問題を準備しています...`);

  // 対象ファイルを並列プリロードして高速にIDリスト取得
  const allIds = await getRangeIds(start, end);
  if (!allIds.length) { hideLoading(); showToast('問題を読み込めませんでした'); return; }

  customCourse = {
    active:       true,
    rangeStart:   start,
    rangeEnd:     end,
    totalInRange: allIds.length,
    completedIds: [],
    currentBatch: [],
    batchIdx:     0
  };
  await saveCustomCourse();
  hideLoading();

  await startNextCustomBatch();
}

// ---- カスタムコース：次のバッチ（10問）を出題 ----
async function startNextCustomBatch() {
  if (!customCourse) return;
  showLoading('次のセットを準備中', '未完了の問題を選んでいます...');

  const completedSet = new Set(customCourse.completedIds);

  // 全IDリストは getRangeIds で取得（キャッシュ済みなので高速）
  const allIds   = await getRangeIds(customCourse.rangeStart, customCourse.rangeEnd);
  const remaining = allIds.filter(id => !completedSet.has(id));

  if (remaining.length === 0) {
    // 全問完了
    hideLoading();
    await clearCustomCourse();
    updateMainMenu();
    showCustomComplete();
    return;
  }

  shuffle(remaining);
  const batchIds = remaining.slice(0, 10);
  const words    = [];
  for (const id of batchIds) { const w = await getWord(id); if (w) words.push(w); }

  customCourse.currentBatch = words.map(w => w.id);
  customCourse.batchIdx     = 0;
  await saveCustomCourse();

  hideLoading();
  beginSession('custom', words);
}

// ---- カスタムコース再開 ----
async function resumeCustomCourse() {
  if (!customCourse) return;
  showLoading('カスタムコース再開中', '前回の続きを読み込んでいます...');

  const remainingIds = customCourse.currentBatch.slice(customCourse.batchIdx);
  const words = [];
  for (const id of remainingIds) { const w = await getWord(id); if (w) words.push(w); }

  if (!words.length) {
    hideLoading();
    await startNextCustomBatch();
    return;
  }
  hideLoading();
  beginSession('custom', words, true);
}

// ---- カスタムコース完了画面 ----
function showCustomComplete() {
  showScreen('result');
  document.getElementById('result-header').innerHTML =
    `<div class="congrats-text">🎉 Complete!</div>
     <div class="result-subtitle">カスタムコース全問クリア！おめでとう！</div>`;
  document.getElementById('result-wrong-section').style.display  = 'none';
  document.getElementById('result-correct-list').innerHTML        = '';
  document.getElementById('btn-retry').style.display              = 'none';
  document.getElementById('btn-next').style.display               = 'none';
  document.getElementById('btn-complete').style.display           = '';
  document.getElementById('btn-home-result').style.display        = 'none';
}

// ---- クイック/復習セッション再開 ----
async function resumeSession() {
  if (!currentSession) return;
  showLoading('セッション再開中', '前回の続きを読み込んでいます...');
  const sliced = currentSession.queue.slice(currentSession.currentIdx);
  const words  = [];
  for (const id of sliced) { const w = await getWord(id); if (w) words.push(w); }
  if (!words.length) {
    await clearCurrentSession(); hideLoading();
    showToast('セッションが終了しています'); updateMainMenu(); return;
  }
  beginSession(currentSession.mode, words, true);
  hideLoading();
}

// ---- 復習 ----
async function startReview() {
  showLoading('復習準備中', '対象の単語を確認しています...');
  const ids = getReviewWordIds();
  if (!ids.length) { hideLoading(); showToast('復習する問題がありません'); return; }
  shuffle(ids);
  const words = [];
  for (const id of ids.slice(0, 10)) { const w = await getWord(id); if (w) words.push(w); }
  currentSession = { active:true, mode:'review', queue:words.map(w=>w.id), currentIdx:0, date:todayStr() };
  await saveCurrentSession();
  beginSession('review', words);
  hideLoading();
}

async function startReviewFromList() {
  const ids = Object.keys(missedWords).map(Number);
  if (!ids.length) { showToast('間違えた単語がありません'); return; }
  showLoading('リスト復習準備中', '間違えた単語を読み込んでいます...');
  shuffle(ids);
  const words = [];
  for (const id of ids.slice(0, 10)) { const w = await getWord(id); if (w) words.push(w); }
  currentSession = { active:true, mode:'review', queue:words.map(w=>w.id), currentIdx:0, date:todayStr() };
  await saveCurrentSession();
  beginSession('review', words);
  hideLoading();
}

// ---- セッション共通開始 ----
function beginSession(mode, words, resumed = false) {
  studyMode      = mode;
  studyQueue     = words;
  studyIdx       = 0;
  sessionResults = { correct: [], wrong: [] };
  showScreen('study');
  renderWord();
}

// ---- 問題描画 ----
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
  input.value = ''; input.className = 'answer-input'; input.disabled = false;

  document.getElementById('reveal-area').classList.remove('visible');
  document.getElementById('action-buttons').classList.remove('visible');
  document.getElementById('wrong-overlay').classList.remove('visible', 'fading');
  document.getElementById('feedback-overlay').innerHTML = '';

  setTimeout(updateStudyScroll, 50);
  if (settings.autoPlay && 'speechSynthesis' in window) pronounceWord(currentWord.word);
  input.focus();
}

// ---- 答え処理 ----
function handleAnswer() {
  if (isShowingWrong || waitingForAction) return;
  const input    = document.getElementById('answer-input');
  const inputVal = input.value.trim();
  if (!inputVal) {
    input.disabled = true; showReveal(inputVal, true); return;
  }
  if (checkAnswer(inputVal, currentWord.meaning)) {
    input.className = 'answer-input correct'; input.disabled = true;
    showFeedback('perfect');
    setTimeout(markCorrect, 400);
  } else {
    input.className = 'answer-input wrong'; input.disabled = true;
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

// ---- 正解処理（共通） ----
async function handleCorrect() {
  markSolved(currentWord.id);
  incrementDailyCount();
  sessionResults.correct.push(currentWord);

  if (studyMode === 'custom' && customCourse) {
    if (!customCourse.completedIds.includes(currentWord.id))
      customCourse.completedIds.push(currentWord.id);
    customCourse.batchIdx++;
    await saveCustomCourse();
  }
  if (studyMode === 'review') {
    reduceMissed(currentWord.id);
    await saveMissed();
  }
  await saveProgress();
}

async function markCorrect() {
  await handleCorrect();
  await nextWord();
}

async function onCorrectBtn() {
  if (!waitingForAction) return;
  waitingForAction = false;
  showFeedback('great');
  await handleCorrect();
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

  // カスタムモード: 不正解でもbatchIdx進める（completedIdsには入れない）
  if (studyMode === 'custom' && customCourse) {
    customCourse.batchIdx++;
    await saveCustomCourse();
  }

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
  // クイック/復習の進捗保存
  if (currentSession && studyMode !== 'custom') {
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
  el.className   = `feedback-text ${type}`;
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
  if (studyMode !== 'custom') await clearCurrentSession();
  showResultScreen();
}

function showResultScreen() {
  showScreen('result');
  const wrong    = sessionResults.wrong;
  const correct  = sessionResults.correct;
  const allOK    = wrong.length === 0;
  const isCustom = studyMode === 'custom';

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

  const btnRetry    = document.getElementById('btn-retry');
  const btnNext     = document.getElementById('btn-next');
  const btnComplete = document.getElementById('btn-complete');

  if (isCustom) {
    // カスタム: 間違いあり→もう一度 / 全正解→Next
    btnRetry.style.display    = allOK ? 'none' : '';
    btnComplete.style.display = 'none';
    if (allOK) {
      // 残り問題数をNextボタンに表示
      const remaining = customCourse
        ? customCourse.totalInRange - customCourse.completedIds.length
        : 0;
      btnNext.style.display   = '';
      btnNext.textContent     = remaining > 0 ? `Next → (残り${remaining}問)` : 'Next →';
    } else {
      btnNext.style.display   = 'none';
    }
  } else {
    btnRetry.style.display    = allOK ? 'none' : '';
    btnNext.style.display     = allOK ? '' : 'none';
    btnComplete.style.display = 'none';
    btnNext.textContent       = 'Next →';
  }
  document.getElementById('btn-home-result').style.display = '';
}

function makeWordRow(w, cls) {
  const row = document.createElement('div');
  row.className = `word-row ${cls}`;
  const posHtml = w.pos ? `<span class="word-row-pos">${esc(w.pos)}</span>` : '';
  row.innerHTML = `
    <span class="word-row-en">${esc(w.word)}${posHtml}</span>
    <span class="word-row-ja">${esc(w.meaning)}</span>`;
  return row;
}

function retrySession() {
  // 間違えた問題を同じモードで解き直す
  beginSession(studyMode, shuffle([...sessionResults.wrong]));
}

async function nextSession() {
  if (studyMode === 'custom') {
    // カスタムコース: 次のバッチへ
    await startNextCustomBatch();
  } else {
    updateMainMenu();
    showScreen('main');
  }
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
  showLoading('ログイン中...');
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
  showLoading('アカウント作成中...');
  try { await auth.createUserWithEmailAndPassword(email, pass); }
  catch (e) { hideLoading(); err.textContent = getAuthError(e.code); }
}
async function loginGoogle() {
  showLoading('Googleでログイン中...');
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (e) { hideLoading(); document.getElementById('login-error').textContent = getAuthError(e.code); }
}
function logout() {
  auth.signOut().then(() => {
    solvedSet = new Set(); dailyCount = 0; missedWords = {};
    currentSession = null; customCourse = null;
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
  document.getElementById('login-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') loginEmail();
  });

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const s = el.dataset.screen;
      if (s) { showScreen(s); if (s==='main') updateMainMenu(); if (s==='data') updateDataScreen(); }
    });
  });

  // Main buttons
  document.getElementById('btn-quick').addEventListener('click',  startQuick);
  document.getElementById('btn-review').addEventListener('click', startReview);

  // クイック/復習セッション再開
  document.getElementById('btn-resume').addEventListener('click', resumeSession);
  document.getElementById('btn-resume-dismiss').addEventListener('click', async e => {
    e.stopPropagation();
    await clearCurrentSession();
    updateMainMenu();
    showToast('セッションを破棄しました');
  });

  // カスタム設定パネル
  document.getElementById('btn-custom-toggle').addEventListener('click', () => {
    const panel   = document.getElementById('custom-panel');
    const chevron = document.querySelector('.custom-chevron');
    const open    = panel.classList.toggle('open');
    chevron.classList.toggle('open', open);
  });
  document.getElementById('btn-custom-start').addEventListener('click', startCustomCourse);

  // カスタムコース進行ボタン（アクティブ時）
  document.getElementById('btn-custom-course').addEventListener('click', resumeCustomCourse);

  // Data
  document.getElementById('btn-review-from-list').addEventListener('click', startReviewFromList);

  // Study
  document.getElementById('answer-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAnswer();
  });
  document.getElementById('btn-correct').addEventListener('click',   onCorrectBtn);
  document.getElementById('btn-wrong').addEventListener('click',     onWrongBtn);
  document.getElementById('wrong-overlay').addEventListener('click', dismissWrong);
  document.getElementById('btn-exit-study').addEventListener('click', () => {
    showScreen('main'); updateMainMenu();
  });
  document.getElementById('btn-pronounce').addEventListener('click', () => {
    if (currentWord) pronounceWord(currentWord.word);
  });

  // Result
  document.getElementById('btn-retry').addEventListener('click',    retrySession);
  document.getElementById('btn-next').addEventListener('click',     nextSession);
  document.getElementById('btn-complete').addEventListener('click', () => {
    updateMainMenu(); showScreen('main');
  });
  document.getElementById('btn-home-result').addEventListener('click', () => {
    updateMainMenu(); showScreen('main');
  });

  // Settings
  document.getElementById('setting-daily').addEventListener('change', e => onDailyGoalChange(e.target.value));
  document.getElementById('setting-autoplay').addEventListener('change', e => onAutoPlayChange(e.target.checked));
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Resize
  window.addEventListener('resize', updateStudyScroll);

  // 離脱時の保険保存
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentUser) {
      saveCurrentSession(); saveProgress(); saveCustomCourse();
    }
  });
  window.addEventListener('pagehide', () => {
    if (currentUser) { saveCurrentSession(); saveProgress(); saveCustomCourse(); }
  });
});
