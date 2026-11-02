/** Dependency-free W3C WebDriver/BiDi client for locally installed Firefox. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { freePort, delay } from './go_backend_fixture.mjs';

export async function startFirefox(directory) {
  for (const name of ['home', 'cache', 'tmp', 'profile', 'downloads']) await mkdir(path.join(directory, name), { recursive: true });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let log = '', sessionId, socket, context, sequence = 0;
  const pending = new Map(), requests = [], errors = [];
  const driver = spawn(process.env.GECKODRIVER_BIN || 'geckodriver', ['--host', '127.0.0.1', '--port', String(port)], {
    cwd: directory, env: { ...process.env, HOME: path.join(directory, 'home'), XDG_CACHE_HOME: path.join(directory, 'cache'),
      TMPDIR: path.join(directory, 'tmp'), MOZ_HEADLESS: '1', MOZ_CRASHREPORTER_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  driver.stdout.on('data', (data) => { log += data.toString(); });
  driver.stderr.on('data', (data) => { log += data.toString(); });
  let spawnError;
  driver.once('error', (error) => { spawnError = error; });
  const command = async (method, endpoint, body) => {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(`${endpoint}: ${JSON.stringify(result)}`);
    return result.value;
  };
  const wd = (method, endpoint, body) => command(method, `/session/${sessionId}${endpoint}`, body);
  const js = (script, args = []) => wd('POST', '/execute/sync', { script, args });
  const bidi = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`BiDi timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const stop = async () => {
    if (sessionId) await command('DELETE', `/session/${sessionId}`).catch(() => undefined);
    socket?.close();
    for (const item of pending.values()) clearTimeout(item.timer);
    driver.kill('SIGTERM');
  };
  try {
    for (let n = 0; n < 80; n++) {
      if (spawnError) throw spawnError;
      try { await command('GET', '/status'); break; }
      catch (error) { if (n === 79) throw error; await delay(100); }
    }
    const session = await command('POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'firefox', webSocketUrl: true,
      'moz:firefoxOptions': { binary: process.env.FIREFOX_BIN || '/usr/bin/firefox',
        args: ['-headless', '-profile', path.join(directory, 'profile')], prefs: {
          'browser.shell.checkDefaultBrowser': false, 'browser.startup.page': 0,
          'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false,
          'browser.newtabpage.enabled': false, 'network.captive-portal-service.enabled': false,
          'network.connectivity-service.enabled': false, 'network.proxy.type': 1,
          'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 9,
          'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9,
          'network.proxy.no_proxies_on': '127.0.0.1,localhost',
          'browser.download.folderList': 2, 'browser.download.dir': path.join(directory, 'downloads'),
          'browser.download.useDownloadDir': true, 'browser.download.alwaysOpenPanel': false,
          'browser.helperApps.neverAsk.saveToDisk': 'application/json',
        } },
    } } });
    sessionId = session.sessionId;
    socket = new WebSocket(session.capabilities.webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'log.entryAdded' && message.params.level === 'error' && message.params.type === 'javascript') {
        errors.push(message.params.text.replace(/([?&]x-admin-token=)[^\s.)]+/g, '$1<fixture-token>'));
      }
      if (message.method === 'network.beforeRequestSent') {
        const url = new URL(message.params.request.url);
        requests.push({ origin: url.origin, path: url.pathname });
      }
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.type === 'error') item.reject(new Error(JSON.stringify(message)));
      else item.resolve(message.result);
    });
    context = (await bidi('browsingContext.getTree', {})).contexts[0].context;
    await bidi('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
    await bidi('script.addPreloadScript', { functionDeclaration: `() => {
      window.__verificationErrors = [];
      window.addEventListener('error', (event) => window.__verificationErrors.push(event.message));
      window.addEventListener('unhandledrejection', (event) => window.__verificationErrors.push(String(event.reason)));
      window.__verificationStreams = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          const state = { path: new URL(args[0], location.href).pathname, opened: false, frames: 0 };
          window.__verificationStreams.push(state);
          this.addEventListener('open', () => { state.opened = true; });
          for (const event of ['snapshot', 'status', 'tick']) this.addEventListener(event, () => { state.frames++; });
        }
      };
    }` });
    const wait = async (expression, milliseconds = 20000) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        if (await js(`return !!(${expression})`)) return;
        await delay(100);
      }
      throw new Error(`Browser timed out: ${expression}\n${await js('return document.body.innerText')}`);
    };
    const clickElement = async (script, args) => {
      const end = Date.now() + 20000;
      while (!(await js(`const el = (() => { ${script} })(); return !!el && !el.disabled;`, args))) {
        if (Date.now() > end) throw new Error(`Browser control stayed unavailable: ${script}`);
        await delay(100);
      }
      const element = await js(script, args);
      assert.ok(element, `Missing browser control: ${script}`);
      await wd('POST', `/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    };
    return {
      js, wait, wd, requests, errors, stop, version: session.capabilities.browserVersion,
      goto: (url) => wd('POST', '/url', { url }),
      click: (selector) => clickElement('return document.querySelector(arguments[0])', [selector]),
      button: (text, prefix = false) => clickElement(`return [...document.querySelectorAll('button,a,summary')].find((e) =>
        arguments[1] ? e.textContent.trim().startsWith(arguments[0]) : e.textContent.trim() === arguments[0])`, [text, prefix]),
      fill: (selector, value) => js(`const el = document.querySelector(arguments[0]);
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, arguments[1]);
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;`, [selector, value]),
      resize: async (width, height) => {
        await wd('POST', '/window/rect', { width: Math.max(width, 500), height });
        await bidi('browsingContext.setViewport', { context, viewport: { width, height }, devicePixelRatio: 1 });
      },
      screenshot: async (name) => {
        const data = await wd('GET', '/moz/screenshot/full');
        await writeFile(path.join(directory, `${name}.png`), Buffer.from(data, 'base64'));
      },
      getLog: () => log,
    };
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${log}`, { cause: error });
  }
}
