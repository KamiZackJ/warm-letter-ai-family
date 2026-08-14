import type { Letter, Material } from "../types/domain";

const MATERIALS_KEY = "warm_letter_materials";
const LETTERS_KEY = "warm_letter_letters";
const CURRENT_MATERIALS_KEY = "warm_letter_current_material_ids";

function readList<T>(key: string): T[] {
  const value = wx.getStorageSync(key);
  return Array.isArray(value) ? (value as T[]) : [];
}

export function getMaterials(): Material[] {
  return readList<Material>(MATERIALS_KEY);
}

export function saveMaterials(materials: Material[]): void {
  wx.setStorageSync(MATERIALS_KEY, materials);
}

export function getCurrentMaterialIds(): string[] {
  return readList<string>(CURRENT_MATERIALS_KEY);
}

export function saveCurrentMaterialIds(ids: string[]): void {
  wx.setStorageSync(CURRENT_MATERIALS_KEY, ids);
}

export function getLetters(): Letter[] {
  return readList<Letter>(LETTERS_KEY);
}

export function saveLetters(letters: Letter[]): void {
  wx.setStorageSync(LETTERS_KEY, letters);
}
