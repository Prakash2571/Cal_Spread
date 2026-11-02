/** Launch the actual Go App/Chi/PostgreSQL service with loopback-only fixture data. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const scratch = path.join(root, 'scratch', 'go-integration');
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export async function startGoFixture(frontendOrigin = 'http://127.0.0.1:5175') {
  await mkdir(scratch, { recursive: true });
  const backend = process.env.CALSPREAD_BACKEND_DIR || path.resolve(root, '../Cal_Spread_Backend');
  const binary = path.join(scratch, 'go-fixture');
  execFileSync(process.env.GO || 'go', ['build', '-race', '-trimpath', '-o', binary, './cmd/verifyfixture'], {
    cwd: backend, env: { ...process.env, GOTOOLCHAIN: 'local', GOTELEMETRY: 'off' }, stdio: 'inherit', timeout: 180000,
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(binary, ['-listen', `127.0.0.1:${port}`, '-frontend', frontendOrigin], {
    cwd: scratch, env: { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable',
      HOME: scratch, TMPDIR: scratch, TZ: 'Asia/Kolkata' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { log += data.toString(); });
  child.stderr.on('data', (data) => { log += data.toString(); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    const result = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Go fixture shutdown timeout')); }, 20000);
    })]).finally(() => clearTimeout(timer));
    if (result.code !== 0 || /DATA RACE/.test(log)) throw new Error(`Go fixture exited ${result.code ?? result.signal}\n${log}`);
  };
  try {
    for (let n = 0; n < 150; n++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Go fixture failed before listening\n${log}`);
      const response = await fetch(`${origin}/__fixture`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response?.ok) {
        const info = await response.json();
        if (response.ok && info.runtime === 'go-chi-postgres') {
          const request = async (method, endpoint, body, token, expected = 200) => {
            const response = await fetch(`${origin}${endpoint}`, { method, signal: AbortSignal.timeout(30000),
              headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'x-admin-token': token } : {}) },
              body: body === undefined ? undefined : JSON.stringify(body) });
            const text = await response.text();
            if (response.status !== expected) throw new Error(`${method} ${endpoint}: expected ${expected}, got ${response.status}: ${text}`);
            return text ? JSON.parse(text) : null;
          };
          const full = (await request('POST', '/api/admin/verify', { secret: 'loopback-fixture-admin' })).token;
          const trade = (await request('POST', '/api/access/verify', { secret: 'loopback-fixture-trade' })).token;
          await request('POST', '/api/session', { request_token: 'generated-loopback-request' }, full);
          await request('POST', '/api/rf', { rf: 5 }, full);
          const status = await request('GET', '/api/fair-value/status', undefined, full);
          if (!status.enabled) throw new Error(`Go fixture analytics is not configured: ${status.last_error}`);
          return { origin, info, full, trade, request, stop, getLog: () => log };
        }
      }
      await delay(100);
    }
    throw new Error(`Go fixture readiness timeout\n${log}`);
  } catch (error) {
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    throw new Error(`${error.message}\n${log}`, { cause: error });
  }
}
