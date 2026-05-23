"use strict";

const CHUNK_SIZE = 40;
const DEFAULT_WORD_BLOCK = 800;
const MANIFEST_FILE = "manifest.json";
const FALLBACK_FILES = [
  { file: "word1.json", label: "word1", startNumber: 1 },
  { file: "word2.json", label: "word2", startNumber: 801 }
];
const PART_LABELS = {
  verb: "動詞",
  adjective: "形容詞",
  noun: "名詞",
  adverb: "副詞",
  preposition: "前置詞"
};
const POS_OVERRIDES = new Map(
  Object.entries({
    sense: ["noun"],
    sweat: ["noun", "verb"],
    gender: ["noun"],
    nationality: ["noun"],
    ordinary: ["adjective"],
    possible: ["adjective"],
    purpose: ["noun"],
    improve: ["verb"],
    provide: ["verb"],
    increase: ["verb", "noun"],
    reduce: ["verb"],
    prefer: ["verb"],
    analyze: ["verb"],
    benefit: ["noun", "verb"],
    culture: ["noun"],
    demand: ["noun", "verb"],
    evidence: ["noun"],
    feature: ["noun", "verb"],
    global: ["adjective"],
    impact: ["noun", "verb"],
    journal: ["noun"],
    knowledge: ["noun"],
    maintain: ["verb"],
    notice: ["verb", "noun"],
    "deserve o": ["verb"],
    enormous: ["adjective"],
    accidental: ["adjective"],
    previous: ["adjective"],
    former: ["adjective"],
    "supply a with b": ["verb"],
    "substitute a for b": ["verb"],
    reception: ["noun"],
    "occupy o": ["verb"],
    tragedy: ["noun"],
    "register o": ["verb"],
    "divorce o": ["verb"],
    grocery: ["noun"],
    ingredient: ["noun"],
    district: ["noun"],
    literature: ["noun"],
    "fascinate o": ["verb"],
    literally: ["adverb"],
    "absorb o": ["verb"],
    "hesitate to v": ["verb"],
    "indicate o": ["verb"],
    "advertise o": ["verb"],
    "amaze o": ["verb"],
    "be reluctant to v": ["adjective"],
    "clarify o": ["verb"],
    shame: ["noun"],
    otherwise: ["adverb"],
    eventually: ["adverb"],
    necessarily: ["adverb"],
    moderate: ["adjective"],
    subtle: ["adjective"],
    medium: ["noun"],
    means: ["noun"],
    "envy o": ["verb"],
    boast: ["verb", "noun"],
    "despite x": ["preposition"],
    possibly: ["adverb"],
    extent: ["noun"],
    compliment: ["noun", "verb"],
    strain: ["noun", "verb"],
    orbit: ["noun", "verb"],
    "imply o": ["verb"],
    desperate: ["adjective"],
    attempt: ["noun", "verb"],
    "attain o": ["verb"],
    remedy: ["noun", "verb"],
    substance: ["noun"],
    radiation: ["noun"],
    "declare o": ["verb"],
    "dedicate a to b": ["verb"],
    "dismiss o": ["verb"]
  })
);
const COMMON_PREPOSITIONS = new Set([
  "about",
  "above",
  "across",
  "after",
  "against",
  "along",
  "among",
  "around",
  "at",
  "before",
  "behind",
  "below",
  "beside",
  "between",
  "by",
  "despite",
  "during",
  "for",
  "from",
  "in",
  "into",
  "near",
  "of",
  "off",
  "on",
  "over",
  "through",
  "to",
  "under",
  "with",
  "without"
]);
const COMMON_VERBS = new Set([
  "absorb",
  "advertise",
  "amaze",
  "analyze",
  "attain",
  "clarify",
  "declare",
  "dedicate",
  "deserve",
  "dismiss",
  "divorce",
  "envy",
  "fascinate",
  "hesitate",
  "imply",
  "improve",
  "indicate",
  "maintain",
  "occupy",
  "prefer",
  "provide",
  "reduce",
  "register",
  "substitute",
  "supply"
]);

const screens = {
  files: document.querySelector("#fileScreen"),
  ranges: document.querySelector("#rangeScreen"),
  board: document.querySelector("#boardScreen")
};

const elements = {
  fileList: document.querySelector("#fileList"),
  fileStatus: document.querySelector("#fileStatus"),
  selectedFileLabel: document.querySelector("#selectedFileLabel"),
  rangeList: document.querySelector("#rangeList"),
  rangeStatus: document.querySelector("#rangeStatus"),
  boardSourceLabel: document.querySelector("#boardSourceLabel"),
  boardTitle: document.querySelector("#boardTitle"),
  wordCount: document.querySelector("#wordCount"),
  wordList: document.querySelector("#wordList"),
  backToFiles: document.querySelector("#backToFiles"),
  backToRanges: document.querySelector("#backToRanges"),
  reshuffleButton: document.querySelector("#reshuffleButton"),
  hideAllButton: document.querySelector("#hideAllButton")
};

