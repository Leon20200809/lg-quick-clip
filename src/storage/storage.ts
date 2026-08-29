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

  if (!stored.categories) {
    await chrome.storage.local.set({
      categories: defaultCategories,
    });
  }

  if (!stored.clips) {
    await chrome.storage.local.set({
      clips: defaultClips,
    });
  }
}

/** Storageから登録済みのClip一覧を取得する。 */
export async function getClips(): Promise<Clip[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.clips);

  /** Storageから取得した値をClip配列として扱う。 */
  const clips = stored[STORAGE_KEYS.clips] as Clip[] | undefined;

  return clips ?? [];
}
