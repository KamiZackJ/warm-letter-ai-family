import type { Letter, Material } from "../types/domain";
import { storageKey } from "../config/env";

const MATERIALS_KEY = storageKey("materials");
const LETTERS_KEY = storageKey("letters");
const CURRENT_MATERIALS_KEY = storageKey("current_material_ids");
const PENDING_GENERATION_KEY = storageKey("pending_generation");

export interface PendingGeneration {
  letterId: string;
  fingerprint: string;
}

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

export function getPendingGeneration(): PendingGeneration | undefined {
  const value = wx.getStorageSync(PENDING_GENERATION_KEY);
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.letterId !== "string" ||
    typeof value.fingerprint !== "string"
  ) {
    return undefined;
  }
  return value as PendingGeneration;
}

export function savePendingGeneration(pending?: PendingGeneration): void {
  if (pending) wx.setStorageSync(PENDING_GENERATION_KEY, pending);
  else wx.removeStorageSync(PENDING_GENERATION_KEY);
}

export function clearPendingGeneration(letterId?: string): void {
  const pending = getPendingGeneration();
  if (!letterId || pending?.letterId === letterId) savePendingGeneration();
}

export function getLetters(): Letter[] {
  return readList<Letter>(LETTERS_KEY);
}

export function saveLetters(letters: Letter[]): void {
  wx.setStorageSync(LETTERS_KEY, letters);
}
