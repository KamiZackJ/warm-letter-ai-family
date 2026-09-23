import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const children: ChildProcess[] = [];
const directories: string[] = [];
const exporter = fileURLToPath(new URL("../../../scripts/production/export-live-memory.mjs", import.meta.url));

async function fixture(): Promise<{ child: ChildProcess; directory: string; port: number; inspectorPort: number; module: string }> {
  const root = process.platform === "win32" ? "D:/tmp/warm-letter-ai-family" : tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "migration-lifecycle-"));
  directories.push(directory);
  const module = join(directory, "service.mjs");
  await writeFile(module, `export class WarmLetterService {
    constructor() {
      this.repository = Object.fromEntries(['users', 'materials', 'materialRequestsByIdempotencyKey',
        'letters', 'jobs', 'replies', 'replyRequestsByIdempotencyKey', 'shareAccess'].map(key => [key, new Map()]));
      this.repository.users.set('u1', {id:'u1',openId:'synthetic',displayName:'fixture',createdAt:'2026-09-23T00:00:00Z'});
      this.authSessions = new Map(); this.authSessionTtlMs = 10000;
    }
  }`);
  await writeFile(join(directory, "server.mjs"), `import {createServer} from 'node:http';
    import {WarmLetterService} from './service.mjs';
    const service = new WarmLetterService();
    const server = createServer((req,res) => res.end(String(service.repository.users.size)));
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({port:server.address().port})));
    process.on('message', () => {
      const inspector = process.getBuiltinModule('node:inspector');
      if (!inspector.url()) inspector.open(0, '127.0.0.1');
      process.send({inspectorPort:Number(new URL(inspector.url()).port)});
    });
    // IPC is only a test control channel, never a hidden keepalive. No interval,
    // socket or queued job keeps this process alive after the HTTP server closes.
    process.channel.unref();
  `);
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", join(directory, "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let output = "";
  let errors = "";
  const ready = await new Promise<{ port: number; inspectorPort: number }>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture startup timeout")), 5_000);
    const check = () => {
      const inspector = errors.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      const port = output.match(/"port":(\d+)/);
      if (inspector && port) { clearTimeout(timer); resolveReady({ port: Number(port[1]), inspectorPort: Number(inspector[1]) }); }
    };
    child.stdout!.on("data", chunk => { output += String(chunk); check(); });
    child.stderr!.on("data", chunk => { errors += String(chunk); check(); });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Fixture exited before ready")));
  });
  return { child, directory, module, ...ready };
}

async function execute(f: Awaited<ReturnType<typeof fixture>>, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [exporter,
    "--endpoint", `http://127.0.0.1:${f.inspectorPort}`, "--service-module", pathToFileURL(f.module).href,
    "--expected-pid", String(f.child.pid), "--port", String(f.port), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

async function reopenInspector(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const message = once(f.child, "message");
  f.child.send("inspect");
  const [result] = await message;
  f.inspectorPort = result.inspectorPort;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("live memory export lifecycle", () => {
  it("exports after closing the final referenced socket, stays alive after inspector closes, and resumes", async () => {
    const f = await fixture();
    const output = join(f.directory, "snapshot.json");
    const exported = await execute(f, ["--close-listener", "--output", output]);
    expect(exported.code, exported.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).users).toHaveLength(1);
    // Exporter closes its own websocket immediately; its target inspector closes
    // 250ms later. The old process must remain recoverable after both are gone.
    await new Promise(resolveWait => setTimeout(resolveWait, 400));
    expect(f.child.exitCode).toBeNull();
    expect(f.child.signalCode).toBeNull();
    expect(() => process.kill(f.child.pid!, 0)).not.toThrow();
    await reopenInspector(f);
    const resumed = await execute(f, ["--resume-only"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(await fetch(`http://127.0.0.1:${f.port}`).then(response => response.text())).toBe("1");
  }, 15_000);

  it("keeps the old process and reopens HTTP when snapshot creation fails", async () => {
    const f = await fixture();
    const output = join(f.directory, "existing.json");
    await writeFile(output, "must not overwrite");
    const result = await execute(f, ["--close-listener", "--output", output]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("previous API listener reopened");
    await new Promise(resolveWait => setTimeout(resolveWait, 400));
    expect(f.child.exitCode).toBeNull();
    expect(await fetch(`http://127.0.0.1:${f.port}`).then(response => response.text())).toBe("1");
    expect(await readFile(output, "utf8")).toBe("must not overwrite");
  }, 15_000);
});
