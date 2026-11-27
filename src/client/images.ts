import { IMAGE_MAX_EDGE, MAX_IMAGE_BYTES } from "../shared/constants";
import type { User } from "./user";

export interface UploadedImage {
  src: string;
  width: number;
  height: number;
}

/** 写真を選ばせる。キャンセルなら null */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * 長辺 IMAGE_MAX_EDGE px に縮めて WebP（使えなければ JPEG）にする。
 * 描き直すので、撮影場所などの写真の付加情報は残らない
 */
async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("この形式の写真は読み込めない");
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("写真を縮められなかった");
  // JPEG になったときに透明部分が黒くならないよう、白で下塗りする
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const [type, quality] of [
    ["image/webp", 0.82],
    ["image/jpeg", 0.85],
  ] as const) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
    // toBlob は対応していない形式を PNG で返すことがあるので、形式を確かめる
    if (blob && blob.type === type && blob.size <= MAX_IMAGE_BYTES) return { blob, width, height };
  }
  throw new Error("写真が大きすぎる");
}

const ERRORS: Record<string, string> = {
  too_many_images: "この文書にはこれ以上写真を置けない（20 枚まで）",
  archived: "読み取り専用の文書には写真を置けない",
  too_large: "写真が大きすぎる",
  rate_limited: "続けて送りすぎている。少し待ってから試す",
  unavailable: "いまは写真を置けない",
};

/** 縮めてから送り、本文に書く参照を受け取る */
export async function uploadImage(docId: string, user: User, file: File): Promise<UploadedImage> {
  const { blob, width, height } = await shrink(file);
  const res = await fetch(`/api/docs/${docId}/images`, {
    method: "POST",
    headers: { "Content-Type": blob.type, "X-User-Id": user.userId, "X-User-Secret": user.secret },
    body: blob,
  });
  const data = (await res.json().catch(() => ({}))) as { src?: string; error?: string };
  if (!res.ok || !data.src) throw new Error(ERRORS[data.error ?? ""] ?? "写真を送れなかった");
  return { src: data.src, width, height };
}
