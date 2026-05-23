"use strict";

const CHUNK_SIZE = 40;
const DEFAULT_BLOCK_SIZE = 800;
const NEXT_DELAY_MS = 500;
const DATA_DIR = "";
const VOICE_NAME_PRIORITY = [
  "Google US English",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Microsoft Guy",
  "Samantha",
  "Alex",
  "Daniel",
  "Karen"
];

const app = document.querySelector("#app");
const screens = {
  files: document.querySelector("#fileScreen"),
  ranges: document.querySelector("#rangeScreen"),
  quiz: document.querySelector("#quizScreen"),
  result: document.querySelector("#resultScreen")
};

const elements = {
  fileList: document.querySelector("#fileList"),
  fileStatus: document.querySelector("#fileStatus"),
  selectedFileLabel: document.querySelector("#selectedFileLabel"),
  rangeList: document.querySelector("#rangeList"),
  rangeStatus: document.querySelector("#rangeStatus"),
  backToFiles: document.querySelector("#backToFiles"),
  backToRanges: document.querySelector("#backToRanges"),
  rangeLabel: document.querySelector("#rangeLabel"),
  progressText: document.querySelector("#progressText"),
  wordText: document.querySelector("#wordText"),
  speakButton: document.querySelector("#speakButton"),
  choiceList: document.querySelector("#choiceList"),
  mistakeCount: document.querySelector("#mistakeCount"),
  liveMistakeList: document.querySelector("#liveMistakeList"),
  resultTitle: document.querySelector("#resultTitle"),
  resultScore: document.querySelector("#resultScore"),
  resultMistakeList: document.querySelector("#resultMistakeList"),
  jsonExportBox: document.querySelector("#jsonExportBox"),
  mistakeJsonText: document.querySelector("#mistakeJsonText"),
  copyJsonButton: document.querySelector("#copyJsonButton"),
  copyStatus: document.querySelector("#copyStatus"),
  resultActions: document.querySelector("#resultActions")
};

const state = {
  manifest: [],
  selectedEntry: null,
  fileWords: [],
  quizWords: [],
  currentIndex: 0,
  correctCount: 0,
  mistakes: [],
  currentRangeLabel: "",
  resultTimer: null,
  isAnswering: false
};

const voiceState = {
  englishVoice: null
};

document.addEventListener("DOMContentLoaded", init);
elements.backToFiles.addEventListener("click", showFileScreen);
elements.backToRanges.addEventListener("click", showRangeScreen);
elements.speakButton.addEventListener("click", () => {
  const current = state.quizWords[state.currentIndex];
  if (current) speak(current.word);
});
elements.copyJsonButton.addEventListener("click", copyMistakeJson);

async function init() {
  prepareVoices();
  setStatus(elements.fileStatus, "読み込み中です。");
  try {
    state.manifest = await loadManifest();
    renderFileButtons();
    setStatus(elements.fileStatus, "");
  } catch (error) {
    console.error(error);
    setStatus(elements.fileStatus, "manifest.json を読み込めませんでした。", true);
  }
}

async function loadManifest() {
  const response = await fetch(`${DATA_DIR}manifest.json`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`manifest.json: ${response.status}`);
  }

  const rawManifest = await response.json();
  if (!Array.isArray(rawManifest)) {
    throw new Error("manifest.json must be an array.");
  }

  return rawManifest.map((item, index) => normalizeManifestEntry(item, index));
}

function normalizeManifestEntry(item, index) {
  const entry = typeof item === "string" ? { file: item } : { ...item };
  if (!entry.file) {
    throw new Error(`manifest item ${index + 1} has no file.`);
  }

  const file = String(entry.file);
  const label = entry.label || file.replace(/\.json$/i, "");
  const startNumber = Number(entry.startNumber || entry.start || inferStartNumber(file, index));

  return {
    file,
    label,
    startNumber: Number.isFinite(startNumber) ? startNumber : index * DEFAULT_BLOCK_SIZE + 1
  };
}

function inferStartNumber(file, index) {
  const match = file.match(/word\s*(\d+)\.json$/i) || file.match(/(\d+)\.json$/);
  if (!match) return index * DEFAULT_BLOCK_SIZE + 1;
  return (Number(match[1]) - 1) * DEFAULT_BLOCK_SIZE + 1;
}

