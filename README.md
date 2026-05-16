# 英単語帳アプリ

GitHub Pagesで動くスマホ向けの英単語4択アプリです。

開くファイルは `beesknees.html` です。

## ファイル構成

```text
.
├─ beesknees.html
├─ beesknees.css
├─ beesknees.js
├─ manifest.json
├─ word1.json
└─ word2.json
```

## 単語ファイルの形式

`word1.json` のように、配列で保存します。

```json
[
  { "word": "sense", "meaning": "感覚" },
  { "word": "sweat", "meaning": "汗" }
]
```

## ファイルを追加する方法

`word3.json` を追加したら、`manifest.json` にも追加します。

```json
[
  { "file": "word1.json", "label": "word1" },
  { "file": "word2.json", "label": "word2" },
  { "file": "word3.json", "label": "word3" }
]
```

`word2.json` は801番から、`word3.json` は1601番から表示されます。特別な開始番号にしたい場合は `startNumber` を指定できます。

```json
{ "file": "custom.json", "label": "custom", "startNumber": 2401 }
```
