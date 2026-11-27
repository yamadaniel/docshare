export type StepJSON = Record<string, unknown>;
export type DocJSON = Record<string, unknown>;

export type ErrorCode =
  | "version_mismatch"
  | "too_large"
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "invalid"
  | "archived";

/** 読み取り専用になった理由。manual：誰かが「完了」にした / auto：最後の更新から一定期間たった */
export interface ArchiveInfo {
  reason: "manual" | "auto";
  /** 読み取り専用になった時刻 */
  at: number;
  /** manual のとき、完了にした人 */
  userId?: string;
  name?: string;
  /** 続きの文書 */
  successor?: string;
}

export type ClientMessage =
  | { type: "hello"; userId: string; secret: string }
  | { type: "steps"; version: number; clientId: string; steps: StepJSON[] }
  | { type: "title"; version: number; title: string }
  | { type: "sync"; version: number }
  | { type: "rename" }
  | { type: "restore"; revId: number }
  | { type: "close" }
  | { type: "reopen" };

export type ServerMessage =
  | {
      type: "init";
      version: number;
      doc: DocJSON;
      title: string;
      users: Record<string, string>;
      archive: ArchiveInfo | null;
    }
  | { type: "steps"; version: number; revId: number; userId: string; clientIds: string[]; steps: StepJSON[] }
  | { type: "title"; title: string; userId: string }
  | { type: "presence"; userIds: string[] }
  | { type: "rename"; userId: string; name: string }
  | { type: "archive"; archive: ArchiveInfo | null }
  | { type: "error"; code: ErrorCode };

export type RevisionKind = "steps" | "title" | "restore" | "close" | "reopen";

export interface RevisionStats {
  added: number;
  deleted: number;
}

export interface RevisionSummary {
  revId: number;
  userId: string;
  name: string;
  kind: RevisionKind;
  version: number;
  stats: RevisionStats;
  title?: string;
  createdAt: number;
}

export interface RevisionListResponse {
  revisions: RevisionSummary[];
  nextBefore: number | null;
}

export interface RevisionDocResponse {
  revId: number;
  version: number;
  doc: DocJSON;
}
