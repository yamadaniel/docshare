import type { DocRoom } from "./do/DocRoom";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DOC_ROOM: DurableObjectNamespace<DocRoom>;
  CREATE_LIMITER?: RateLimit;
  WS_LIMITER?: RateLimit;
  GLOBAL_CREATE_PER_MINUTE?: string;
}
