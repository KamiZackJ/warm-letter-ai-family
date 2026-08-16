import type { Letter, Material } from "../types/domain";
import { storageKey } from "../config/env";
import { createId } from "./id";

const MATERIALS_KEY = storageKey("materials");
const LETTERS_KEY = storageKey("letters");
const CURRENT_MATERIALS_KEY = storageKey("current_material_ids");
const CURRENT_MATERIAL_SELECTION_KEY = storageKey("current_material_selection");
const PENDING_GENERATION_KEY = storageKey("pending_generation");

export interface CurrentMaterialSelection {
  sessionId: string;
  revision: number;
  ids: string[];
}

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

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0)),
  );
}

function readCurrentMaterialSelection(): CurrentMaterialSelection {
  const value = wx.getStorageSync(CURRENT_MATERIAL_SELECTION_KEY);
  if (
    value &&
    typeof value === "object" &&
    typeof value.sessionId === "string" &&
    value.sessionId &&
    Array.isArray(value.ids)
  ) {
    const selection = {
      sessionId: value.sessionId,
      revision:
        typeof value.revision === "number" &&
        Number.isInteger(value.revision) &&
        value.revision >= 0
          ? value.revision
          : 0,
      ids: normalizeIds(value.ids),
    };
    if (
      value.revision !== selection.revision ||
      value.ids.length !== selection.ids.length
    ) {
      wx.setStorageSync(CURRENT_MATERIAL_SELECTION_KEY, selection);
    }
    if (Array.isArray(wx.getStorageSync(CURRENT_MATERIALS_KEY))) {
      wx.removeStorageSync(CURRENT_MATERIALS_KEY);
    }
    return selection;
  }

  const selection = {
    sessionId: createId("materials"),
    revision: 0,
    ids: normalizeIds(readList<unknown>(CURRENT_MATERIALS_KEY)),
  };
  wx.setStorageSync(CURRENT_MATERIAL_SELECTION_KEY, selection);
  wx.removeStorageSync(CURRENT_MATERIALS_KEY);
  return selection;
}

export function getCurrentMaterialIds(): string[] {
  return readCurrentMaterialSelection().ids;
}

export function getCurrentMaterialSelection(): CurrentMaterialSelection {
  return readCurrentMaterialSelection();
}

export function getCurrentMaterialSessionId(): string {
  return readCurrentMaterialSelection().sessionId;
}

export function beginCurrentMaterialSelection(): string {
  const sessionId = createId("materials");
  wx.setStorageSync(CURRENT_MATERIAL_SELECTION_KEY, { sessionId, revision: 0, ids: [] });
  return sessionId;
}

export function restoreCurrentMaterialSelection(
  expectedSessionId: string,
  selection: CurrentMaterialSelection,
): boolean {
  if (readCurrentMaterialSelection().sessionId !== expectedSessionId) return false;
  let restoredSessionId = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = createId("materials");
    if (candidate !== expectedSessionId && candidate !== selection.sessionId) {
      restoredSessionId = candidate;
      break;
    }
  }
  if (!restoredSessionId) {
    throw new Error("无法创建新的素材恢复会话");
  }
  wx.setStorageSync(CURRENT_MATERIAL_SELECTION_KEY, {
    sessionId: restoredSessionId,
    revision: 0,
    ids: [...selection.ids],
  });
  return true;
}

export function updateCurrentMaterialIdsForSession(
  sessionId: string,
  update: (ids: string[]) => string[],
  expectedRevision?: number,
): CurrentMaterialSelection | undefined {
  const selection = readCurrentMaterialSelection();
  if (selection.sessionId !== sessionId) return undefined;
  if (expectedRevision !== undefined && selection.revision !== expectedRevision) {
    return undefined;
  }
  const next = {
    sessionId,
    revision: selection.revision + 1,
    ids: normalizeIds(update([...selection.ids])),
  };
  wx.setStorageSync(CURRENT_MATERIAL_SELECTION_KEY, next);
  return next;
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
