import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.env.WARM_LETTER_TMP_DIR || tmpdir());
const outDir = resolve(outputRoot, "warm-letter-web-production-bundle");
const relativeOutput = relative(outputRoot, outDir);
if (relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) {
  throw new Error("Production bundle output escaped the configured temporary directory");
}
rmSync(outDir, { recursive: true, force: true });

const viteBin = resolve(packageRoot, "node_modules/vite/bin/vite.js");
function runProductionBuild(environment, targetDirectory = outDir) {
  return spawnSync(
    process.execPath,
    [viteBin, "build", "--mode", "production", "--outDir", targetDirectory, "--emptyOutDir"],
    {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
    },
  });
}

const build = runProductionBuild({
      VITE_APP_ENV: "production",
      VITE_DEMO_ENABLED: "false",
      VITE_API_BASE_URL: "https://api.example.test/v1",
});
if (build.status !== 0) {
  process.stderr.write(build.stdout || "");
  process.stderr.write(build.stderr || "");
  process.exit(build.status || 1);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const files = filesUnder(outDir);
const relativeFiles = files.map((file) => relative(outDir, file).replaceAll("\\", "/"));
const forbiddenFiles = relativeFiles.filter(
  (file) =>
    file.startsWith("samples/") ||
    file.startsWith("assets/demo/") ||
    file.includes("synthetic-cooking-demo") ||
    file.includes("synthetic-voice-demo"),
);
if (forbiddenFiles.length > 0) {
  throw new Error(`Production bundle contains demo files: ${forbiddenFiles.join(", ")}`);
}

const bundleText = files
  .filter((file) => /\.(?:html|css|js|json|map)$/i.test(file))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const forbiddenSentinels = [
  "demo-letter",
  "demo-ai",
  "demo-reply",
  "synthetic-cooking-demo",
  "synthetic-voice-demo",
  "第一次做你常做的番茄炒蛋",
  "合成演示图：周末做饭",
  "演示回复已保存在本页",
  "刷新页面后会消失",
];
const foundSentinels = forbiddenSentinels.filter((sentinel) => bundleText.includes(sentinel));
if (foundSentinels.length > 0) {
  throw new Error(`Production bundle contains demo sentinels: ${foundSentinels.join(", ")}`);
}

const forbiddenAssetHashes = new Set([
  "92eadfcce54996f5b56acf8db50f06e3a77a4d17a96fa1467f7bfebef576705c",
  "62253b93103723db78a22ae87c51485bff25b1eada3585ebbec528ad6a903b7f",
]);
const matchingHashes = files
  .map((file) => ({
    file,
    hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }))
  .filter(({ hash }) => forbiddenAssetHashes.has(hash))
  .map(({ file }) => relative(outDir, file).replaceAll("\\", "/"));
if (matchingHashes.length > 0) {
  throw new Error(`Production bundle contains demo asset bytes: ${matchingHashes.join(", ")}`);
}
if (!bundleText.includes("https://api.example.test/v1") || !bundleText.includes("生产环境")) {
  throw new Error("Production bundle is missing its explicit API URL or environment label");
}
if (!existsSync(join(outDir, "index.html"))) {
  throw new Error("Production bundle did not produce index.html");
}

const invalidProfiles = [
  {
    name: "missing API URL",
    environment: {
      VITE_APP_ENV: "production",
      VITE_DEMO_ENABLED: "false",
      VITE_API_BASE_URL: " ",
    },
  },
  {
    name: "loopback HTTP API",
    environment: {
      VITE_APP_ENV: "production",
      VITE_DEMO_ENABLED: "false",
      VITE_API_BASE_URL: "http://127.0.0.1:8787/v1",
    },
  },
  {
    name: "demo data enabled",
    environment: {
      VITE_APP_ENV: "production",
      VITE_DEMO_ENABLED: "true",
      VITE_API_BASE_URL: "https://api.example.test/v1",
    },
  },
  {
    name: "mode mismatch",
    environment: {
      VITE_APP_ENV: "demo",
      VITE_DEMO_ENABLED: "true",
      VITE_API_BASE_URL: "http://127.0.0.1:8787/v1",
    },
  },
];
for (const profile of invalidProfiles) {
  const invalidOutDir = resolve(outputRoot, `warm-letter-web-invalid-${profile.name.replaceAll(" ", "-")}`);
  rmSync(invalidOutDir, { recursive: true, force: true });
  const invalidBuild = runProductionBuild(profile.environment, invalidOutDir);
  rmSync(invalidOutDir, { recursive: true, force: true });
  if (invalidBuild.status === 0) {
    throw new Error(`Production build accepted invalid profile: ${profile.name}`);
  }
}

process.stdout.write(`Verified production bundle: ${outDir}\n`);
