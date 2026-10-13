import { defaultCategories, defaultClips } from "../data/templates.js";
import type { Clip } from "../types/template.js";

const STORAGE_KEYS = {
  categories: "categories",
  clips: "clips",
} as const;

export async function initializeStorage(): Promise<void> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.categories,
    STORAGE_KEYS.clips,
  ]);

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

/** Invalid existing data is reported, never silently reset or overwritten. */
export async function getClips(): Promise<Clip[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.clips);
  const clips: unknown = stored[STORAGE_KEYS.clips];
  if (!Array.isArray(clips) || !clips.every(isClip)) {
    throw new Error("保存済みClipの形式が正しくありません。既存データは変更していません。");
  }
  return clips;
}

function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Partial<Clip>;
  return typeof clip.id === "string" && typeof clip.categoryId === "string" &&
    typeof clip.label === "string" && typeof clip.text === "string" &&
    typeof clip.pinned === "boolean" && typeof clip.order === "number" && Number.isFinite(clip.order);
}
