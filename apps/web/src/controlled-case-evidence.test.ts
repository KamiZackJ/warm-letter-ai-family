import { describe, expect, it } from "vitest";

type FileSystemModule = {
  readFileSync(path: string, encoding: "utf8"): string;
};

type EvidenceLink = {
  evidenceIds: string[];
  sourceRefs: string[];
};

type ControlledDraft = {
  id: string;
  body: string;
  paragraphEvidence: EvidenceLink[];
};

type ControlledCase = {
  drafts: ControlledDraft[];
  evidenceMap: Array<{ id: string; sourceRefs: string[] }>;
};

const runtimeProcess = (globalThis as unknown as {
  process: {
    cwd(): string;
    getBuiltinModule(name: string): unknown;
  };
}).process;
const fileSystem = runtimeProcess.getBuiltinModule("node:fs") as FileSystemModule;
const workingDirectory = runtimeProcess.cwd().replace(/\\/g, "/");
const repositoryRoot = workingDirectory.endsWith("/apps/web")
  ? `${workingDirectory}/../..`
  : workingDirectory;
const demoSource = fileSystem.readFileSync(
  `${repositoryRoot}/docs/product-demo/demo-case.js`,
  "utf8",
);

function loadControlledCase(): ControlledCase {
  const windowObject: { WARM_LETTER_DEMO_CASE?: ControlledCase } = {};
  new Function("window", demoSource)(windowObject);
  if (!windowObject.WARM_LETTER_DEMO_CASE) {
    throw new Error("demo-case.js did not expose WARM_LETTER_DEMO_CASE");
  }
  return windowObject.WARM_LETTER_DEMO_CASE;
}

describe("controlled CASE-001 evidence coverage", () => {
  it("keeps every reviewed body paragraph mapped to the exact evidence", () => {
    const controlledCase = loadControlledCase();
    const expectedEvidenceIds: Record<string, string[][]> = {
      A: [["evidence-01", "evidence-02", "evidence-03", "evidence-04"]],
      B: [
        ["evidence-01", "evidence-02", "evidence-03", "evidence-04"],
        ["evidence-02", "evidence-03"],
      ],
      C: [
        ["evidence-01", "evidence-02", "evidence-03", "evidence-04"],
        ["evidence-02", "evidence-03"],
      ],
    };
    const expectedSourceRefs: Record<string, string[][]> = {
      A: [["voice", "photo"]],
      B: [
        ["voice", "photo"],
        ["voice"],
      ],
      C: [
        ["voice", "photo"],
        ["voice"],
      ],
    };
    const evidenceById = new Map(
      controlledCase.evidenceMap.map((entry) => [entry.id, entry]),
    );

    for (const draft of controlledCase.drafts) {
      const bodyBlocks = draft.body
        .trim()
        .split(/\r?\n\s*\r?\n/)
        .map((block) => block.trim())
        .filter(Boolean);
      expect(draft.paragraphEvidence).toHaveLength(bodyBlocks.length - 2);
      expect(draft.paragraphEvidence.map((entry) => entry.evidenceIds)).toEqual(
        expectedEvidenceIds[draft.id],
      );
      expect(draft.paragraphEvidence.map((entry) => entry.sourceRefs)).toEqual(
        expectedSourceRefs[draft.id],
      );

      for (const entry of draft.paragraphEvidence) {
        const derivedSourceRefs = [
          ...new Set(
            entry.evidenceIds.flatMap((evidenceId) => {
              const evidence = evidenceById.get(evidenceId);
              if (!evidence) throw new Error(`Unknown evidence ID: ${evidenceId}`);
              return evidence.sourceRefs;
            }),
          ),
        ];
        expect(derivedSourceRefs).toEqual([...new Set(entry.sourceRefs)]);
      }
    }
  });
});