function renderFileButtons() {
  elements.fileList.innerHTML = "";

  state.manifest.forEach((entry) => {
    const button = document.createElement("button");
    button.className = "select-button";
    button.type = "button";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(entry.label)}</strong>
        <small>${escapeHtml(entry.file)} / ${entry.startNumber}番から</small>
      </span>
      <span class="arrow" aria-hidden="true">›</span>
    `;
    button.addEventListener("click", () => selectFile(entry));
    elements.fileList.append(button);
  });
}

async function selectFile(entry) {
  state.selectedEntry = entry;
  state.fileWords = [];
  state.quizWords = [];
  state.mistakes = [];
  clearResultTimer();
  setStatus(elements.rangeStatus, "読み込み中です。");
  showScreen("ranges");

  try {
    const response = await fetch(`${DATA_DIR}${entry.file}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${entry.file}: ${response.status}`);
    }

    const text = await response.text();
    state.fileWords = normalizeWordList(parseWordText(text), entry.startNumber);
    elements.selectedFileLabel.textContent = entry.label;
    renderRangeButtons();
    setStatus(elements.rangeStatus, `${state.fileWords.length}語`);
  } catch (error) {
    console.error(error);
    elements.rangeList.innerHTML = "";
    setStatus(elements.rangeStatus, `${entry.file} を読み込めませんでした。`, true);
  }
}

function parseWordText(text) {
  const source = text.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(source);
  } catch (error) {
    const jsonLike = source
      .replace(/([{,]\s*)(word|meaning)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(jsonLike);
  }
}

function normalizeWordList(raw, startNumber) {
  const list = Array.isArray(raw) ? raw : raw.words;
  if (!Array.isArray(list)) {
    throw new Error("word data must be an array.");
  }

  return list
    .map((item, index) => ({
      word: String(item.word || "").trim(),
      meaning: String(item.meaning || "").trim(),
      number: startNumber + index
    }))
    .filter((item) => item.word && item.meaning);
}

function renderRangeButtons() {
  elements.rangeList.innerHTML = "";

  if (state.fileWords.length === 0) {
    setStatus(elements.rangeStatus, "単語がありません。", true);
    return;
  }

  for (let startIndex = 0; startIndex < state.fileWords.length; startIndex += CHUNK_SIZE) {
    const endIndex = Math.min(startIndex + CHUNK_SIZE, state.fileWords.length) - 1;
    const startNumber = state.fileWords[startIndex].number;
    const endNumber = state.fileWords[endIndex].number;
    const count = endIndex - startIndex + 1;
    const label = `${startNumber}〜${endNumber}`;

    const button = document.createElement("button");
    button.className = "select-button";
    button.type = "button";
    button.innerHTML = `
      <span>
        <strong>${label}</strong>
        <small>${count}語</small>
      </span>
      <span class="arrow" aria-hidden="true">›</span>
    `;
    button.addEventListener("click", () => startQuiz(state.fileWords.slice(startIndex, endIndex + 1), label));
    elements.rangeList.append(button);
  }
}

function startQuiz(words, label) {
  clearResultTimer();
  state.quizWords = shuffle(words);
  state.currentIndex = 0;
  state.correctCount = 0;
  state.mistakes = [];
  state.currentRangeLabel = label;
  state.isAnswering = false;
  renderLiveMistakes();
  showScreen("quiz");
  showQuestion();
}

function retryMistakes() {
  const retryWords = [...state.mistakes];
  startQuiz(retryWords, "間違えた単語");
}

function showQuestion() {
  resetFeedback();
  state.isAnswering = false;

  const current = state.quizWords[state.currentIndex];
  if (!current) {
    showResult();
    return;
  }

  elements.rangeLabel.textContent = state.currentRangeLabel;
  elements.progressText.textContent = `${state.currentIndex + 1} / ${state.quizWords.length}`;
  elements.wordText.textContent = current.word;
  renderChoices(current);

  window.setTimeout(() => speak(current.word), 120);
}

function renderChoices(current) {
  elements.choiceList.innerHTML = "";
  const meanings = buildChoices(current).map((meaning) => ({
    meaning,
    isCorrect: meaning === current.meaning
  }));

  meanings.forEach((choice) => {
    const button = document.createElement("button");
    button.className = "choice-button";
    button.type = "button";
    button.textContent = choice.meaning;
    button.dataset.correct = String(choice.isCorrect);
    button.addEventListener("click", () => answer(choice.meaning, current, button));
    elements.choiceList.append(button);
  });
}

function buildChoices(current) {
  const pool = uniqueMeanings([...state.quizWords, ...state.fileWords])
    .filter((meaning) => meaning !== current.meaning);
  const distractors = shuffle(pool).slice(0, 3);
  return shuffle([current.meaning, ...distractors]);
}

function uniqueMeanings(words) {
  return [...new Set(words.map((item) => item.meaning).filter(Boolean))];
}

function answer(selectedMeaning, current, selectedButton) {
  if (state.isAnswering) return;
  state.isAnswering = true;

  const isCorrect = selectedMeaning === current.meaning;
  const buttons = [...elements.choiceList.querySelectorAll(".choice-button")];
  buttons.forEach((button) => {
    button.disabled = true;
    if (button.dataset.correct === "true") button.classList.add("is-correct");
  });

  if (isCorrect) {
    selectedButton.classList.add("is-correct");
    app.classList.add("feedback-good");
    state.correctCount += 1;
  } else {
    selectedButton.classList.add("is-wrong");
    app.classList.add("feedback-bad");
    state.mistakes.push(current);
    renderLiveMistakes();
  }

  window.setTimeout(() => {
    state.currentIndex += 1;
    showQuestion();
  }, NEXT_DELAY_MS);
}

function renderLiveMistakes() {
  elements.mistakeCount.textContent = String(state.mistakes.length);
  renderMistakeList(elements.liveMistakeList, state.mistakes, "まだありません。");
}

function renderMistakeList(container, mistakes, emptyText) {
  container.innerHTML = "";

  if (mistakes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  mistakes.forEach((item) => {
    const row = document.createElement("div");
    row.className = "mistake-item";
    row.innerHTML = `
      <strong>${item.number}. ${escapeHtml(item.word)}</strong>
      <span>${escapeHtml(item.meaning)}</span>
    `;
    container.append(row);
  });
}

function showResult() {
  resetFeedback();
  showScreen("result");
  hideMistakeJson();

  const total = state.quizWords.length;
  const missed = state.mistakes.length;
  const correct = total - missed;

  elements.resultActions.innerHTML = "";
  renderMistakeList(elements.resultMistakeList, state.mistakes, "間違いはありません。");

  if (missed === 0) {
    elements.resultTitle.textContent = "全問正解です";
    elements.resultScore.textContent = `${total}問中 ${correct}問正解。最初の画面に戻ります。`;
    const homeButton = makeButton("最初の画面へ", "primary-button", showFileScreen);
    elements.resultActions.append(homeButton);
    state.resultTimer = window.setTimeout(showFileScreen, 1600);
    return;
  }

  elements.resultTitle.textContent = "結果";
  elements.resultScore.textContent = `${total}問中 ${correct}問正解。間違えた ${missed}問をもう一度できます。`;
  elements.resultActions.append(
    makeButton("間違えた問題だけもう一度", "primary-button", retryMistakes),
    makeButton("間違えた単語をJSONで表示", "secondary-button", showMistakeJson),
    makeButton("範囲選択に戻る", "secondary-button", showRangeScreen),
    makeButton("最初の画面へ", "secondary-button", showFileScreen)
  );
}

function showMistakeJson() {
  const jsonText = formatMistakesAsJson(state.mistakes);
  elements.mistakeJsonText.value = jsonText;
  elements.copyStatus.textContent = "";
  elements.jsonExportBox.hidden = false;
  elements.jsonExportBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideMistakeJson() {
  elements.jsonExportBox.hidden = true;
  elements.mistakeJsonText.value = "";
  elements.copyStatus.textContent = "";
}

function formatMistakesAsJson(mistakes) {
  const rows = mistakes.map((item) => {
    const word = JSON.stringify(item.word);
    const meaning = JSON.stringify(item.meaning);
    return `  { "word": ${word}, "meaning": ${meaning} }`;
  });

  return `[\n${rows.join(",\n")}\n]`;
}

async function copyMistakeJson() {
  const text = elements.mistakeJsonText.value;
  if (!text) return;

  selectMistakeJsonText();

  try {
    if (!navigator.clipboard) throw new Error("Clipboard API is not available.");
    await navigator.clipboard.writeText(text);
    setCopyStatus("コピーしました。");
  } catch (error) {
    const copied = document.execCommand("copy");
    setCopyStatus(copied ? "コピーしました。" : "テキストを選択しました。長押しでコピーできます。", !copied);
  }
}

function selectMistakeJsonText() {
  elements.mistakeJsonText.focus({ preventScroll: true });
  elements.mistakeJsonText.select();
  elements.mistakeJsonText.setSelectionRange(0, elements.mistakeJsonText.value.length);
}

function setCopyStatus(text, isError = false) {
  elements.copyStatus.textContent = text;
  elements.copyStatus.classList.toggle("is-error", isError);
}

function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function showFileScreen() {
  clearResultTimer();
  hideMistakeJson();
  stopSpeech();
  resetFeedback();
  showScreen("files");
}

function showRangeScreen() {
  clearResultTimer();
  hideMistakeJson();
  stopSpeech();
  resetFeedback();
  showScreen("ranges");
}

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("is-active"));
  screens[name].classList.add("is-active");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function resetFeedback() {
  app.classList.remove("feedback-good", "feedback-bad");
}

function clearResultTimer() {
  if (state.resultTimer) {
    window.clearTimeout(state.resultTimer);
    state.resultTimer = null;
  }
}

function setStatus(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("is-error", isError);
}

function speak(word) {
  if (!("speechSynthesis" in window) || !word) return;

  refreshEnglishVoice();
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(word);
  if (voiceState.englishVoice) {
    utterance.voice = voiceState.englishVoice;
    utterance.lang = voiceState.englishVoice.lang || "en-US";
  } else {
    utterance.lang = "en-US";
  }
  utterance.rate = 0.88;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function prepareVoices() {
  if (!("speechSynthesis" in window)) return;

  refreshEnglishVoice();
  if (typeof window.speechSynthesis.addEventListener === "function") {
    window.speechSynthesis.addEventListener("voiceschanged", refreshEnglishVoice);
  } else {
    window.speechSynthesis.onvoiceschanged = refreshEnglishVoice;
  }
}

function refreshEnglishVoice() {
  const voices = window.speechSynthesis.getVoices();
  voiceState.englishVoice = chooseEnglishVoice(voices);
}

function chooseEnglishVoice(voices) {
  const englishVoices = voices.filter((voice) => {
    const lang = String(voice.lang || "").toLowerCase();
    const name = String(voice.name || "").toLowerCase();
    return lang.startsWith("en") || name.includes("english");
  });

  if (englishVoices.length === 0) return null;

  return englishVoices
    .map((voice) => ({ voice, score: scoreEnglishVoice(voice) }))
    .sort((left, right) => right.score - left.score)[0].voice;
}

function scoreEnglishVoice(voice) {
  const name = String(voice.name || "").toLowerCase();
  const lang = String(voice.lang || "").toLowerCase();
  let score = 0;

  if (lang === "en-us") score += 80;
  else if (lang.startsWith("en-us")) score += 70;
  else if (lang === "en-gb") score += 58;
  else if (lang.startsWith("en")) score += 45;

  if (name.includes("natural") || name.includes("neural")) score += 50;
  if (name.includes("premium") || name.includes("enhanced")) score += 30;
  if (name.includes("google")) score += 24;
  if (name.includes("microsoft")) score += 18;
  if (voice.localService) score += 8;

  VOICE_NAME_PRIORITY.forEach((preferredName, index) => {
    if (name.includes(preferredName.toLowerCase())) {
      score += 120 - index * 8;
    }
  });

  return score;
}

function stopSpeech() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