const state = {
  manifest: [],
  selectedEntry: null,
  fileWords: [],
  currentRange: null,
  boardWords: []
};

document.addEventListener("DOMContentLoaded", init);
elements.backToFiles.addEventListener("click", showFileScreen);
elements.backToRanges.addEventListener("click", showRangeScreen);
elements.reshuffleButton.addEventListener("click", reshuffleCurrentRange);
elements.hideAllButton.addEventListener("click", hideAllMeanings);

async function init() {
  showScreen("files");
  setStatus(elements.fileStatus, "読み込み中です。");

  try {
    state.manifest = await loadManifest();
    renderFileButtons();
    setStatus(elements.fileStatus, "");
  } catch (error) {
    console.error(error);
    state.manifest = FALLBACK_FILES;
    renderFileButtons();
    setStatus(elements.fileStatus, "manifest.jsonを読めないため、基本ファイルを表示しています。", true);
  }
}

async function loadManifest() {
  const response = await fetch(MANIFEST_FILE, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${MANIFEST_FILE}: ${response.status}`);
  }

  const manifest = await response.json();
  if (!Array.isArray(manifest)) {
    throw new Error("manifest.json must be an array.");
  }

  const entries = manifest
    .map(normalizeManifestEntry)
    .filter((entry) => entry.file && entry.file.toLowerCase() !== MANIFEST_FILE);

  if (entries.length === 0) {
    throw new Error("No word files found.");
  }

  return entries;
}

function normalizeManifestEntry(item, index) {
  const raw = typeof item === "string" ? { file: item } : { ...item };
  const file = String(raw.file || "").trim();
  const label = String(raw.label || file.replace(/\.json$/i, "")).trim() || file;
  const explicitStart = Number(raw.startNumber);
  const startNumber = Number.isFinite(explicitStart) ? explicitStart : inferStartNumber(file, index);

  return { file, label, startNumber };
}

function inferStartNumber(file, index) {
  const wordMatch = file.match(/^word(\d+)\.json$/i);
  if (wordMatch) {
    return (Number(wordMatch[1]) - 1) * DEFAULT_WORD_BLOCK + 1;
  }

  return index * DEFAULT_WORD_BLOCK + 1;
}

function renderFileButtons() {
  elements.fileList.replaceChildren();

  state.manifest.forEach((entry) => {
    const button = document.createElement("button");
    button.className = "select-button";
    button.type = "button";

    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = entry.label;
    const meta = document.createElement("small");
    meta.textContent = `${entry.file} / ${entry.startNumber}番から`;
    text.append(title, meta);

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";

    button.append(text, arrow);
    button.addEventListener("click", () => selectFile(entry));
    elements.fileList.append(button);
  });
}

async function selectFile(entry) {
  state.selectedEntry = entry;
  state.fileWords = [];
  state.currentRange = null;
  state.boardWords = [];
  elements.selectedFileLabel.textContent = entry.label;
  elements.rangeList.replaceChildren();
  setStatus(elements.rangeStatus, "読み込み中です。");
  showScreen("ranges");

  try {
    const response = await fetch(entry.file, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${entry.file}: ${response.status}`);
    }

    const rawWords = await response.json();
    state.fileWords = normalizeWordList(rawWords, entry.startNumber);
    renderRangeButtons();
    setStatus(elements.rangeStatus, `${state.fileWords.length}語`);
  } catch (error) {
    console.error(error);
    setStatus(elements.rangeStatus, `${entry.file}を読み込めませんでした。`, true);
  }
}

function normalizeWordList(rawWords, startNumber) {
  const list = Array.isArray(rawWords) ? rawWords : rawWords.words;
  if (!Array.isArray(list)) {
    throw new Error("Word data must be an array.");
  }

  return list
    .map((item, index) => {
      const word = readField(item, ["word", "english", "en", "term"]);
      return {
        number: startNumber + index,
        word,
        meaning: readField(item, ["meaning", "japanese", "ja", "definition"]),
        partInfo: inferPartInfo(word)
      };
    })
    .filter((item) => item.word && item.meaning);
}

function readField(item, keys) {
  for (const key of keys) {
    if (item && item[key] !== undefined && item[key] !== null) {
      return String(item[key]).trim();
    }
  }

  return "";
}

function renderRangeButtons() {
  elements.rangeList.replaceChildren();

  if (state.fileWords.length === 0) {
    setStatus(elements.rangeStatus, "単語がありません。", true);
    return;
  }

  for (let startIndex = 0; startIndex < state.fileWords.length; startIndex += CHUNK_SIZE) {
    const endIndex = Math.min(startIndex + CHUNK_SIZE, state.fileWords.length) - 1;
    const startNumber = state.fileWords[startIndex].number;
    const endNumber = state.fileWords[endIndex].number;
    const count = endIndex - startIndex + 1;

    const button = document.createElement("button");
    button.className = "select-button";
    button.type = "button";

    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = `${startNumber}〜${endNumber}`;
    const meta = document.createElement("small");
    meta.textContent = `${count}語`;
    text.append(title, meta);

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";

    button.append(text, arrow);
    button.addEventListener("click", () => openBoard(startIndex, endIndex));
    elements.rangeList.append(button);
  }
}

