// スクロール位置を各場面の進み具合（0〜1）として CSS 変数 --p に渡す
(function () {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var scenes = Array.prototype.slice.call(document.querySelectorAll(".scene"));
  var pars = Array.prototype.slice.call(document.querySelectorAll(".par"));
  var ticking = false;
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function update() {
    ticking = false;
    var vh = window.innerHeight;
    scenes.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var span = r.height - vh;
      el.style.setProperty("--p", span > 0 ? clamp(-r.top / span).toFixed(4) : "1");
    });
    pars.forEach(function (el) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--p", clamp((vh - r.top) / (vh + r.height)).toFixed(4));
    });
  }
  // 指の位置を、狙うチェックボックスの中心に合わせる（拡大・移動の影響を受けない offset で測る）
  var fingers = Array.prototype.slice.call(document.querySelectorAll(".finger"));
  function placeFingers() {
    fingers.forEach(function (el) {
      var box = document.getElementById(el.getAttribute("data-target"));
      if (!box) return;
      el.style.setProperty("--x", box.offsetLeft + box.offsetWidth / 2 + "px");
      el.style.setProperty("--y", box.offsetTop + box.offsetHeight / 2 + "px");
    });
  }
  function request() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
  addEventListener("resize", placeFingers);
  placeFingers();
  addEventListener("scroll", request, { passive: true });
  addEventListener("resize", request);
  update();
})();
