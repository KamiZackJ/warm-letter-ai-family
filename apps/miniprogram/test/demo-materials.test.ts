import { describe, expect, it } from "vitest";
import { createDemoMaterials, DEMO_MEDIA_PATHS } from "../src/config/demo-materials";

type FileSystemModule = {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8"): string;
};

type CryptoModule = {
  createHash(algorithm: "sha256"): {
    update(data: Uint8Array): { digest(encoding: "hex"): string };
  };
};

const runtimeProcess = (globalThis as unknown as {
  process: {
    cwd(): string;
    getBuiltinModule(name: string): unknown;
  };
}).process;
const fileSystem = runtimeProcess.getBuiltinModule("node:fs") as FileSystemModule;
const nodeCrypto = runtimeProcess.getBuiltinModule("node:crypto") as CryptoModule;
const normalizedWorkingDirectory = runtimeProcess.cwd().replace(/\\/g, "/");
const demoAssetDirectory = normalizedWorkingDirectory.endsWith("/apps/miniprogram")
  ? `${normalizedWorkingDirectory}/src/assets/demo`
  : `${normalizedWorkingDirectory}/apps/miniprogram/src/assets/demo`;
const documentedAssets = [
  {
    filename: "synthetic-cooking-demo.png",
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    sha256: "92EADFCCE54996F5B56ACF8DB50F06E3A77A4D17A96FA1467F7BFEBEF576705C",
  },
  {
    filename: "synthetic-voice-demo.wav",
    magic: [0x52, 0x49, 0x46, 0x46],
    trailingMagic: { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] },
    sha256: "62253B93103723DB78A22AE87C51485BFF25B1EADA3585EBBEC528AD6A903B7F",
  },
] as const;

describe("demo materials", () => {
  it("uses real packaged files for image and voice materials", () => {
    const materials = createDemoMaterials("2026-08-15T12:00:00.000Z");
    const photo = materials.find((item) => item.type === "photo");
    const voice = materials.find((item) => item.type === "voice");

    expect(photo?.localPath).toBe(DEMO_MEDIA_PATHS.photo);
    expect(photo?.localPath).toMatch(/\.png$/);
    expect(voice?.localPath).toBe(DEMO_MEDIA_PATHS.voice);
    expect(voice?.localPath).toMatch(/\.wav$/);
    expect(voice?.durationSeconds).toBeGreaterThan(0);
  });

  it("labels every synthetic media asset as demo material", () => {
    const materials = createDemoMaterials("2026-08-15T12:00:00.000Z");
    expect(materials[0]?.name).toContain("演示");
    expect(materials[1]?.name).toContain("演示");
  });

  it.each(documentedAssets)(
    "packages a non-empty $filename with the documented signature and SHA-256",
    ({ filename, magic, sha256, ...asset }) => {
      const assetPath = `${demoAssetDirectory}/${filename}`;
      expect(fileSystem.existsSync(assetPath)).toBe(true);

      const contents = fileSystem.readFileSync(assetPath);
      expect(contents.byteLength).toBeGreaterThan(0);
      expect(Array.from(contents.slice(0, magic.length))).toEqual([...magic]);
      if ("trailingMagic" in asset) {
        const { offset, bytes } = asset.trailingMagic;
        expect(Array.from(contents.slice(offset, offset + bytes.length))).toEqual([...bytes]);
      }

      const digest = nodeCrypto.createHash("sha256").update(contents).digest("hex").toUpperCase();
      expect(digest).toBe(sha256);

      const readme = fileSystem.readFileSync(`${demoAssetDirectory}/README.md`, "utf8");
      const documentedLine = readme
        .split(/\r?\n/)
        .find((line) => line.includes(`\`${filename}\``));
      expect(documentedLine).toContain(`\`${sha256}\``);
    },
  );
});
