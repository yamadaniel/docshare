import { SECRET_RE, USER_ID_RE, sanitizeName } from "../shared/constants";

export interface User {
  userId: string;
  secret: string;
  name: string;
}

const KEY = "ds.user";

export function loadUser(): User | null {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<User> | null;
    if (
      u &&
      typeof u.userId === "string" &&
      typeof u.secret === "string" &&
      USER_ID_RE.test(u.userId) &&
      SECRET_RE.test(u.secret) &&
      sanitizeName(u.name)
    ) {
      return { userId: u.userId, secret: u.secret, name: u.name! };
    }
  } catch {
    // 壊れた値は未登録として扱う
  }
  return null;
}

export function saveUser(user: User): void {
  localStorage.setItem(KEY, JSON.stringify(user));
}

export function clearUser(): void {
  localStorage.removeItem(KEY);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function errorText(status: number): string {
  if (status === 429) return "操作が多すぎる。少し待ってから再試行";
  if (status === 400) return "名前は1〜20文字で入力";
  return "保存に失敗した。通信状況を確認して再試行";
}

/** 初回登録。成功後に localStorage へ保存する */
export async function registerUser(rawName: string): Promise<User> {
  const name = sanitizeName(rawName);
  if (!name) throw new Error(errorText(400));
  const user: User = { userId: crypto.randomUUID(), secret: randomSecret(), name };
  let res: Response;
  try {
    res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
    });
  } catch {
    throw new Error(errorText(0));
  }
  if (!res.ok) throw new Error(errorText(res.status));
  saveUser(user);
  return user;
}

/** 名前変更。成功後に localStorage を更新する */
export async function renameUser(user: User, rawName: string): Promise<User> {
  const name = sanitizeName(rawName);
  if (!name) throw new Error(errorText(400));
  let res: Response;
  try {
    res = await fetch("/api/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-User-Id": user.userId, "X-User-Secret": user.secret },
      body: JSON.stringify({ name }),
    });
  } catch {
    throw new Error(errorText(0));
  }
  if (!res.ok) throw new Error(errorText(res.status));
  const next = { ...user, name };
  saveUser(next);
  return next;
}
