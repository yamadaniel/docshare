export const DOC_ID_LENGTH = 22;
export const DOC_ID_RE = /^[0-9A-Za-z]{22}$/;
export const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export const NAME_MAX = 20;
export const TITLE_MAX = 100;
export const HREF_MAX = 2048;
export const MAX_WS_MESSAGE_BYTES = 64 * 1024;
export const MAX_DOC_BYTES = 1024 * 1024;
export const SNAPSHOT_INTERVAL = 200;
export const WS_MESSAGES_PER_SECOND = 20;
/** 1 文書に同時につなげる WebSocket の数 */
export const MAX_SOCKETS_PER_DOC = 100;
/** 1 文書に同じ IP からつなげる WebSocket の数 */
export const MAX_SOCKETS_PER_IP = 20;
/** 接続してから hello を送るまでの猶予 */
export const HELLO_TIMEOUT_MS = 10_000;
/** 文書を作れる数（全体で 1 分あたり）。環境変数 GLOBAL_CREATE_PER_MINUTE で変えられる */
export const GLOBAL_CREATE_PER_MINUTE = 60;

export const SEND_DEBOUNCE_MS = 500;
export const SEND_MAX_WAIT_MS = 2000;
export const HISTORY_GROUP_MS = 60_000;
export const HISTORY_PAGE = 50;
export const RECENT_MAX = 20;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 16バイト乱数 → base62 22文字 */
export function generateDocId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < DOC_ID_LENGTH; i++) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/** 制御文字を除去して trim。範囲外なら null */
export function sanitizeName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const len = [...name].length;
  return len >= 1 && len <= NAME_MAX ? name : null;
}

/** 文書名。空文字は可、上限超過は null */
export function sanitizeTitle(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const title = input.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return [...title].length <= TITLE_MAX ? title : null;
}

/** リンク先として許可する URL（http / https / mailto）。それ以外は javascript: などを防ぐため拒否する */
export function isSafeHref(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > HREF_MAX) return false;
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * 入力された文字列をリンク先に整える。スキームがなければ https:// を補う。
 * 使えない場合は null
 */
export function normalizeHref(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  if (!isSafeHref(withScheme)) return null;
  // 「https://」だけ、などホストのない URL は除く
  if (/^https?:/i.test(withScheme) && !new URL(withScheme).hostname.includes(".")) return null;
  return withScheme;
}
