export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** secret を検証し、正しければ現在の名前を返す */
export async function verifyUser(db: D1Database, userId: string, secret: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT secret_hash, name FROM users WHERE user_id = ?")
    .bind(userId)
    .first<{ secret_hash: string; name: string }>();
  if (!row) return null;
  return timingSafeEqual(row.secret_hash, await sha256Hex(secret)) ? row.name : null;
}

export async function getUserName(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM users WHERE user_id = ?").bind(userId).first<{ name: string }>();
  return row?.name ?? null;
}

/** userId → 名前。D1 のバインド数上限に合わせて分割して問い合わせる */
export async function resolveNames(db: D1Database, userIds: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const ids = [...new Set(userIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT user_id, name FROM users WHERE user_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ user_id: string; name: string }>();
    for (const r of results) names[r.user_id] = r.name;
  }
  return names;
}
