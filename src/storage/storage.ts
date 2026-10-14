/** 保存境界で検証・排他・競合確認を行い、既存データを勝手に修復しない。 */
import { defaultCategories, defaultClips } from "../data/templates.js";
import type { Category, Clip } from "../types/template.js";

export const CLIP_LIMITS = { label: 80, text: 10_000, count: 100 } as const;
const WRITE_LOCK = "lg-quick-clip-storage";
export type ClipInput = Pick<Clip, "label" | "text">;
export type FieldErrors = Partial<Record<keyof ClipInput, string>>;

/** 全パネルの書込を同じ拡張originのロックで直列化する。無保護の代替書込はしない。 */
async function withWriteLock<T>(write: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks?.request) {
    throw new Error(
      "安全な保存に必要なWeb Locksを利用できません。Chromeを更新してSide Panelを開き直してください。保存はしていません。",
    );
  }
  return navigator.locks.request(WRITE_LOCK, write);
}

/** 未作成キーだけを初期化する。空配列・不正な既存値も上書きしない。 */
export async function initializeStorage(): Promise<void> {
  const stored = await chrome.storage.local.get(["categories", "clips"]);
  if (Object.hasOwn(stored, "categories") && Object.hasOwn(stored, "clips"))
    return;
  await withWriteLock(async () => {
    // ロック待ちの間に他パネルが初期化した可能性があるため、必ず読み直す。
    const latest = await chrome.storage.local.get(["categories", "clips"]);
    const missing: Record<string, unknown> = {};
    if (!Object.hasOwn(latest, "categories"))
      missing.categories = defaultCategories;
    if (!Object.hasOwn(latest, "clips")) missing.clips = defaultClips;
    if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  });
}

/** 表示・挿入用には文字数超過の既存値もそのまま読み込む。 */
export async function getClips(): Promise<Clip[]> {
  const stored = await chrome.storage.local.get("clips");
  const clips: unknown = stored.clips;
  if (
    !Array.isArray(clips) ||
    !clips.every(isClip) ||
    new Set(clips.map((clip) => clip.id)).size !== clips.length
  ) {
    throw new Error(
      "保存済みClipの形式またはIDが正しくありません。既存データは変更していません。",
    );
  }
  return clips;
}

function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Partial<Clip>;
  return (
    typeof clip.id === "string" &&
    clip.id.length > 0 &&
    typeof clip.categoryId === "string" &&
    typeof clip.label === "string" &&
    typeof clip.text === "string" &&
    typeof clip.pinned === "boolean" &&
    typeof clip.order === "number" &&
    Number.isFinite(clip.order)
  );
}

/** 既存の未変更項目は保持し、新規・変更項目だけにUTF-16単位の上限を適用する。 */
export function validateClipInput(
  input: ClipInput,
  original?: Clip,
): FieldErrors {
  const errors: FieldErrors = {};
  if (!original || input.label !== original.label) {
    if (!input.label.trim()) errors.label = "表示名を入力してください。";
    else if (input.label.trim().length > CLIP_LIMITS.label)
      errors.label = `表示名は${CLIP_LIMITS.label}文字以内にしてください（UTF-16単位）。`;
  }
  if (!original || input.text !== original.text) {
    if (!input.text.trim()) errors.text = "本文を入力してください。";
    else if (input.text.length > CLIP_LIMITS.text)
      errors.text = `本文は${CLIP_LIMITS.text}文字以内にしてください（UTF-16単位）。`;
  }
  return errors;
}

function checkedInput(input: ClipInput, original?: Clip): ClipInput {
  const errors = validateClipInput(input, original);
  if (Object.keys(errors).length)
    throw new Error(Object.values(errors).join(" "));
  return {
    label:
      original && input.label === original.label
        ? original.label
        : input.label.trim(),
    text: input.text,
  };
}

/** 不正カテゴリは未分類へ黙って変えず、新規作成だけを止める。 */
async function firstCategoryId(): Promise<string> {
  const { categories } = await chrome.storage.local.get("categories");
  if (
    !Array.isArray(categories) ||
    !categories.every((value: unknown): value is Category => {
      if (!value || typeof value !== "object") return false;
      const category = value as Partial<Category>;
      return (
        typeof category.id === "string" &&
        category.id.length > 0 &&
        typeof category.label === "string" &&
        typeof category.order === "number" &&
        Number.isFinite(category.order)
      );
    }) ||
    new Set(categories.map((category) => category.id)).size !==
      categories.length
  ) {
    throw new Error(
      "カテゴリの保存形式が正しくないため作成できません。既存データは変更していません。",
    );
  }
  return categories.slice().sort((a, b) => a.order - b.order)[0]?.id ?? "";
}

/** ロック取得後の最新一覧へ追加し、他Clipや他キーを保持する。 */
export async function createClip(input: ClipInput): Promise<void> {
  const values = checkedInput(input);
  await withWriteLock(async () => {
    const clips = await getClips();
    if (clips.length >= CLIP_LIMITS.count)
      throw new Error(
        `新規作成は${CLIP_LIMITS.count}件までです。既存Clipを削除してから作成してください。`,
      );
    const maxOrder = clips.length
      ? Math.max(...clips.map((clip) => clip.order))
      : 0;
    const order = maxOrder + 1;
    if (
      !Number.isFinite(order) ||
      Math.abs(order) > Number.MAX_SAFE_INTEGER ||
      order <= maxOrder
    )
      throw new Error(
        "末尾の並び順を安全に作成できません。既存データは変更していません。",
      );
    const categoryId = await firstCategoryId();
    const id = crypto.randomUUID();
    if (clips.some((clip) => clip.id === id))
      throw new Error(
        "新しいIDを作成できませんでした。もう一度保存してください。",
      );
    await chrome.storage.local.set({
      clips: [...clips, { id, categoryId, ...values, pinned: false, order }],
    });
  });
}

/** 確認開始時と最新の対象全体を比較し、古い編集・削除で変更を失わないようにする。 */
function findUnchangedClip(clips: Clip[], original: Clip): number {
  const index = clips.findIndex((clip) => clip.id === original.id);
  if (index < 0 || JSON.stringify(clips[index]) !== JSON.stringify(original)) {
    throw new Error(
      "このClipは別の画面で変更または削除されました。入力内容を控え、キャンセルして最新のClipを選び直してください。",
    );
  }
  return index;
}

export async function updateClip(
  original: Clip,
  input: ClipInput,
): Promise<void> {
  const values = checkedInput(input, original);
  await withWriteLock(async () => {
    const clips = await getClips();
    const index = findUnchangedClip(clips, original);
    clips[index] = { ...clips[index], ...values };
    await chrome.storage.local.set({ clips });
  });
}

export async function deleteClip(original: Clip): Promise<void> {
  await withWriteLock(async () => {
    const clips = await getClips();
    const index = findUnchangedClip(clips, original);
    await chrome.storage.local.set({
      clips: clips.filter((_, position) => position !== index),
    });
  });
}
