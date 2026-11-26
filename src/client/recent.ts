import { DOC_ID_RE, RECENT_MAX } from "../shared/constants";

export interface RecentDoc {
  docId: string;
  title: string;
  openedAt: number;
}

const KEY = "ds.recent";

export function loadRecent(): RecentDoc[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (d): d is RecentDoc =>
          !!d && typeof d.docId === "string" && DOC_ID_RE.test(d.docId) && typeof d.title === "string",
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 先頭に追加（新しい順、最大 RECENT_MAX 件） */
export function touchRecent(docId: string, title: string): void {
  const list = loadRecent().filter((d) => d.docId !== docId);
  list.unshift({ docId, title, openedAt: Date.now() });
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

export function removeRecent(docId: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadRecent().filter((d) => d.docId !== docId)));
}
