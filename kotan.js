"use strict";

const CHUNK_SIZE = 25;
const DATA_FILE = "kotan2.json";

const elements = {
  rangeScreen: document.querySelector("#rangeScreen"),
  studyScreen: document.querySelector("#studyScreen"),
  rangeList: document.querySelector("#rangeList"),
  rangeStatus: document.querySelector("#rangeStatus"),
  studyLabel: document.querySelector("#studyLabel"),
  studyTitle: document.querySelector("#studyTitle"),
  wordList: document.querySelector("#wordList"),
  backButton: document.querySelector("#backButton"),
  shuffleButton: document.querySelector("#shuffleButton"),
  toggleAllButton: document.querySelector("#toggleAllButton")
};

const state = {
  words: [],
  ranges: [],
  currentRange: null,
  visibleIds: new Set(),
  loadSource: ""
};

document.addEventListener("DOMContentLoaded", init);
elements.backButton.addEventListener("click", showRangeScreen);
elements.shuffleButton.addEventListener("click", shuffleCurrentRange);
elements.toggleAllButton.addEventListener("click", toggleAllMeanings);

async function init() {
  setStatus("読み込み中です。");

  try {
    const { words, file } = await loadWords();
    state.words = words;
    state.loadSource = file;
    state.ranges = makeRanges(words);
    renderRanges();
    setStatus("");
  } catch (error) {
    console.error(error);
    setStatus("単語データを読み込めませんでした。kotan2.json を同じフォルダに置いてください。", true);
  }
}

async function loadWords() {
  const response = await fetch(encodeURI(DATA_FILE), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${DATA_FILE}: ${response.status}`);
  }

  const data = await response.json();
  const words = normalizeWords(data);

  if (!words.length) {
    throw new Error(`${DATA_FILE}: 単語がありません`);
  }

  return { words, file: DATA_FILE };
}

function normalizeWords(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((item, index) => {
      const word = readText(item.word ?? item.term ?? item.name);
      const type = readText(item.katuyou ?? item.type ?? item.part);
      const meanings = readMeanings(item.mean ?? item.meaning ?? item.answer);

      return {
        id: `${index}-${word}`,
        number: index + 1,
        word,
        type,
        meanings
      };
    })
    .filter((item) => item.word && item.meanings.length);
}

function readText(value) {
  if (value == null) {
    return "";
  }

  return String(value).trim();
}

function readMeanings(value) {
  if (Array.isArray(value)) {
    return value.map(readText).filter(Boolean);
  }

  const meaning = readText(value);
  return meaning ? [meaning] : [];
}

function makeRanges(words) {
  const ranges = [];

  for (let start = 0; start < words.length; start += CHUNK_SIZE) {
    const rangeWords = words.slice(start, start + CHUNK_SIZE);
    ranges.push({
      index: ranges.length + 1,
      start,
      end: start + rangeWords.length - 1,
      words: rangeWords
    });
  }

  return ranges;
}

function renderRanges() {
  elements.rangeList.innerHTML = "";

  state.ranges.forEach((range) => {
    const button = document.createElement("button");
    const firstWords = range.words.slice(0, 3).map((item) => item.word).join("、");
    button.className = "range-card";
    button.type = "button";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(rangeLabel(range))}</strong>
        <small>${escapeHtml(firstWords)}</small>
      </span>
      <span class="arrow" aria-hidden="true">›</span>
    `;
    button.addEventListener("click", () => openRange(range.index));
    elements.rangeList.append(button);
  });
}

function openRange(rangeIndex) {
  const range = state.ranges.find((item) => item.index === rangeIndex);
  if (!range) {
    return;
  }

  state.currentRange = {
    ...range,
    words: shuffle(range.words)
  };
  state.visibleIds.clear();

  elements.studyLabel.textContent = `${range.words.length}語`;
  elements.studyTitle.textContent = rangeLabel(range);
  showStudyScreen();
  renderWords();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function renderWords() {
  elements.wordList.innerHTML = "";

  state.currentRange.words.forEach((item) => {
    const row = document.createElement("article");
    const meaningButtons = item.meanings.map((meaning, meaningIndex) => {
      const id = meaningId(item, meaningIndex);
      const isVisible = state.visibleIds.has(id);

      return `
        <button class="meaning-button ${isVisible ? "" : "is-hidden"}" type="button" aria-expanded="${isVisible}">
          <span class="meaning-text">${escapeHtml(meaning)}</span>
          <span class="hidden-mark" aria-hidden="true">•••</span>
        </button>
      `;
    }).join("");

    row.className = "word-row";
    row.innerHTML = `
      <div class="word-side">
        <span class="word">${escapeHtml(item.word)}</span>
        ${item.type ? `<span class="type">${escapeHtml(item.type)}</span>` : ""}
      </div>
      <div class="meaning-list">${meaningButtons}</div>
    `;

    row.querySelectorAll(".meaning-button").forEach((button, meaningIndex) => {
      button.addEventListener("click", () => toggleMeaning(meaningId(item, meaningIndex)));
    });
    elements.wordList.append(row);
  });

  updateToggleAllButton();
}

function toggleMeaning(id) {
  if (state.visibleIds.has(id)) {
    state.visibleIds.delete(id);
  } else {
    state.visibleIds.add(id);
  }

  renderWords();
}

function toggleAllMeanings() {
  if (!state.currentRange) {
    return;
  }

  if (allMeaningsHidden()) {
    state.currentRange.words.forEach((item) => {
      item.meanings.forEach((meaning, meaningIndex) => {
        state.visibleIds.add(meaningId(item, meaningIndex));
      });
    });
  } else {
    state.visibleIds.clear();
  }

  renderWords();
}

function shuffleCurrentRange() {
  if (!state.currentRange) {
    return;
  }

  state.currentRange.words = shuffle(state.currentRange.words);
  renderWords();
}

function allMeaningsHidden() {
  return !state.currentRange || state.currentRange.words.every((item) => {
    return item.meanings.every((meaning, meaningIndex) => !state.visibleIds.has(meaningId(item, meaningIndex)));
  });
}

function updateToggleAllButton() {
  elements.toggleAllButton.textContent = allMeaningsHidden() ? "すべて見る" : "すべて隠す";
}

function showRangeScreen() {
  elements.studyScreen.hidden = true;
  elements.rangeScreen.hidden = false;
  state.currentRange = null;
  state.visibleIds.clear();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showStudyScreen() {
  elements.rangeScreen.hidden = true;
  elements.studyScreen.hidden = false;
}

function rangeLabel(range) {
  return `第${range.index}範囲 ${range.start + 1}-${range.end + 1}`;
}

function meaningId(item, meaningIndex) {
  return `${item.id}-meaning-${meaningIndex}`;
}

function shuffle(items) {
  const copied = [...items];

  for (let index = copied.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copied[index], copied[target]] = [copied[target], copied[index]];
  }

  return copied;
}

function setStatus(message, isError = false) {
  elements.rangeStatus.textContent = message;
  elements.rangeStatus.classList.toggle("is-error", isError);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };

    return replacements[character];
  });
}
