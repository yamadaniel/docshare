import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class DocRoom extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
