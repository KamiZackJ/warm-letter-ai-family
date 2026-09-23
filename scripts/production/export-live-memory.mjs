// Candidate one-time migration tool. Never expose the inspector port publicly.
// Requires the operator to enable the target inspector separately, then run this on that host.
import { parseArgs } from 'node:util';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'http://127.0.0.1:9229' },
  'service-module': { type: 'string' }, output: { type: 'string' },
  'expected-pid': { type: 'string' }, port: { type: 'string', default: '8787' },
  'close-listener': { type: 'boolean', default: false },
  'resume-only': { type: 'boolean', default: false },
}});
const endpoint = new URL(values.endpoint);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'http:') {
  throw new Error('Inspector endpoint must be loopback HTTP');
}
if ((!values['close-listener'] && !values['resume-only']) || !values['service-module'] || (!values['resume-only'] && (!values.output || !isAbsolute(values.output)))) {
  throw new Error('Required: --close-listener --service-module file:///.../service.js --output /private/absolute/file.json --expected-pid PID');
}
const expectedPid = Number(values['expected-pid']);
const port = Number(values.port);
if (!Number.isSafeInteger(expectedPid) || expectedPid < 1 || !Number.isSafeInteger(port) || port < 1) throw new Error('Invalid PID or port');
const serviceModule = new URL(values['service-module']);
if (serviceModule.protocol !== 'file:') throw new Error('Expected an existing local service module');
const targetList = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(5_000) }).then(response => response.json());
if (!Array.isArray(targetList) || targetList.length !== 1) throw new Error('Expected one local inspector target');
const websocketUrl = new URL(targetList[0].webSocketDebuggerUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(websocketUrl.hostname)) throw new Error('Inspector websocket is not loopback');
const socket = new WebSocket(websocketUrl);
await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const response = JSON.parse(String(event.data));
  if (!response.id) return;
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  clearTimeout(request.timer);
  if (response.error || response.result?.exceptionDetails) request.reject(new Error(`Inspector operation failed: ${request.method}`));
  else request.resolve(response.result);
});
function call(method, params = {}, timeout = 10_000) {
  return new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: resolveCall, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function queryInstances(expression) {
  const prototype = await call('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, objectGroup: 'warmletter-migration' });
  if (!prototype.result?.objectId) throw new Error('Missing prototype handle');
  const queried = await call('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'warmletter-migration' });
  if (!queried.objects?.objectId) throw new Error('Missing instance handle');
  return queried.objects.objectId;
}
let serviceObjects;
let serverObjects;
let listenerClosed = false;
let exportCompleted = false;
try {
  const pid = await call('Runtime.evaluate', { expression: 'process.pid', returnByValue: true });
  if (pid.result?.value !== expectedPid) throw new Error('Inspector PID mismatch');
  serviceObjects = await queryInstances(`process.getBuiltinModule('node:module').createRequire(${JSON.stringify(fileURLToPath(serviceModule))})(${JSON.stringify(fileURLToPath(serviceModule))}).WarmLetterService.prototype`);
  const readiness = await call('Runtime.callFunctionOn', {
    objectId: serviceObjects, returnByValue: true,
    functionDeclaration: `function () {
      if (this.length !== 1 || !(this[0].repository.users instanceof Map) || !(this[0].authSessions instanceof Map)) throw new Error('Unexpected service layout');
      return { services: this.length, jobs: this[0].repository.jobs.size };
    }`,
  });
  serverObjects = await queryInstances(`process.getBuiltinModule('node:http').Server.prototype`);
  if (values['resume-only']) {
    await call('Runtime.callFunctionOn', {
      objectId: serverObjects, arguments: [{ value: port }], awaitPromise: true, returnByValue: true,
      functionDeclaration: `async function (port) {
        if (this.length !== 1 || this[0].listening) throw new Error('Expected one quiesced server');
        await new Promise((resolve, reject) => { this[0].once('error', reject); this[0].listen(port, '127.0.0.1', resolve); });
        return true;
      }`,
    });
    console.log(JSON.stringify({ status: 'previous-listener-resumed', pid: expectedPid }));
  } else {
  // Stop accepting new requests without killing the in-memory process. Existing
  // HTTP requests drain; separate queued generation jobs are drained below.
  listenerClosed = true;
  await call('Runtime.callFunctionOn', {
    objectId: serverObjects, arguments: [{ value: port }], awaitPromise: true, returnByValue: true,
    functionDeclaration: `async function (port) {
      const servers = this.filter(server => server.listening && server.address()?.port === port);
      if (servers.length !== 1) throw new Error('Expected one API HTTP server');
      await new Promise((resolve, reject) => servers[0].close(error => error ? reject(error) : resolve()));
      return true;
    }`,
  }, 210_000);
  await call('Runtime.callFunctionOn', {
    objectId: serviceObjects, awaitPromise: true, returnByValue: true,
    functionDeclaration: `async function () {
      const repository = this[0].repository;
      const expiresAt = Date.now() + 180000;
      while ([...repository.jobs.values()].some(job => job.status === 'queued' || job.status === 'running')) {
        if (Date.now() >= expiresAt) throw new Error('Background jobs did not drain');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return true;
    }`,
  }, 185_000);
  const result = await call('Runtime.callFunctionOn', {
    objectId: serviceObjects, arguments: [{ value: resolve(values.output) }], awaitPromise: true, returnByValue: true,
    functionDeclaration: `async function (output) {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const service = this[0];
      const repository = service.repository;
      const exportedAt = new Date().toISOString();
      const snapshot = {
        schemaVersion: 1, exportedAt, pid: process.pid,
        users: [...repository.users.values()], materials: [...repository.materials.values()],
        materialRequests: [...repository.materialRequestsByIdempotencyKey.entries()],
        letters: [...repository.letters.values()], jobs: [...repository.jobs.values()],
        replies: [...repository.replies.values()], replyRequests: [...repository.replyRequestsByIdempotencyKey.entries()],
        shareAccess: [...repository.shareAccess.values()],
        authSessions: [...service.authSessions.entries()].map(([tokenHash, session]) => ({
          tokenHash, userId: session.userId, expiresAt: session.expiresAt,
          createdAt: Math.max(0, session.expiresAt - service.authSessionTtlMs),
        })),
      };
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(output, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(snapshot)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      return { exportedAt, counts: Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) };
    }`,
  });
  exportCompleted = true;
  console.log(JSON.stringify({ status: 'exported', listenerClosed: true, ...result.result.value }));
  // Deliberately leave the old API listener closed. Import and verify the DB,
  // preserve uploads, then start the new build. No source data is printed.
  }
} catch (error) {
  if (listenerClosed && !exportCompleted && serverObjects) {
    try {
      await call('Runtime.callFunctionOn', {
        objectId: serverObjects, arguments: [{ value: port }], awaitPromise: true, returnByValue: true,
        functionDeclaration: `async function (port) {
          if (this.length !== 1 || this[0].listening) throw new Error('Cannot safely reopen listener');
          await new Promise((resolve, reject) => { this[0].once('error', reject); this[0].listen(port, '127.0.0.1', resolve); });
          return true;
        }`,
      });
      console.error('Export failed; previous API listener reopened. Do not restart before a successful export.');
    } catch { console.error('Export failed; API listener requires operator recovery. Memory remains in the original process.'); }
  }
  throw error;
} finally {
  await call('Runtime.releaseObjectGroup', { objectGroup: 'warmletter-migration' }).catch(() => {});
  // The inspector itself is closed after this client disconnects.
  await call('Runtime.evaluate', { expression: "setTimeout(() => process.getBuiltinModule('node:inspector').close(), 250); true", returnByValue: true }).catch(() => {});
  socket.close();
  for (const request of pending.values()) clearTimeout(request.timer);
}
