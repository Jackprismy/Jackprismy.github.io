// =====================
// 設定
// =====================

// ここを増やすだけで教材追加可能
const books = [
  {
    name: "1",
    file: "word1.json"
  },
  {
    name: "2",
    file: "word2.json"
  }
];

const RANGE_SIZE = 40;

// =====================

const bookButtons = document.getElementById("bookButtons");
const rangeButtons = document.getElementById("rangeButtons");

const bookSelect = document.getElementById("bookSelect");
const rangeSelect = document.getElementById("rangeSelect");

const quizArea = document.getElementById("quizArea");

const wordDiv = document.getElementById("word");
const meaningDiv = document.getElementById("meaning");

const showMeaningBtn = document.getElementById("showMeaningBtn");
const speakBtn = document.getElementById("speakBtn");

const answerButtons = document.getElementById("answerButtons");

const correctBtn = document.getElementById("correctBtn");
const wrongBtn = document.getElementById("wrongBtn");

const progressDiv = document.getElementById("progress");

const finishArea = document.getElementById("finishArea");
const finishText = document.getElementById("finishText");
const restartBtn = document.getElementById("restartBtn");

let words = [];

let quizList = [];
let wrongList = [];

let currentIndex = 0;
let currentWord = null;

// =====================
// 教材選択ボタン生成
// =====================

books.forEach(book => {

  const btn = document.createElement("button");

  btn.textContent = book.name;

  btn.onclick = async () => {

    const response = await fetch(book.file);

    words = await response.json();

    showRanges();
  };

  bookButtons.appendChild(btn);
});

// =====================
// 範囲ボタン生成
// =====================

function showRanges() {

  bookSelect.classList.add("hidden");
  rangeSelect.classList.remove("hidden");

  rangeButtons.innerHTML = "";

  const totalRanges = Math.ceil(words.length / RANGE_SIZE);

  for (let i = 0; i < totalRanges; i++) {

    const start = i * RANGE_SIZE + 1;
    const end = Math.min((i + 1) * RANGE_SIZE, words.length);

    const btn = document.createElement("button");

    btn.textContent = `${start}〜${end}`;

    btn.onclick = () => startQuiz(i);

    rangeButtons.appendChild(btn);
  }
}

// =====================
// クイズ開始
// =====================

function startQuiz(rangeIndex) {

  rangeSelect.classList.add("hidden");
  quizArea.classList.remove("hidden");

  const start = rangeIndex * RANGE_SIZE;
  const end = start + RANGE_SIZE;

  quizList = words.slice(start, end);

  shuffleArray(quizList);

  wrongList = [];

  currentIndex = 0;

  showQuestion();
}

// =====================
// 問題表示
// =====================

function showQuestion() {

  if (currentIndex >= quizList.length) {

    // 間違いがある場合
    if (wrongList.length > 0) {

      quizList = [...wrongList];

      shuffleArray(quizList);

      wrongList = [];

      currentIndex = 0;

      alert("間違えた問題をもう一度出題します");

      showQuestion();

      return;
    }

    finishQuiz();

    return;
  }

  currentWord = quizList[currentIndex];

  progressDiv.textContent =
    `${currentIndex + 1} / ${quizList.length}`;

  wordDiv.textContent = currentWord.word;

  meaningDiv.textContent = currentWord.meaning;

  meaningDiv.classList.add("hidden");

  answerButtons.classList.add("hidden");

  speak(currentWord.word);
}

// =====================
// 意味表示
// =====================

showMeaningBtn.onclick = () => {

  meaningDiv.classList.remove("hidden");

  answerButtons.classList.remove("hidden");
};

// =====================
// 発音
// =====================

speakBtn.onclick = () => {

  speak(currentWord.word);
};

function speak(text) {

  speechSynthesis.cancel();

  const utterance =
    new SpeechSynthesisUtterance(text);

  utterance.lang = "en-US";

  speechSynthesis.speak(utterance);
}

// =====================
// 正解
// =====================

correctBtn.onclick = () => {

  currentIndex++;

  showQuestion();
};

// =====================
// 不正解
// =====================

wrongBtn.onclick = () => {

  wrongList.push(currentWord);

  currentIndex++;

  showQuestion();
};

// =====================
// 終了
// =====================

function finishQuiz() {

  quizArea.classList.add("hidden");

  finishArea.classList.remove("hidden");

  finishText.textContent =
    "全ての問題をクリアしました！";
}

// =====================
// 最初へ
// =====================

restartBtn.onclick = () => {

  finishArea.classList.add("hidden");

  rangeSelect.classList.add("hidden");

  bookSelect.classList.remove("hidden");
};

// =====================
// シャッフル
// =====================

function shuffleArray(array) {

  for (let i = array.length - 1; i > 0; i--) {

    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] =
      [array[j], array[i]];
  }
}