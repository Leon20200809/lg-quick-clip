/** ローカル保存の初期化とClip読込の境界検証を担当し、既存データを保持する。 */
import { defaultCategories, defaultClips } from "../data/templates.js";
// 型だけを参照し、実行時のモジュール依存は増やさない。
import type { Clip } from "../types/template.js";

const STORAGE_KEYS = {
  categories: "categories",
  clips: "clips",
} as const;

/** 未作成のキーだけに例示データを保存し、読込・保存失敗は呼出元へ伝える。 */
export async function initializeStorage(): Promise<void> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.categories,
    STORAGE_KEYS.clips,
  ]);

  // 空配列や不正な値も既存データとして残し、真偽値で初期化の要否を判断しない。
  if (!Object.hasOwn(stored, STORAGE_KEYS.categories)) {
    await chrome.storage.local.set({
      categories: defaultCategories,
    });
  }

  if (!Object.hasOwn(stored, STORAGE_KEYS.clips)) {
    await chrome.storage.local.set({
      clips: defaultClips,
    });
  }
}

/** 保存済みClipの形式を検証して返し、不正データは初期値に戻さず例外で知らせる。 */
export async function getClips(): Promise<Clip[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.clips);
  const clips: unknown = stored[STORAGE_KEYS.clips];
  if (!Array.isArray(clips) || !clips.every(isClip)) {
    throw new Error(
      "保存済みClipの形式が正しくありません。既存データは変更していません。",
    );
  }
  return clips;
}

/** 描画・並び替え・入力に必要なClip各項目の型を確認する。 */
function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Partial<Clip>;
  return (
    typeof clip.id === "string" &&
    typeof clip.categoryId === "string" &&
    typeof clip.label === "string" &&
    typeof clip.text === "string" &&
    typeof clip.pinned === "boolean" &&
    typeof clip.order === "number" &&
    Number.isFinite(clip.order)
  );
}
