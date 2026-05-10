let allWords = [];

let currentList = [];
let currentIndex = 0;

let wrongAnswers = [];

const startScreen = document.getElementById("startScreen");
const quizScreen = document.getElementById("quizScreen");
const resultScreen = document.getElementById("resultScreen");

const wordEl = document.getElementById("word");
const meaningEl = document.getElementById("meaning");
const meaningArea = document.getElementById("meaningArea");
const progressEl = document.getElementById("progress");
const questionNumberEl = document.getElementById("questionNumber");

const resultText = document.getElementById("resultText");
const wrongList = document.getElementById("wrongList");

fetch("word1.json")
  .then(response => response.json())
  .then(data => {

    allWords = data.map((item, index) => ({
      ...item,
      originalIndex: index
    }));

    const startBtn =
      document.getElementById("startBtn");

    const allBtn =
      document.getElementById("allBtn");

    startBtn.disabled = false;
    allBtn.disabled = false;

    startBtn.textContent = "開始";
    allBtn.textContent = "すべてやる";
  })
  .catch(error => {
    alert("word1.json の読み込みに失敗しました");
    console.error(error);
  });

function startQuiz(start, end) {

  wrongAnswers = [];

  currentList = allWords.slice(start - 1, end);
  currentIndex = 0;

  startScreen.classList.add("hidden");
  resultScreen.classList.add("hidden");
  quizScreen.classList.remove("hidden");

  showQuestion();
}

function showQuestion() {

  meaningArea.classList.add("hidden");

  if (currentIndex >= currentList.length) {
    showResult();
    return;
  }

  const item = currentList[currentIndex];

  wordEl.textContent = item.word;
  meaningEl.textContent = item.meaning;

  progressEl.textContent =
    `${currentIndex + 1} / ${currentList.length}`;

  questionNumberEl.textContent =
    `問題番号: ${item.originalIndex + 1}`;
}

function nextQuestion(correct) {

  const item = currentList[currentIndex];

  if (!correct) {
    wrongAnswers.push(item);
  }

  currentIndex++;

  showQuestion();
}

function showResult() {

  quizScreen.classList.add("hidden");
  resultScreen.classList.remove("hidden");

  resultText.innerHTML =
    `間違えた数: <b>${wrongAnswers.length}</b>`;

  if (wrongAnswers.length === 0) {

    wrongList.innerHTML = "全問正解！";

    document.getElementById("retryBtn").style.display =
      "none";

    return;
  }

  document.getElementById("retryBtn").style.display =
    "block";

  let html = "<h3>間違えた問題</h3>";

  wrongAnswers.forEach(item => {

    html += `
      <div>
        ${item.originalIndex + 1}. ${item.word}
      </div>
    `;
  });

  wrongList.innerHTML = html;
}

document
  .getElementById("showMeaningBtn")
  .addEventListener("click", () => {

    meaningArea.classList.remove("hidden");
  });

document
  .getElementById("correctBtn")
  .addEventListener("click", () => {

    nextQuestion(true);
  });

document
  .getElementById("wrongBtn")
  .addEventListener("click", () => {

    nextQuestion(false);
  });

document
  .getElementById("startBtn")
  .addEventListener("click", () => {

    const start =
      parseInt(document.getElementById("startNum").value);

    const end =
      parseInt(document.getElementById("endNum").value);

    if (!start || !end) {

      alert("開始番号と終了番号を入力してください");

      return;
    }

    if (
      start < 1 ||
      end > allWords.length ||
      start > end
    ) {

      alert("範囲が不正です");

      return;
    }

    startQuiz(start, end);
  });

document
  .getElementById("allBtn")
  .addEventListener("click", () => {

    startQuiz(1, allWords.length);
  });

document
  .getElementById("retryBtn")
  .addEventListener("click", () => {

    currentList = [...wrongAnswers];

    wrongAnswers = [];

    currentIndex = 0;

    resultScreen.classList.add("hidden");
    quizScreen.classList.remove("hidden");

    showQuestion();
  });
