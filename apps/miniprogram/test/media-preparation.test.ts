import { describe, expect, it, vi } from "vitest";
import { prepareImageForUpload } from "../src/utils/media-preparation";

describe("image preparation", () => {
  it("resizes ordinary photos before upload", async () => {
    const compressImage = vi.fn((options: { success: (result: { tempFilePath: string }) => void }) => {
      options.success({ tempFilePath: "wxfile://compressed-photo.jpg" });
    });
    (globalThis as { wx?: unknown }).wx = { compressImage };

    await expect(prepareImageForUpload("wxfile://camera-photo.jpg", "photo")).resolves.toBe(
      "wxfile://compressed-photo.jpg",
    );
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 78, compressedWidth: 1600, compressedHeight: 1600 }),
    );
  });

  it("keeps screenshots legible and falls back when compression is unavailable", async () => {
    const compressImage = vi.fn((options: { fail: () => void }) => options.fail());
    (globalThis as { wx?: unknown }).wx = { compressImage };

    await expect(prepareImageForUpload("wxfile://screen.png", "screenshot")).resolves.toBe(
      "wxfile://screen.png",
    );
    expect(compressImage).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 86, compressedWidth: 2048, compressedHeight: 2048 }),
    );
  });
});
