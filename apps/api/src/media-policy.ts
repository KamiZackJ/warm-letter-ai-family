import { extname } from "node:path";
import type { MaterialType } from "./domain.js";
import { ApiError } from "./errors.js";

interface ContentTypePolicy {
  extensions: readonly string[];
  maximumBytes: number;
  hasValidSignature(bytes: Buffer): boolean;
}

export interface MediaUploadPolicy {
  contentType: string;
  extension: string;
  maximumBytes: number;
  hasValidSignature(bytes: Buffer): boolean;
}

const mebibyte = 1024 * 1024;

const contentTypePolicies: Record<string, ContentTypePolicy> = {
  "image/jpeg": {
    extensions: [".jpg", ".jpeg"],
    maximumBytes: 10 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  "image/png": {
    extensions: [".png"],
    maximumBytes: 10 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  "image/webp": {
    extensions: [".webp"],
    maximumBytes: 10 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP",
  },
  "audio/mpeg": {
    extensions: [".mp3"],
    maximumBytes: 25 * mebibyte,
    hasValidSignature: (bytes) =>
      (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0),
  },
  "audio/mp4": {
    extensions: [".m4a", ".mp4"],
    maximumBytes: 25 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp",
  },
  "audio/aac": {
    extensions: [".aac"],
    maximumBytes: 25 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf0) === 0xf0,
  },
  "audio/wav": {
    extensions: [".wav"],
    maximumBytes: 25 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WAVE",
  },
  "audio/ogg": {
    extensions: [".ogg"],
    maximumBytes: 25 * mebibyte,
    hasValidSignature: (bytes) =>
      bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "OggS",
  },
};

export const supportedMediaContentTypes = Object.keys(contentTypePolicies);

export function resolveMediaUploadPolicy(
  type: MaterialType,
  filename: string,
  requestedContentType: string | undefined,
): MediaUploadPolicy {
  if (type !== "photo" && type !== "screenshot" && type !== "audio") {
    throw new ApiError(400, "INVALID_MATERIAL_TYPE", "文字素材不需要上传二进制文件");
  }

  const normalizedName = filename.trim();
  if (!normalizedName || normalizedName.includes("/") || normalizedName.includes("\\")) {
    throw new ApiError(400, "INVALID_FILENAME", "文件名无效");
  }
  const extension = extname(normalizedName).toLowerCase();
  if (!extension) {
    throw new ApiError(400, "INVALID_FILE_EXTENSION", "文件必须包含受支持的扩展名");
  }

  const normalizedContentType = requestedContentType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const inferredContentType = Object.entries(contentTypePolicies).find(([, policy]) =>
    policy.extensions.includes(extension),
  )?.[0];
  const contentType = normalizedContentType || inferredContentType;
  if (!contentType) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "文件扩展名与 MIME 类型不匹配或不受支持");
  }
  const policy = contentTypePolicies[contentType];
  if (!policy || !policy.extensions.includes(extension)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "文件扩展名与 MIME 类型不匹配或不受支持");
  }
  const isImage = contentType.startsWith("image/");
  if ((type === "audio" && isImage) || (type !== "audio" && !isImage)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "素材类型与 MIME 类型不匹配");
  }

  return {
    contentType,
    extension,
    maximumBytes: policy.maximumBytes,
    hasValidSignature: policy.hasValidSignature,
  };
}

export function validateMediaBytes(
  bytes: Buffer,
  policy: MediaUploadPolicy,
  configuredMaximumBytes: number,
): void {
  if (bytes.length === 0) {
    throw new ApiError(400, "EMPTY_UPLOAD", "上传文件不能为空");
  }
  if (bytes.length > Math.min(policy.maximumBytes, configuredMaximumBytes)) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "上传文件超过大小限制");
  }
  if (!policy.hasValidSignature(bytes)) {
    throw new ApiError(415, "INVALID_MEDIA_CONTENT", "文件内容与声明的 MIME 类型不一致");
  }
}
