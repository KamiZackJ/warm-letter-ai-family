import type { Material } from "../types/domain";
import { createId } from "../utils/id";

export const DEMO_MEDIA_PATHS = {
  photo: "/assets/demo/synthetic-cooking-demo.png",
  voice: "/assets/demo/synthetic-voice-demo.wav",
} as const;

export function createDemoMaterials(now = new Date().toISOString()): Material[] {
  return [
    {
      id: createId("photo"),
      type: "photo",
      name: "合成演示图：周末做饭",
      localPath: DEMO_MEDIA_PATHS.photo,
      createdAt: now,
    },
    {
      id: createId("voice"),
      type: "voice",
      name: "系统合成演示语音",
      localPath: DEMO_MEDIA_PATHS.voice,
      durationSeconds: 12,
      createdAt: now,
    },
    {
      id: createId("text"),
      type: "text",
      name: "最近的小事",
      text: "周末第一次学会了你常做的番茄炒蛋。工作虽然忙，但我每天都有按时吃饭。",
      createdAt: now,
    },
  ];
}
