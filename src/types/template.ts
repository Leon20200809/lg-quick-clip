export interface Category {
  id: string;
  label: string;
  order: number;
}

export interface Clip {
  id: string;
  categoryId: string;
  label: string;
  text: string;
  pinned: boolean;
  order: number;
}
