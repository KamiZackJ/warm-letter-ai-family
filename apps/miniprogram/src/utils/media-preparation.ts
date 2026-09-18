export type ImagePreparationKind = "photo" | "screenshot";

type CompressImageResult = { tempFilePath?: string };

/**
 * Reduce camera-sized images before they enter the upload and vision pipeline.
 * A failed/unsupported compression call deliberately falls back to the source
 * path; the server remains the final MIME and byte-size gate.
 */
export function prepareImageForUpload(
  sourcePath: string,
  kind: ImagePreparationKind,
): Promise<string> {
  if (
    !sourcePath ||
    typeof wx === "undefined" ||
    typeof wx.compressImage !== "function"
  ) {
    return Promise.resolve(sourcePath);
  }

  const quality = kind === "screenshot" ? 86 : 78;
  const maxDimension = kind === "screenshot" ? 2048 : 1600;
  return new Promise((resolve) => {
    try {
      wx.compressImage({
        src: sourcePath,
        quality,
        compressedWidth: maxDimension,
        compressedHeight: maxDimension,
        success: (result: CompressImageResult) => resolve(result.tempFilePath || sourcePath),
        fail: () => resolve(sourcePath),
      });
    } catch {
      resolve(sourcePath);
    }
  });
}
