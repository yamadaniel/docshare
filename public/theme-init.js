// 選んだテーマを描画前に適用する（ちらつき防止）
try {
  var t = localStorage.getItem("ds.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
