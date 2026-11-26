export type StepJSON = Record<string, unknown>;
export type DocJSON = Record<string, unknown>;

export type ErrorCode =
  | "version_mismatch"
  | "too_large"
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "invalid";

export type ClientMessage =
  | { type: "hello"; userId: string; secret: string }
  | { type: "steps"; version: number; clientId: string; steps: StepJSON[] }
  | { type: "title"; version: number; title: string }
  | { type: "sync"; version: number }
  | { type: "rename" }
  | { type: "restore"; revId: number };

export type ServerMessage =
  | { type: "init"; version: number; doc: DocJSON; title: string; users: Record<string, string> }
  | { type: "steps"; version: number; revId: number; userId: string; clientIds: string[]; steps: StepJSON[] }
  | { type: "title"; title: string; userId: string }
  | { type: "presence"; userIds: string[] }
  | { type: "rename"; userId: string; name: string }
  | { type: "error"; code: ErrorCode };

export type RevisionKind = "steps" | "title" | "restore";

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
