import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { type WebRuntimeConfig, resolveWebRuntimeConfig } from "./src/runtime-config";

const CASE_001_MEDIA_HASHES = {
  "case-001-photo-crop.jpg": "e09c8091a6676398d81ba40cd28d11c2f598e846748cfe2a069a09666ee6706b",
  "case-001-audio.m4a": "f9ec48c022bc98d9cc5ac3ff061c65108fe4827ccd8aac9ef1aca15ff88ea4dc",
} as const;
// These are known outputs of the controlled-package builder. Semantic and
// media checks below still run, so formatting-only regeneration remains valid.
const CASE_001_DEMO_CASE_HASHES = new Set([
  "15486a762c5531fbd5ba51177f9dd66ddc1731c4fafc48bb29c2dfd629409e36",
  "179a804a6e68b933162471c44ebd633faea0420cb03b44437cebf3149ab9962e",
]);

type ControlledCase001BuildData = {
  title: string;
  provenanceLabel: string;
  photoFile: "case-001-photo-crop.jpg";
  audioFile: "case-001-audio.m4a";
  audioDurationSeconds: number;
  recommendedDraftBody: string;
  recommendedDraftParagraphs: Array<{
    sourceIds: Array<"case-001-audio" | "case-001-photo">;
    attributionLabel: string;
  }>;
};

const CONTROLLED_SOURCE_IDS = {
  voice: "case-001-audio",
  photo: "case-001-photo",
} as const;

type ControlledSourceRef = keyof typeof CONTROLLED_SOURCE_IDS;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`CASE-001 demo-case.json 缺少有效字段：${fieldName}`);
  }
  return value;
}

function requiredStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`CASE-001 demo-case.json 缺少有效字段：${fieldName}`);
  }
  return value.map((item) => item.trim());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = uniqueStrings(left).sort();
  const normalizedRight = uniqueStrings(right).sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function sourceIdsFromRefs(
  sourceRefs: string[],
  fieldName: string,
): Array<"case-001-audio" | "case-001-photo"> {
  return uniqueStrings(
    sourceRefs.map((sourceRef) => {
      if (!(sourceRef in CONTROLLED_SOURCE_IDS)) {
        throw new Error(`CASE-001 demo-case.json 包含未知素材引用：${fieldName}`);
      }
      return CONTROLLED_SOURCE_IDS[sourceRef as ControlledSourceRef];
    }),
  ) as Array<"case-001-audio" | "case-001-photo">;
}

function parseDraftParagraphEvidence(
  draft: Record<string, unknown>,
  evidenceById: Map<string, { sourceRefs: string[]; sourceLabel: string }>,
  draftLabel: string,
): ControlledCase001BuildData["recommendedDraftParagraphs"] {
  const bodyParts = requiredString(draft.body, `${draftLabel}.body`)
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (bodyParts.length < 3) {
    throw new Error(`CASE-001 demo-case.json 的 ${draftLabel} 缺少称呼、正文或署名`);
  }

  const paragraphEvidence = draft.paragraphEvidence;
  if (!Array.isArray(paragraphEvidence) || paragraphEvidence.length !== bodyParts.length - 2) {
    throw new Error(`CASE-001 demo-case.json 的 ${draftLabel} 段落依据数量不匹配`);
  }

  return paragraphEvidence.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`CASE-001 demo-case.json 的 ${draftLabel} 第 ${index + 1} 段依据条目无效`);
    }
    const evidenceIds = requiredStringArray(
      entry.evidenceIds,
      "drafts[].paragraphEvidence[].evidenceIds",
    );
    const declaredSourceRefs = requiredStringArray(
      entry.sourceRefs,
      "drafts[].paragraphEvidence[].sourceRefs",
    );
    const evidence = evidenceIds.map((evidenceId) => {
      const item = evidenceById.get(evidenceId);
      if (!item) {
        throw new Error(`CASE-001 demo-case.json 引用了未知证据：${evidenceId}`);
      }
      return item;
    });
    const derivedSourceRefs = uniqueStrings(evidence.flatMap((item) => item.sourceRefs));
    if (!sameStringSet(declaredSourceRefs, derivedSourceRefs)) {
      throw new Error(`CASE-001 demo-case.json 的 ${draftLabel} 第 ${index + 1} 段素材依据与证据映射不一致`);
    }
    return {
      sourceIds: sourceIdsFromRefs(
        declaredSourceRefs,
        "drafts[].paragraphEvidence[].sourceRefs",
      ),
      attributionLabel: `队友固定审核稿，依据：${uniqueStrings(
        evidence.map((item) => item.sourceLabel),
      ).join("；")}`,
    };
  });
}

