import type { Category, Clip } from "../types/template.js";

export const defaultCategories: Category[] = [
  {
    id: "personal",
    label: "個人情報",
    order: 1,
  },
];

export const defaultClips: Clip[] = [
  {
    id: "email",
    categoryId: "personal",
    label: "メールアドレス",
    text: "example@example.com",
    pinned: true,
    order: 1,
  },
  {
    id: "phone",
    categoryId: "personal",
    label: "電話番号",
    text: "090-0000-0000",
    pinned: true,
    order: 2,
  },
  {
    id: "website",
    categoryId: "personal",
    label: "Webサイト",
    text: "https://example.com",
    pinned: false,
    order: 3,
  },
];
