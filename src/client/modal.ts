import { NAME_MAX } from "../shared/constants";
import { h, inertApp } from "./dom";

interface PromptModalOptions {
  title: string;
  description: string;
  initial?: string;
  /** false なら閉じられない（初回登録） */
  dismissable: boolean;
  okLabel?: string;
  /** 入力欄の属性（maxLength、placeholder など） */
  input: Record<string, unknown>;
  /** 例外を投げると、そのメッセージを表示してモーダルを開いたままにする */
  submit(value: string): Promise<void>;
}

/** 1 行入力のモーダル。確定で true、キャンセルで false */
export function promptModal(opts: PromptModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const input = h("input", {
      class: "text-input",
      type: "text",
      value: opts.initial ?? "",
      enterKeyHint: "done",
      ...opts.input,
    });
    const error = h("p", { class: "form-error", role: "alert" });
    const ok = h("button", { class: "btn primary", type: "submit" }, opts.okLabel ?? "保存");
    const cancel = opts.dismissable ? h("button", { class: "btn", type: "button" }, "キャンセル") : null;
    const form = h(
      "form",
      // ブラウザ自体の入力検証は使わない（type="url" だと「example.com」が送信できない）
      { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": opts.title, noValidate: true },
      h("h2", null, opts.title),
      h("p", null, opts.description),
      input,
      error,
      h("div", { class: "modal-actions" }, cancel, ok),
    );
    const overlay = h("div", { class: "overlay" }, form);

    const opener = document.activeElement as HTMLElement | null;
    let releaseInert = () => {};
    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      releaseInert();
      // 開く前にフォーカスしていた要素（名前チップなど）に戻す
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
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
    releaseInert = inertApp();
    input.focus();
    input.select();
  });
}

interface NameModalOptions {
  title: string;
  description: string;
  initial?: string;
  dismissable: boolean;
  submit(name: string): Promise<void>;
}

/** 名前入力モーダル */
export function nameModal(opts: NameModalOptions): Promise<boolean> {
  return promptModal({
    ...opts,
    input: {
      maxLength: NAME_MAX,
      placeholder: "名前（20文字まで）",
      autocomplete: "nickname",
      "aria-label": "名前",
    },
  });
}