function openBoard(startIndex, endIndex) {
  const words = state.fileWords.slice(startIndex, endIndex + 1);
  const startNumber = words[0].number;
  const endNumber = words[words.length - 1].number;

  state.currentRange = { startIndex, endIndex, startNumber, endNumber };
  state.boardWords = shuffle(words);
  renderBoard();
  showScreen("board");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function renderBoard() {
  const range = state.currentRange;
  elements.boardSourceLabel.textContent = state.selectedEntry ? state.selectedEntry.label : "File";
  elements.boardTitle.textContent = range ? `${range.startNumber}〜${range.endNumber}` : "";
  elements.wordCount.textContent = `${state.boardWords.length}語`;
  elements.wordList.replaceChildren();

  state.boardWords.forEach((item) => {
    elements.wordList.append(createWordRow(item));
  });
}

function createWordRow(item) {
  const row = document.createElement("article");
  row.className = "word-row";

  const wordCell = document.createElement("div");
  wordCell.className = "word-cell";

  const number = document.createElement("span");
  number.className = "word-number";
  number.textContent = String(item.number);

  const word = document.createElement("span");
  word.className = "word-text";
  word.lang = "en";
  word.textContent = item.word;

  const meta = document.createElement("div");
  meta.className = "word-meta";
  if (item.partInfo.isPhrase) {
    meta.append(createChip("熟語", "phrase-chip"));
  }
  item.partInfo.labels.forEach((label) => meta.append(createChip(label)));

  wordCell.append(number, word, meta);

  const meaningButton = document.createElement("button");
  meaningButton.className = "meaning-button is-hidden";
  meaningButton.type = "button";
  meaningButton.dataset.meaning = item.meaning;
  meaningButton.dataset.word = item.word;
  setMeaningVisibility(meaningButton, false);
  meaningButton.addEventListener("click", () => {
    setMeaningVisibility(meaningButton, meaningButton.dataset.revealed !== "true");
  });

  row.append(wordCell, meaningButton);
  return row;
}

function createChip(text, extraClass = "") {
  const chip = document.createElement("span");
  chip.className = `pos-chip ${extraClass}`.trim();
  chip.textContent = text;
  return chip;
}

function inferPartInfo(word) {
  const normalized = normalizeWordForLookup(word);
  const firstWord = normalized.split(" ")[0] || "";
  const isPhrase = normalized.includes(" ");
  const partKeys =
    POS_OVERRIDES.get(normalized) ||
    inferPartKeys(normalized, firstWord, isPhrase);

  return {
    isPhrase,
    labels: partKeys.map((key) => PART_LABELS[key]).filter(Boolean)
  };
}

function inferPartKeys(normalized, firstWord, isPhrase) {
  if (COMMON_PREPOSITIONS.has(normalized) || COMMON_PREPOSITIONS.has(firstWord)) {
    return ["preposition"];
  }

  if (isPhrase) {
    if (/^be\s+/.test(normalized)) {
      return ["adjective"];
    }

    if (
      /\b[abovx]\b/.test(normalized) ||
      /\bto v\b/.test(normalized) ||
      COMMON_VERBS.has(firstWord)
    ) {
      return ["verb"];
    }
  }

  if (COMMON_VERBS.has(normalized) || COMMON_VERBS.has(firstWord)) {
    return ["verb"];
  }

  if (normalized.endsWith("ly")) {
    return ["adverb"];
  }

  if (/(able|ible|al|ant|ent|ful|ic|ive|less|ous)$/.test(normalized)) {
    return ["adjective"];
  }

  return ["noun"];
}

function normalizeWordForLookup(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setMeaningVisibility(button, shouldShow) {
  button.dataset.revealed = String(shouldShow);
  button.classList.toggle("is-hidden", !shouldShow);
  button.setAttribute("aria-pressed", String(shouldShow));
  button.setAttribute(
    "aria-label",
    shouldShow ? `${button.dataset.word}の意味を隠す` : `${button.dataset.word}の意味を表示`
  );
  button.textContent = shouldShow ? button.dataset.meaning : "表示";

  if (!shouldShow) {
    const placeholder = document.createElement("span");
    placeholder.className = "meaning-placeholder";
    placeholder.textContent = "表示";
    button.replaceChildren(placeholder);
  }
}

function hideAllMeanings() {
  const buttons = elements.wordList.querySelectorAll(".meaning-button");
  buttons.forEach((button) => setMeaningVisibility(button, false));
}

function reshuffleCurrentRange() {
  if (!state.currentRange) return;

  const { startIndex, endIndex } = state.currentRange;
  state.boardWords = shuffle(state.fileWords.slice(startIndex, endIndex + 1));
  renderBoard();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showFileScreen() {
  showScreen("files");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showRangeScreen() {
  showScreen("ranges");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, section]) => {
    section.hidden = key !== name;
  });
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function shuffle(words) {
  const shuffled = words.map((word) => ({ ...word }));

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled;
}
