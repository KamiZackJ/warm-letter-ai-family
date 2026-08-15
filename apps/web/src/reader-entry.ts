import type { WebRuntimeConfig } from "./runtime-config";

export type ShareParams = {
  letterId: string | null;
  shareToken: string | null;
  cameFromQuery: boolean;
};

export type ReaderEntry =
  | { kind: "demo" }
  | { kind: "remote"; letterId: string; shareToken: string }
  | { kind: "error"; title: string; detail: string };

export function resolveReaderEntry(
  config: Pick<WebRuntimeConfig, "demoEnabled">,
  params: ShareParams,
): ReaderEntry {
  if (params.letterId && params.shareToken) {
    return { kind: "remote", letterId: params.letterId, shareToken: params.shareToken };
  }
  if (params.letterId || params.shareToken) {
    return {
      kind: "error",
      title: "读信链接不完整",
      detail: "请重新打开寄信人分享的完整链接。",
    };
  }
  if (config.demoEnabled) return { kind: "demo" };
  return {
    kind: "error",
    title: "缺少读信链接",
    detail: "当前环境不会自动展示演示家书，请打开寄信人分享的完整链接。",
  };
}
