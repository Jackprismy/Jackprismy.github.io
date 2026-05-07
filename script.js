let words = [];

let activeList = [];
let failedList = [];

let currentSlot = 0;
let currentIndex = null;

let showingMeaning = false;
let paused = false;

let timer;

const wordEl = document.getElementById("word");
const meaningEl = document.getElementById("meaning");
const numberEl = document.getElementById("number");
const failedEl = document.getElementById("failed-list");

fetch("words.json")
  .then(res => res.json())
  .then(data => {
    words = data;
  });

document.getElementById("startBtn").onclick = start;

function parseRange(str) {
  let result = [];

  str.split(",").forEach(part => {
    let [a, b] = part.split("-").map(Number);

    for (let i = a; i <= b; i++) {
      result.push(i - 1);
    }
  });

  return result;
}

let rangeList = [];
let nextPointer = 3;

function start() {

  const input = document.getElementById("rangeInput").value;

  rangeList = parseRange(input);

  activeList = [
    rangeList[0],
    rangeList[1],
    rangeList[2]
  ];

  nextPointer = 3;

  document.getElementById("start-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  nextQuestion();
}

function nextQuestion() {

  if (paused) return;

  if (activeList.every(v => v === undefined)) {

    if (failedList.length === 0) {
      alert("終了！");
      return;
    }

    rangeList = [...new Set(failedList)];
    failedList = [];

    activeList = [
      rangeList[0],
      rangeList[1],
      rangeList[2]
    ];

    nextPointer = 3;
  }

  currentIndex = activeList[currentSlot];

  if (currentIndex === undefined) {
    currentSlot = (currentSlot + 1) % 3;
    nextQuestion();
    return;
  }

  const item = words[currentIndex];

  numberEl.textContent = currentIndex + 1;
  wordEl.textContent = item.word;

  meaningEl.textContent = "";
  showingMeaning = false;

  timer = setTimeout(() => {

    meaningEl.textContent = item.meaning;
    showingMeaning = true;

    timer = setTimeout(() => {
      fail();
    }, 2000);

  }, 2000);
}

function success() {

  replaceCurrent();

  moveNext();
}

function fail() {

  failedList.push(currentIndex + 1);

  updateFailed();

  moveNext();
}

function replaceCurrent() {

  if (nextPointer < rangeList.length) {
    activeList[currentSlot] = rangeList[nextPointer];
    nextPointer++;
  } else {
    activeList[currentSlot] = undefined;
  }
}

function moveNext() {

  clearTimeout(timer);

  currentSlot = (currentSlot + 1) % 3;

  nextQuestion();
}

function updateFailed() {

  failedEl.textContent =
    "ミス:\n" + [...new Set(failedList)].join(", ");
}

let startY = 0;

document.addEventListener("touchstart", e => {
  startY = e.touches[0].clientY;
});

document.addEventListener("touchend", e => {

  if (!showingMeaning) return;

  const endY = e.changedTouches[0].clientY;

  const diff = startY - endY;

  if (diff > 50) {
    success();
  } else if (diff < -50) {
    fail();
  }
});

document.getElementById("pauseBtn").onclick = () => {
  paused = !paused;

  if (!paused) {
    nextQuestion();
  }
};

document.getElementById("resetBtn").onclick = () => {

  failedList = [];
  updateFailed();
};
