declare const __WARM_LETTER_DEMO_BUILD__: boolean;
declare const __WARM_LETTER_DEMO_CASE__: "synthetic" | "case-001";

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

declare const __WARM_LETTER_CONTROLLED_CASE_001__: ControlledCase001BuildData | null;
