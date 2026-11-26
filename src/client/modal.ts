import { NAME_MAX } from "../shared/constants";
import { h } from "./dom";

interface NameModalOptions {
  title: string;
  description: string;
  initial?: string;
  /** false なら閉じられない（初回登録） */
  dismissable: boolean;
  submit(name: string): Promise<void>;
}

/** 名前入力モーダル。確定で true、キャンセルで false */
export function nameModal(opts: NameModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const input = h("input", {
      class: "text-input",
      type: "text",
      value: opts.initial ?? "",
      maxLength: NAME_MAX,
      placeholder: "名前（20文字まで）",
      autocomplete: "nickname",
      enterKeyHint: "done",
      "aria-label": "名前",
    });
    const error = h("p", { class: "form-error", role: "alert" });
    const ok = h("button", { class: "btn primary", type: "submit" }, "保存");
    const cancel = opts.dismissable ? h("button", { class: "btn", type: "button" }, "キャンセル") : null;
    const form = h(
      "form",
      { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": opts.title },
      h("h2", null, opts.title),
      h("p", null, opts.description),
      input,
      error,
      h("div", { class: "modal-actions" }, cancel, ok),
    );
    const overlay = h("div", { class: "overlay" }, form);

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && opts.dismissable) close(false);
    };
    const refresh = () => {
      ok.disabled = input.value.trim().length === 0;
    };

    input.addEventListener("input", refresh);
    cancel?.addEventListener("click", () => close(false));
    if (opts.dismissable) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(false);
      });
    }
    document.addEventListener("keydown", onKey);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      ok.disabled = true;
      error.textContent = "";
      try {
        await opts.submit(input.value);
        close(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : "保存に失敗した";
        refresh();
      }
    });

    refresh();
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}