function readControlledCase001BuildData(mediaDirectory: string): ControlledCase001BuildData {
  const dataPath = resolve(mediaDirectory, "..", "demo-case.json");
  if (!existsSync(dataPath) || !CASE_001_DEMO_CASE_HASHES.has(sha256(dataPath))) {
    throw new Error("CASE-001 受控审核稿校验失败：demo-case.json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(dataPath, "utf8"));
  } catch {
    throw new Error("CASE-001 demo-case.json 不是有效 JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("CASE-001 demo-case.json 必须是对象");
  }

  const recommendedDraftId = requiredString(parsed.recommendedDraftId, "recommendedDraftId");
  const drafts = parsed.drafts;
  if (!Array.isArray(drafts)) {
    throw new Error("CASE-001 demo-case.json 缺少 drafts 数组");
  }
  const draftRecords = drafts.map((draft, index) => {
    if (!isRecord(draft)) {
      throw new Error(`CASE-001 demo-case.json 的第 ${index + 1} 个审核稿无效`);
    }
    return draft;
  });
  const recommendedDraft = draftRecords.find((draft) => draft.id === recommendedDraftId);
  if (!recommendedDraft) {
    throw new Error("CASE-001 demo-case.json 缺少推荐审核稿正文");
  }
  if (
    parsed.caseId !== "NUANJIAN-CASE-001" ||
    parsed.mode !== "controlled-team" ||
    parsed.photoUrl !== "./media/case-001-photo-crop.jpg" ||
    parsed.audioUrl !== "./media/case-001-audio.m4a" ||
    typeof parsed.audioDurationSeconds !== "number" ||
    !Number.isFinite(parsed.audioDurationSeconds) ||
    parsed.audioDurationSeconds <= 0
  ) {
    throw new Error("CASE-001 demo-case.json 的受控素材元数据不符合预期");
  }

  const evidenceMap = parsed.evidenceMap;
  if (!Array.isArray(evidenceMap)) {
    throw new Error("CASE-001 demo-case.json 缺少 evidenceMap 数组");
  }
  const evidenceById = new Map<string, { sourceRefs: string[]; sourceLabel: string }>();
  for (const entry of evidenceMap) {
    if (!isRecord(entry)) {
      throw new Error("CASE-001 demo-case.json 的 evidenceMap 条目无效");
    }
    const evidenceId = requiredString(entry.id, "evidenceMap[].id");
    if (evidenceById.has(evidenceId)) {
      throw new Error(`CASE-001 demo-case.json 存在重复 evidence ID：${evidenceId}`);
    }
    evidenceById.set(evidenceId, {
      sourceRefs: requiredStringArray(entry.sourceRefs, "evidenceMap[].sourceRefs"),
      sourceLabel: requiredString(
        typeof entry.sourceLabel === "string" ? entry.sourceLabel : entry.source,
        "evidenceMap[].sourceLabel",
      ),
    });
  }

  const paragraphEvidenceByDraft = new Map<string, ControlledCase001BuildData["recommendedDraftParagraphs"]>();
  for (const draft of draftRecords) {
    const draftId = requiredString(draft.id, "drafts[].id");
    if (paragraphEvidenceByDraft.has(draftId)) {
      throw new Error(`CASE-001 demo-case.json 存在重复审核稿 ID：${draftId}`);
    }
    paragraphEvidenceByDraft.set(
      draftId,
      parseDraftParagraphEvidence(draft, evidenceById, `审核稿 ${draftId}`),
    );
  }
  const recommendedDraftParagraphs = paragraphEvidenceByDraft.get(recommendedDraftId);
  if (!recommendedDraftParagraphs) {
    throw new Error("CASE-001 demo-case.json 缺少推荐审核稿段落依据");
  }

  return {
    title: requiredString(parsed.title, "title"),
    provenanceLabel: requiredString(parsed.provenanceLabel, "provenanceLabel"),
    photoFile: "case-001-photo-crop.jpg",
    audioFile: "case-001-audio.m4a",
    audioDurationSeconds: parsed.audioDurationSeconds,
    recommendedDraftBody: requiredString(recommendedDraft.body, "drafts[].body"),
    recommendedDraftParagraphs,
  };
}

function resolveDemoPublicDirectory(
  runtimeConfig: WebRuntimeConfig,
  configuredMediaDirectory: string | undefined,
): { publicDir: false | string; controlledCase001: ControlledCase001BuildData | null } {
  if (!runtimeConfig.demoEnabled) return { publicDir: false, controlledCase001: null };
  if (runtimeConfig.demoCase === "synthetic") {
    return { publicDir: "../miniprogram/src/assets/demo", controlledCase001: null };
  }

  const directory = configuredMediaDirectory?.trim();
  if (!directory) {
    throw new Error(
      "受控 CASE-001 演示需要 WARM_LETTER_CASE_001_MEDIA_DIR 指向已核验包的 media 目录。",
    );
  }

  const resolvedDirectory = resolve(directory);
  if (!existsSync(resolvedDirectory) || !statSync(resolvedDirectory).isDirectory()) {
    throw new Error("WARM_LETTER_CASE_001_MEDIA_DIR 必须指向存在的 media 目录。");
  }

  const entries = readdirSync(resolvedDirectory).sort();
  const expectedEntries = Object.keys(CASE_001_MEDIA_HASHES).sort();
  if (
    entries.length !== expectedEntries.length ||
    entries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error("CASE-001 受控媒体目录只能包含已核验的照片和原始语音文件。");
  }

  for (const [fileName, expectedHash] of Object.entries(CASE_001_MEDIA_HASHES)) {
    const mediaPath = resolve(resolvedDirectory, fileName);
    if (!existsSync(mediaPath) || sha256(mediaPath) !== expectedHash) {
      throw new Error(`CASE-001 受控媒体校验失败：${fileName}`);
    }
  }

  return {
    publicDir: resolvedDirectory,
    controlledCase001: readControlledCase001BuildData(resolvedDirectory),
  };
}

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, process.cwd(), "");
  const runtimeConfig = resolveWebRuntimeConfig({
    appEnv: process.env.VITE_APP_ENV || loaded.VITE_APP_ENV,
    apiBaseUrl: process.env.VITE_API_BASE_URL || loaded.VITE_API_BASE_URL,
    demoEnabled: process.env.VITE_DEMO_ENABLED || loaded.VITE_DEMO_ENABLED,
    demoCase: process.env.VITE_DEMO_CASE || loaded.VITE_DEMO_CASE,
    expectedMode: mode,
  });
  const controlledDemo = resolveDemoPublicDirectory(
    runtimeConfig,
    process.env.WARM_LETTER_CASE_001_MEDIA_DIR || loaded.WARM_LETTER_CASE_001_MEDIA_DIR,
  );
  const configuredTempDirectory = process.env.WARM_LETTER_TMP_DIR?.trim();
  const viteCacheDirectory = configuredTempDirectory
    ? resolve(configuredTempDirectory, "vite-cache", "web")
    : undefined;

  return {
    define: {
      __WARM_LETTER_DEMO_BUILD__: JSON.stringify(runtimeConfig.demoEnabled),
      __WARM_LETTER_DEMO_CASE__: JSON.stringify(runtimeConfig.demoCase),
      __WARM_LETTER_CONTROLLED_CASE_001__: JSON.stringify(controlledDemo.controlledCase001),
    },
    plugins: [react()],
    publicDir: controlledDemo.publicDir,
    ...(viteCacheDirectory ? { cacheDir: viteCacheDirectory } : {}),
    server: {
      port: 4173,
    },
  };
});
