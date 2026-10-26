#!/usr/bin/env node
/**
 * End-to-end verification for the OLAP Object Explorer.
 *
 *   node tools/verify.mjs
 *
 * Four phases, all against the REAL engine at 127.0.0.1:8080 (start it first in
 * your own terminal with start-engine.cmd):
 *
 *   1. typecheck + production build
 *   2. pure unit tests for the hierarchy folder (memberTree.ts), including empty input
 *   3. live data checks: the app's own discovery layer, bundled with esbuild and run
 *      from Node against the engine (Node calls the engine directly; no CORS involved)
 *   4. a real headless-Chrome walkthrough of the built UI driven over the Chrome
 *      DevTools Protocol: expand, select, preview, nest members, SQL console,
 *      error state. Screenshots land in docs/screenshots/.
 *
 * Everything it spawns (the Vite preview server, headless Chrome) is a child of
 * this one process and is killed before it exits. It does not leave a server
 * running: that rule exists so long-lived shared servers are started by the user,
 * and this script is a self-contained test run, not a server.
 *
 * Exit code 0 = every check passed.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_DIR = path.join(ROOT, '.verify');
const SHOTS_DIR = path.join(ROOT, 'docs', 'screenshots');
const PREVIEW_PORT = Number(process.env.VERIFY_PORT ?? 5199);
const CDP_PORT = Number(process.env.VERIFY_CDP_PORT ?? 9333);
const AUTH_PORT = Number(process.env.VERIFY_AUTH_PORT ?? 8097);
const ENGINE = (process.env.OLAP_ENGINE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const AUTH_USER = 'verifier';
const AUTH_PASSWORD = 'verify-pass';
/** The seeded reference database; never written, only copied for the auth engine.
 *  Override with OLAP_ENGINE_DB when the engine tree lives somewhere else. */
const REFERENCE_DB =
  process.env.OLAP_ENGINE_DB ?? path.join(ROOT, '..', 'Patricia', 'olap_engine', 'database.bin');

const failures = [];
let checks = 0;

function pass(name, detail = '') {
  checks += 1;
  console.log(`  PASS  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

function fail(name, error) {
  checks += 1;
  const message = error instanceof Error ? error.message : String(error);
  failures.push({ name, message });
  console.log(`  FAIL  ${name}\n        ${message.split('\n').join('\n        ')}`);
}

async function checkAsync(name, work) {
  try {
    const detail = await work();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    fail(name, error);
  }
}

function check(name, work) {
  try {
    const detail = work();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    fail(name, error);
  }
}

// --------------------------------------------------------------- process utils

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* best effort */
  }
}

async function fetchWithTimeout(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpOk(url, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, 1500);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`${description}: timed out waiting for ${url} (${lastError?.message ?? 'no response'})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows can briefly hold a file that another process just read (antivirus,
 * thumbnailers, the image viewer). Retry rather than fail a good check.
 */
function writeFileWithRetry(filePath, data, attempts = 8) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      writeFileSync(filePath, data);
      return;
    } catch (error) {
      lastError = error;
      // Blocking sleep: this runs between browser steps, and it is simpler than
      // making every screenshot call async-retry aware.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  throw lastError;
}

// ------------------------------------------------------------------- CDP client

class Cdp {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`CDP socket failed: ${this.url}`)), {
        once: true,
      });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  onEvent(listener) {
    this.listeners.push(listener);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* best effort */
    }
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter((candidate) => candidate !== undefined && candidate !== '');
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function launchChrome() {
  const chrome = findChrome();
  if (chrome === null) throw new Error('No Chrome/Edge found; set CHROME_PATH to a Chromium binary.');

  const profileDir = path.join(VERIFY_DIR, 'chrome-profile');
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--hide-scrollbars',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1560,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetchWithTimeout(`http://127.0.0.1:${CDP_PORT}/json/list`, 1200);
        if (response.ok) {
          const targets = await response.json();
          const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
          if (page) return { child, webSocketUrl: page.webSocketDebuggerUrl };
        }
      } catch {
        /* keep polling */
      }
      await sleep(150);
    }
    throw new Error('Headless Chrome did not expose a debuggable page target.');
  } catch (error) {
    killTree(child);
    throw error;
  }
}

// ------------------------------------------------------------------- UI helpers

function createPageDriver(cdp) {
  const pageErrors = [];

  cdp.onEvent((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails;
      pageErrors.push(`page exception: ${details?.exception?.description ?? details?.text ?? 'unknown'}`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      pageErrors.push(`console.error: ${text}`);
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      const entry = message.params.entry;
      const text = entry.text ?? '';
      const url = entry.url ?? '';
      // A 401 is expected auth negotiation (wrong password, expired session), not
      // an application error; Chrome logs every failed resource fetch.
      if (
        !/favicon/i.test(text) &&
        !/favicon/i.test(url) &&
        !/status of 401/.test(text) &&
        !/net::ERR_/.test(text)
      ) {
        pageErrors.push(`log error: ${text}${url === '' ? '' : ` (${url})`}`);
      }
    }
  });

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Page evaluation threw: ${result.exceptionDetails.text ?? 'unknown'}`);
    }
    return result.result?.value;
  };

  return {
    pageErrors,
    evaluate,
    async navigate(url) {
      await cdp.send('Page.navigate', { url });
      await this.waitFor(`document.readyState === 'complete'`, 'page load', 20_000);
    },
    async waitFor(expression, description, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return;
        } catch (error) {
          lastError = error;
        }
        await sleep(120);
      }
      throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
    },
    async click(selector) {
      const clicked = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`No element matches ${selector}`);
    },
    async text(selector) {
      return evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`);
    },
    async count(selector) {
      return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    },
    async bodyText() {
      return evaluate('document.body.innerText');
    },
    async screenshot(fileName) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileWithRetry(path.join(SHOTS_DIR, fileName), Buffer.from(shot.data, 'base64'));
      return fileName;
    },
  };
}

async function setTextareaValue(page, selector, value) {
  const applied = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!applied) throw new Error(`No textarea matches ${selector}`);
}

// ------------------------------------------------------------------ phase 1

async function phaseBuild() {
  console.log('\n[1/5] Typecheck and build');
  await checkAsync('typecheck (tsc --noEmit)', async () => {
    const node = process.execPath;
    await run(node, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
    return 'clean';
  });
  await checkAsync('production build (vite build)', async () => {
    const node = process.execPath;
    await run(node, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
    return 'dist/ written';
  });
}

// ------------------------------------------------------------------ phase 2

async function bundle(entryRelative, outName) {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(ROOT, entryRelative)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: path.join(VERIFY_DIR, outName),
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(path.join(VERIFY_DIR, outName)).href}?t=${Date.now()}`);
}

async function phaseUnit() {
  console.log('\n[2/5] Unit tests — member tree folding (pure, no engine)');
  const memberTree = await bundle('src/memberTree.ts', 'memberTree.mjs');
  const { buildMemberForest, countNodes, flattenNames, compareMemberNames, sortMemberNames } = memberTree;

  check('empty database: no members and no edges -> empty forest', () => {
    assert.deepEqual(buildMemberForest([], []), []);
    assert.equal(countNodes(buildMemberForest([], [])), 0);
    return 'no throw, 0 nodes';
  });

  check('flat hierarchy: every member is a root, sorted naturally', () => {
    const forest = buildMemberForest(['West', 'East', 'Central', 'South'], []);
    assert.deepEqual(
      forest.map((node) => node.name),
      ['Central', 'East', 'South', 'West'],
    );
    assert.equal(countNodes(forest), 4);
    return '4 roots';
  });

  check('nested hierarchy: roots are members that never appear as a child', () => {
    const edges = [
      { member: 'Furniture', parent: 'All', weight: 1 },
      { member: 'Bookcases', parent: 'Furniture', weight: 1 },
      { member: 'Chairs', parent: 'Furniture', weight: 0.5 },
    ];
    const forest = buildMemberForest(['All', 'Furniture', 'Bookcases', 'Chairs', 'Phones'], edges);
    assert.deepEqual(
      forest.map((node) => node.name),
      ['All', 'Phones'],
    );
    assert.deepEqual(
      forest[0].children.map((node) => [node.name, node.weight]),
      [['Furniture', 1]],
    );
    assert.deepEqual(
      forest[0].children[0].children.map((node) => [node.name, node.weight]),
      [
        ['Bookcases', 1],
        ['Chairs', 0.5],
      ],
    );
    return 'All > Furniture > Bookcases/Chairs, weight 0.5 kept';
  });

  check('"All" sorts before other roots', () => {
    assert.deepEqual(
      buildMemberForest(['Zeta', 'All'], []).map((node) => node.name),
      ['All', 'Zeta'],
    );
    return 'All first';
  });

  check('natural sort puts "Item 2" before "Item 10"', () => {
    assert.deepEqual(
      buildMemberForest(['Item 10', 'Item 2', 'Item 1'], []).map((node) => node.name),
      ['Item 1', 'Item 2', 'Item 10'],
    );
    assert.ok(compareMemberNames('Item 2', 'Item 10') < 0);
    assert.deepEqual(sortMemberNames(['b', 'a']), ['a', 'b']);
    return 'numeric-aware';
  });

  check('a member with two parents appears under both (shared rollup)', () => {
    const edges = [
      { member: 'Shared', parent: 'P1', weight: 0.5 },
      { member: 'Shared', parent: 'P2', weight: 0.5 },
    ];
    const forest = buildMemberForest(['Shared', 'P1', 'P2'], edges);
    assert.deepEqual(
      forest.map((node) => node.name),
      ['P1', 'P2'],
    );
    assert.equal(forest[0].children[0].name, 'Shared');
    assert.equal(forest[1].children[0].name, 'Shared');
    assert.equal(countNodes(forest), 4);
    return 'two paths to one member';
  });

  check('cycle and self-edge cannot hang the folder', () => {
    const cycle = buildMemberForest(
      ['A', 'B'],
      [
        { member: 'A', parent: 'B', weight: 1 },
        { member: 'B', parent: 'A', weight: 1 },
      ],
    );
    assert.deepEqual(cycle, []); // no roots, no infinite recursion
    const selfEdge = buildMemberForest(['A'], [{ member: 'A', parent: 'A', weight: 1 }]);
    assert.deepEqual(selfEdge, []);
    return 'terminates';
  });

  check('flattenNames yields full paths for assertions', () => {
    const edges = [
      { member: 'Furniture', parent: 'All', weight: 1 },
      { member: 'Bookcases', parent: 'Furniture', weight: 1 },
    ];
    const paths = flattenNames(buildMemberForest(['All', 'Furniture', 'Bookcases'], edges)).map((p) =>
      p.join(' > '),
    );
    assert.ok(paths.includes('All > Furniture > Bookcases'), `missing path: ${paths.join(', ')}`);
    return 'All > Furniture > Bookcases';
  });
}

// ------------------------------------------------------------------ phase 3

async function phaseDataChecks(engineUp) {
  console.log('\n[3/5] Live data checks — the app’s discovery layer against the engine');
  if (!engineUp) {
    fail('engine reachable', new Error(`No engine answering at ${ENGINE}. Start it with start-engine.cmd first.`));
    return null;
  }

  const data = await bundle('src/data.ts', 'data.mjs');
  const { engineApi, discovery, EngineError, buildMemberForest } = data;
  const collectNames = (nodes) => nodes.flatMap((node) => [node.name, ...collectNames(node.children)]);

  await checkAsync('capabilities: protocolVersion is 1 and maxRows is reported', async () => {
    const capabilities = await engineApi.capabilities();
    assert.equal(capabilities.protocolVersion, 1);
    assert.ok(capabilities.maxRows > 0);
    return `maxRows ${capabilities.maxRows}`;
  });

  await checkAsync('datasets: user cubes and the core system cubes are listed', async () => {
    const datasets = await discovery.datasets();
    const userCubes = datasets.filter((name) => !name.startsWith('#'));
    const systemCubes = datasets.filter((name) => name.startsWith('#'));
    // The set of system cubes grows as the engine adds security control cubes, so
    // assert the classic six are present rather than an exact list.
    for (const expected of ['#Columns', '#Cubes', '#Dimensions', '#Edges', '#Hierarchies', '#Members']) {
      assert.ok(systemCubes.includes(expected), `missing system cube ${expected}`);
    }
    assert.ok(userCubes.includes('Sales'), 'missing user cube Sales');
    return `${userCubes.length} user / ${systemCubes.length} system`;
  });

  await checkAsync('describe: Sales has 36 rows and Region/Segment/Category dimensions', async () => {
    const sales = await discovery.describe('Sales');
    assert.equal(sales.rowCount, 36);
    assert.equal(sales.isSystem, false);
    const dimensions = sales.columns.filter((column) => column.suggestedKind === 'dimension').map((column) => column.name);
    for (const name of ['Region', 'Segment', 'Category']) assert.ok(dimensions.includes(name), `missing ${name}`);
    const measure = sales.columns.find((column) => column.suggestedKind === 'measure');
    assert.ok(measure, 'no measure column');
    assert.ok(sales.columns.find((column) => column.name === 'Region').cardinality > 0);
    return `${dimensions.length} dimensions, measure "${measure.name}"`;
  });

  await checkAsync('describe: system cubes are marked isSystem and are describable', async () => {
    const system = await discovery.describe('#Columns');
    assert.equal(system.isSystem, true);
    // System cubes expose their own trailing `value` cell column as well.
    assert.deepEqual(
      system.columns.map((column) => column.name),
      ['#Cube', '#Column', '#Property', 'value'],
    );
    return '#Columns has 4 columns';
  });

  await checkAsync('percent-encoding: system-cube names work as query datasets (# never 404s)', async () => {
    const response = await engineApi.query({
      dataset: '#Members',
      groupBy: [{ name: '#Hierarchy' }, { name: '#Member' }],
      filters: [{ field: '#Hierarchy', operator: 'in', values: ['Region'] }],
      limit: 100,
    });
    assert.ok(response.rows.length > 0, 'no rows from #Members');
    return `${response.rows.length} rows via %23Members`;
  });

  await checkAsync('dimensions: the seeded dimensions with hierarchy counts are listed', async () => {
    const dimensions = await discovery.dimensions();
    const byName = new Map(dimensions.map((dimension) => [dimension.name, dimension.hierarchyCount]));
    for (const name of ['Product', 'Region', 'Segment', 'Geo', 'Account', 'Measure', 'Attribute', 'Category']) {
      assert.ok(byName.has(name), `missing dimension ${name}`);
    }
    assert.ok(dimensions.length >= 8, `expected at least 8 dimensions, saw ${dimensions.length}`);
    assert.equal(byName.get('Product'), 2);
    assert.equal(byName.get('Region'), 1);
    return `${dimensions.length} dimensions, Product has 2 hierarchies`;
  });

  await checkAsync('hierarchies: Product reports exactly Product and Product_Class', async () => {
    const hierarchies = await discovery.hierarchies('Product');
    assert.deepEqual(hierarchies, ['Product', 'Product_Class']);
    return hierarchies.join(', ');
  });

  await checkAsync('members: Product_Class folds into All > Furniture > Bookcases with weights', async () => {
    const tree = await discovery.memberTree('Product_Class');
    assert.equal(tree.memberCount, 20);
    assert.equal(tree.edgeCount, 19);
    assert.equal(tree.forest.length, 1, 'expected exactly one root');
    assert.equal(tree.forest[0].name, 'All');
    const root = tree.forest[0];
    assert.deepEqual(
      root.children.map((node) => node.name),
      ['Furniture', 'Office Supplies', 'Technology'],
    );
    const furniture = root.children[0];
    assert.equal(furniture.weight, 1);
    const bookcases = furniture.children.find((node) => node.name === 'Bookcases');
    assert.ok(bookcases, 'Bookcases missing under Furniture');
    assert.equal(bookcases.weight, 1);
    assert.equal(bookcases.children.length, 0);
    assert.equal(collectNames(tree.forest).length, 20);
    return 'All > Furniture > Bookcases, 20 members / 19 edges';
  });

  await checkAsync('members: flat hierarchies (Product, Region) render as sorted roots', async () => {
    // Product is a flat hierarchy: 16 leaves, no edges, no "All" rollup.
    const product = await discovery.memberTree('Product');
    assert.equal(product.edgeCount, 0);
    assert.equal(product.memberCount, 16);
    assert.equal(product.forest.length, 16);
    const region = await discovery.memberTree('Region');
    assert.deepEqual(
      region.forest.map((node) => node.name),
      ['Central', 'East', 'South', 'West'],
    );
    return 'Product flat 16, Region flat 4';
  });

  await checkAsync('sample: Sales returns 10 of 36 rows (dimension columns only)', async () => {
    const sample = await engineApi.sample('Sales', { limit: 10 });
    assert.equal(sample.rows.length, 10);
    assert.equal(sample.rowCount, 36);
    // The engine's /sample omits the measure `value` column: it returns the
    // dimension columns only. The UI states this; reported as a finding.
    assert.deepEqual(sample.columns, ['Region', 'Segment', 'Category']);
    return `${sample.rows.length}/${sample.rowCount} rows, 3 dimension columns`;
  });

  await checkAsync('SQL passthrough: POST /v1/sql returns the formatted text table', async () => {
    const result = await engineApi.sql('SELECT Region, value FROM Sales');
    assert.ok(result.output.includes('Central'), 'output missing Central');
    assert.ok(result.output.includes('Region'), 'output missing Region header');
    return `${String(result.elapsedMs)} ms`;
  });

  await checkAsync('errors: unknown dataset surfaces code unknown_dataset with status 404', async () => {
    await assert.rejects(
      () => discovery.describe('NoSuchCube'),
      (error) => {
        assert.ok(error instanceof EngineError, 'not an EngineError');
        assert.equal(error.code, 'unknown_dataset');
        assert.equal(error.status, 404);
        return true;
      },
    );
    return '404 unknown_dataset';
  });

  await checkAsync('empty input: the folder renders an empty forest, not a crash', () => {
    assert.deepEqual(buildMemberForest([], []), []);
    return '0 nodes';
  });

  return data;
}

// ------------------------------------------------------------------ phase 4

async function phaseAnonymousUi(engineUp, baseUrl) {
  console.log('\n[4/5] Headless browser walkthrough — anonymous engine (Chrome DevTools Protocol)');
  if (!engineUp) {
    fail('UI walkthrough (anonymous)', new Error(`No engine at ${ENGINE}; browser walkthrough needs live data.`));
    return;
  }

  mkdirSync(SHOTS_DIR, { recursive: true });

  let chrome = null;
  let cdp = null;

  try {
    await checkAsync('proxy: /v1 through the preview server reaches the engine (no CORS needed)', async () => {
      const response = await fetchWithTimeout(`${baseUrl}v1/capabilities`, 5000);
      assert.ok(response.ok, `proxy returned HTTP ${response.status}`);
      const body = await response.json();
      assert.equal(body.protocolVersion, 1);
      return 'HTTP 200, protocolVersion 1';
    });

    const launched = await launchChrome();
    chrome = launched.child;
    cdp = new Cdp(launched.webSocketUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const page = createPageDriver(cdp);

    // Inline `textContent` lookups: innerText respects CSS text-transform, which
    // would make case-sensitive assertions on uppercased dt labels fragile.
    const readMeta = () =>
      page.evaluate(`Object.fromEntries(
        Array.from(document.querySelectorAll('.details .meta-grid > div')).map((row) => {
          const label = row.querySelector('dt');
          const value = row.querySelector('dd');
          return [label ? label.textContent.trim() : '', value ? value.textContent.trim() : ''];
        }))`);

    await page.navigate(baseUrl);
    await page.waitFor(`document.querySelector('.pill-online') !== null`, 'connection status online');
    await page.waitFor(`document.querySelector('[data-node-id="section:cubes"]') !== null`, 'tree root sections');

    await checkAsync('anonymous engine: no login form is shown', async () => {
      const loginForm = await page.evaluate(`document.querySelector('[data-testid="login-screen"]') !== null`);
      assert.equal(loginForm, false, 'login form appeared for an engine that does not require auth');
      return 'shell rendered directly';
    });

    await checkAsync('tree: user cubes and system cubes are separated', async () => {
      // Compare against what the engine currently lists: system cubes grow as the
      // engine adds control cubes, and `-Fresh` can reseed the database.
      const response = await fetchWithTimeout(`${baseUrl}v1/datasets`, 5000);
      assert.ok(response.ok, `datasets request failed (HTTP ${response.status})`);
      const { datasets } = await response.json();
      const userCount = datasets.filter((name) => !name.startsWith('#')).length;
      const systemCount = datasets.length - userCount;
      const cubeCount = await page.count('[data-node-id^="cube:"]');
      assert.equal(cubeCount, datasets.length, `tree shows ${cubeCount} cubes, engine lists ${datasets.length}`);
      const salesVisible = await page.evaluate(
        `document.querySelector('[data-node-id="cube:Sales"]') !== null`,
      );
      const systemVisible = await page.evaluate(
        `document.querySelector('[data-node-id="cube:#Columns"]') !== null`,
      );
      assert.ok(salesVisible, 'Sales missing from the tree');
      assert.ok(systemVisible, '#Columns missing from the system cubes section');
      return `${datasets.length} cubes (${userCount} user + ${systemCount} system)`;
    });

    await checkAsync('cube: selecting Sales loads describe and renders its columns', async () => {
      await page.click('[data-node-id="cube:Sales"]');
      await page.waitFor(
        `document.querySelector('[data-node-id="column:Sales:Region"]') !== null`,
        'Sales columns in the tree',
      );
      const columnCount = await page.count('[data-node-id^="column:Sales:"]');
      assert.equal(columnCount, 4, `expected 4 Sales columns, saw ${columnCount}`);

      await page.waitFor(`document.querySelector('.details h2')?.textContent === 'Sales'`, 'Sales details');
      const meta = await readMeta();
      assert.equal(meta.Rows, '36');
      assert.equal(meta.Columns, '4');
      assert.equal(meta['Measure dimension'], '—');
      assert.equal(meta.System, 'no');
      const gridNames = await page.evaluate(
        `Array.from(document.querySelectorAll('.details tbody .cell-name')).map((el) => el.textContent)`,
      );
      assert.deepEqual(gridNames, ['Region', 'Segment', 'Category', 'value']);
      const regionKind = await page.evaluate(
        `document.querySelector('[data-column-name="Region"] .chip')?.textContent ?? ''`,
      );
      assert.equal(regionKind.trim(), 'dimension');
      await page.screenshot('01-sales-details.png');
      return '4 columns, rowCount 36, Region is a dimension';
    });

    await checkAsync('system cube: #Columns expands into its own columns', async () => {
      await page.click('[data-node-id="cube:#Columns"]');
      await page.waitFor(
        `document.querySelector('[data-node-id="column:#Columns:#Cube"]') !== null`,
        '#Columns columns',
      );
      const chip = await page.evaluate(
        `document.querySelector('.details .detail-head .chip')?.textContent ?? ''`,
      );
      assert.equal(chip.trim(), 'system cube');
      const gridNames = await page.evaluate(
        `Array.from(document.querySelectorAll('.details tbody .cell-name')).map((el) => el.textContent)`,
      );
      assert.deepEqual(gridNames, ['#Cube', '#Column', '#Property', 'value']);
      return '#Cube, #Column, #Property, value';
    });

    await checkAsync('preview: sample shows 10 rows in a grid', async () => {
      await page.click('[data-node-id="cube:Sales"]'); // reselect Sales for preview
      await page.waitFor(`document.querySelector('.details h2')?.textContent === 'Sales'`, 'Sales details again');
      await page.click('[data-testid="tab-preview"]');
      await page.waitFor(
        `document.querySelectorAll('[data-testid="preview-grid"] tbody tr').length === 10`,
        'ten preview rows',
      );
      const headers = await page.evaluate(
        `Array.from(document.querySelectorAll('[data-testid="preview-grid"] thead th')).map((th) => th.textContent)`,
      );
      // /sample returns dimension columns only; the measure column is not in it.
      assert.deepEqual(headers.slice(1), ['Region', 'Segment', 'Category']);
      const footer = await page.text('.preview-footer');
      assert.ok(footer.includes('of 36 rows'), `unexpected footer: ${footer}`);
      const note = await page.text('.preview-note');
      assert.ok(note.includes('dimension columns only'), 'missing the sample-endpoint note');
      await page.screenshot('02-sales-preview.png');
      return '10 rows, headers Region/Segment/Category';
    });

    await checkAsync('dimensions: Product expands to Product and Product_Class', async () => {
      await page.click('[data-testid="tab-details"]');
      await page.click('[data-node-id="dimension:Product"]');
      await page.waitFor(
        `document.querySelector('[data-node-id="hierarchy:Product:Product_Class"]') !== null`,
        'Product hierarchies',
      );
      const hierarchyCount = await page.count('[data-node-id^="hierarchy:Product:"]');
      assert.equal(hierarchyCount, 2);
      const firstTree = await page.evaluate(
        `Array.from(document.querySelectorAll('[data-node-id^="hierarchy:Product:"] .tree-label')).map((el) => el.textContent)`,
      );
      assert.deepEqual(firstTree, ['Product', 'Product_Class']);
      return 'Product + Product_Class';
    });

    await checkAsync('members: Product_Class nests All > Furniture > Bookcases with a visible weight', async () => {
      await page.click('[data-node-id="hierarchy:Product:Product_Class"]');
      await page.waitFor(
        `document.querySelector('[data-node-id="member:Product_Class:All"]') !== null`,
        'Product_Class members',
      );
      await page.click('[data-node-id="member:Product_Class:All"]');
      await page.waitFor(
        `document.querySelector('[data-node-id="member:Product_Class:All/Furniture"]') !== null`,
        'Furniture under All',
      );
      await page.click('[data-node-id="member:Product_Class:All/Furniture"]');
      await page.waitFor(
        `document.querySelector('[data-node-id="member:Product_Class:All/Furniture/Bookcases"]') !== null`,
        'Bookcases under Furniture',
      );
      const bookcasesRow = await page.text('[data-node-id="member:Product_Class:All/Furniture/Bookcases"]');
      assert.ok(bookcasesRow.includes('×1'), `weight not visible on Bookcases: "${bookcasesRow}"`);
      const allChildren = await page.evaluate(
        `Array.from(document.querySelectorAll('[data-node-id^="member:Product_Class:All/"] .tree-label')).map((el) => el.textContent)`,
      );
      for (const name of ['Furniture', 'Office Supplies', 'Technology']) {
        assert.ok(allChildren.includes(name), `missing ${name} under All`);
      }
      return 'All > Furniture > Bookcases, weight ×1';
    });

    await checkAsync('member details: path, hierarchy and rollup weight are shown', async () => {
      await page.click('[data-node-id="member:Product_Class:All/Furniture/Bookcases"]');
      await page.waitFor(`document.querySelector('.details h2')?.textContent === 'Bookcases'`, 'Bookcases details');
      const meta = await readMeta();
      assert.equal(meta.Dimension, 'Product');
      assert.equal(meta.Hierarchy, 'Product_Class');
      assert.equal(meta['Rollup weight'], '1');
      assert.equal(meta.Path, 'All › Furniture › Bookcases');
      assert.equal(meta.Children, '0');
      await page.screenshot('03-members-nested.png');
      return 'path + weight rendered';
    });

    await checkAsync('sql console: query runs and returns the engine text table', async () => {
      await page.click('[data-testid="tab-sql"]');
      await setTextareaValue(page, '.sql-input', 'SELECT Region, value FROM Sales');
      await page.click('.sql-actions .btn-primary');
      await page.waitFor(
        `document.querySelector('[data-testid="sql-output"]')?.innerText.includes('Central') === true`,
        'SQL output',
      );
      const output = await page.text('[data-testid="sql-output"]');
      assert.ok(output.includes('East') && output.includes('South') && output.includes('West'));
      await page.screenshot('04-sql-console.png');
      return 'formatted text table';
    });

    await checkAsync('no uncaught page errors during the walkthrough', () => {
      assert.deepEqual(page.pageErrors, [], page.pageErrors.join(' | '));
      return 'clean console';
    });

    await checkAsync('offline state: unreachable engine shows the error banner, not a crash', async () => {
      const broken = `${baseUrl}?engine=${encodeURIComponent('http://127.0.0.1:59999')}`;
      await page.navigate(broken);
      await page.waitFor(`document.body.innerText.includes('Engine unreachable')`, 'error banner', 20_000);
      const body = await page.bodyText();
      assert.ok(body.includes('Could not reach the engine'), 'banner lacks the network error detail');
      await page.screenshot('05-offline-state.png');
      return 'banner + retry shown';
    });
  } catch (error) {
    fail('UI walkthrough (anonymous)', error);
    try {
      if (cdp) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileWithRetry(path.join(SHOTS_DIR, '99-failure.png'), Buffer.from(shot.data, 'base64'));
      }
    } catch {
      /* best effort */
    }
  } finally {
    try {
      cdp?.close();
    } catch {
      /* best effort */
    }
    killTree(chrome);
    await sleep(400);
  }
}

// ------------------------------------------------------------------ phase 5

async function startPreviewServer() {
  const server = spawn(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(PREVIEW_PORT),
      '--strictPort',
    ],
    { cwd: ROOT, stdio: 'ignore' },
  );
  await waitForHttpOk(`http://127.0.0.1:${PREVIEW_PORT}/`, 30_000, 'vite preview');
  return server;
}

/**
 * A post-auth engine binary. The engine currently serving 8080 may predate the
 * auth work, and that tree is read-only for this project, so an already-built
 * auth-capable binary is looked up: this is the REAL engine, not a stub, run on
 * a spare port against a COPY of the seeded database.
 *
 * Portable override: set OLAP_ENGINE_BIN to the binary's path. If the variable
 * is set but the file does not exist, the auth phases are skipped (not failed),
 * which is also what happens when no candidate is found at all.
 */
function findAuthEngineBinary() {
  const explicit = process.env.OLAP_ENGINE_BIN;
  if (explicit !== undefined && explicit !== '') {
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = [
    path.join(ROOT, '..', 'olap-target-verify', 'debug', 'serve.exe'),
    path.join(ROOT, '..', 'Patricia', 'olap_engine', 'target', 'debug', 'deps', 'serve.exe'),
    path.join(ROOT, '..', 'Patricia', 'olap_engine', 'target', 'debug', 'serve.exe'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const bytes = readFileSync(candidate);
      if (bytes.includes('--allow-anonymous') && bytes.includes('--add-user')) return candidate;
    } catch {
      /* unreadable candidate, try the next */
    }
  }
  return null;
}

async function startAuthEngine(binary) {
  const dir = path.join(VERIFY_DIR, 'auth');
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'database.auth.bin');
  const securityPath = path.join(dir, 'security.json');
  if (!existsSync(dbPath)) {
    // A copy: the seeded reference is never loaded or written by this project.
    copyFileSync(REFERENCE_DB, dbPath);
    await run(binary, [
      '--add-user',
      AUTH_USER,
      '--role',
      'reader',
      '--password',
      AUTH_PASSWORD,
      '--security',
      securityPath,
      '--db',
      dbPath,
    ]);
  }
  const child = spawn(
    binary,
    ['--bind', `127.0.0.1:${AUTH_PORT}`, '--db', dbPath, '--security', securityPath, '--cors'],
    { cwd: ROOT, stdio: 'ignore' },
  );
  await waitForHttpOk(`http://127.0.0.1:${AUTH_PORT}/v1/capabilities`, 20_000, 'auth engine');
  return child;
}

async function phaseAuthData(authBase, data) {
  console.log('\n[5/5] Authentication — real engine with auth enabled (spare port, db copy)');
  console.log(`  auth engine : ${authBase}  (user ${AUTH_USER} / role reader)`);

  const previousEngine = process.env.OLAP_ENGINE_URL;
  process.env.OLAP_ENGINE_URL = authBase;
  /** What the authenticated role can actually see; the UI phase asserts against this. */
  let stats = null;
  try {
    const {
      engineApi,
      discovery,
      EngineError,
      setAuth,
      clearAuth,
      hasToken,
      getSession,
      resetDiscoveryCache,
      isUnauthorized,
    } = data;

    clearAuth();
    resetDiscoveryCache();

    await checkAsync('auth: capabilities is PUBLIC and reports authRequired: true', async () => {
      const caps = await engineApi.capabilities({ suppressUnauthorized: true });
      assert.equal(caps.authRequired, true);
      return 'authRequired: true without a token';
    });

    await checkAsync('auth: data routes answer 401 without a token', async () => {
      resetDiscoveryCache();
      await assert.rejects(
        () => discovery.datasets(),
        (error) => {
          assert.ok(error instanceof EngineError, 'not an EngineError');
          assert.equal(error.status, 401);
          assert.equal(error.code, 'unauthorized');
          return true;
        },
      );
      return '401 unauthorized';
    });

    await checkAsync('auth: POST /v1/login rejects a wrong password', async () => {
      await assert.rejects(
        () => engineApi.login(AUTH_USER, 'definitely-not-the-password'),
        (error) => {
          assert.equal(error.status, 401);
          assert.equal(error.code, 'unauthorized');
          return true;
        },
      );
      return '401 invalid credentials';
    });

    await checkAsync('auth: POST /v1/login returns a bearer token, user and roles', async () => {
      const result = await engineApi.login(AUTH_USER, AUTH_PASSWORD);
      assert.equal(typeof result.token, 'string');
      assert.equal(result.token.length, 64, `expected a 64-hex token, saw ${result.token.length} chars`);
      assert.equal(result.user, AUTH_USER);
      assert.ok(result.roles.includes('reader'), `roles missing reader: ${result.roles.join(', ')}`);
      assert.ok(result.expiresAt * 1000 > Date.now(), 'expiresAt is in the past');
      setAuth(result.token, { user: result.user, roles: result.roles, expiresAt: result.expiresAt });
      assert.ok(hasToken());
      assert.equal(getSession()?.user, AUTH_USER);
      return '64-hex token, role reader';
    });

    await checkAsync('auth: authenticated discovery returns the tree data', async () => {
      resetDiscoveryCache();
      const datasets = await discovery.datasets();
      const userCubes = datasets.filter((name) => !name.startsWith('#'));
      const systemCubes = datasets.filter((name) => name.startsWith('#'));
      // Role-based access can filter cubes, and control cubes grow with the engine,
      // so assert the shape rather than fixed counts.
      assert.ok(userCubes.length >= 1, 'the authenticated role can see no user cubes');
      for (const expected of ['#Columns', '#Cubes', '#Dimensions', '#Edges', '#Hierarchies', '#Members']) {
        assert.ok(systemCubes.includes(expected), `missing system cube ${expected}`);
      }
      const dimensions = await discovery.dimensions();
      assert.ok(dimensions.length >= 8, `expected at least 8 dimensions, saw ${dimensions.length}`);
      stats = { total: datasets.length, userCubes, firstUserCube: userCubes[0] };
      return `${userCubes.length} user / ${systemCubes.length} system cubes / ${dimensions.length} dimensions with a token`;
    });

    await checkAsync('auth: clearing the token makes requests 401 again', async () => {
      clearAuth();
      resetDiscoveryCache();
      await assert.rejects(() => discovery.datasets(), (error) => isUnauthorized(error));
      return '401 after sign-out';
    });

    return stats;
  } finally {
    process.env.OLAP_ENGINE_URL = previousEngine;
    data.resetDiscoveryCache();
  }
}

async function phaseAuthUi(baseUrl, authBase, engineRef, binary, authStats) {
  let chrome = null;
  let cdp = null;
  try {
    const launched = await launchChrome();
    chrome = launched.child;
    cdp = new Cdp(launched.webSocketUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const page = createPageDriver(cdp);
    const authUrl = `http://127.0.0.1:${AUTH_PORT}/`;
    const engineBaseText = authUrl.replace(/\/+$/, '');
    const appUrl = `${baseUrl}?engine=${encodeURIComponent(authUrl)}`;

    await checkAsync('auth UI: the login form replaces the shell when the engine requires a token', async () => {
      await page.navigate(appUrl);
      await page.waitFor(`document.querySelector('[data-testid="login-screen"]') !== null`, 'login form');
      const body = await page.bodyText();
      assert.ok(body.includes(engineBaseText), `login form does not name the engine (${engineBaseText})`);
      assert.ok(body.includes('Sign in'), 'login form lacks a sign-in heading');
      const treeRendered = await page.evaluate(
        `document.querySelector('[data-node-id="section:cubes"]') !== null`,
      );
      assert.equal(treeRendered, false, 'tree rendered before signing in');
      await page.screenshot('06-login.png');
      return 'login form shown, no tree';
    });

    await checkAsync('auth UI: a wrong password shows the engine error and keeps the form', async () => {
      await setInputValue(page, '[data-testid="login-user"]', AUTH_USER);
      await setInputValue(page, '[data-testid="login-password"]', 'wrong-password');
      await page.click('[data-testid="login-submit"]');
      await page.waitFor(
        `document.querySelector('.login-card .error-notice') !== null`,
        'sign-in error notice',
      );
      const errorText = await page.text('.login-card .error-notice');
      assert.ok(errorText.includes('Invalid user name or password.'), `unexpected error: ${errorText}`);
      const stillOnForm = await page.evaluate(`document.querySelector('[data-testid="login-screen"]') !== null`);
      assert.ok(stillOnForm, 'login form disappeared after a failed attempt');
      return '401 message shown verbatim';
    });

    await checkAsync('auth UI: signing in loads the tree and shows the user', async () => {
      await setInputValue(page, '[data-testid="login-password"]', AUTH_PASSWORD);
      await page.click('[data-testid="login-submit"]');
      await page.waitFor(`document.querySelector('[data-node-id="section:cubes"]') !== null`, 'tree after login');
      await page.waitFor(
        `document.querySelector('[data-testid="header-user"]')?.textContent === ${JSON.stringify(AUTH_USER)}`,
        'header user',
      );
      const cubes = await page.count('[data-node-id^="cube:"]');
      const expectedCubes = authStats?.total ?? cubes;
      assert.equal(
        cubes,
        expectedCubes,
        `tree shows ${cubes} cubes, the authenticated dataset list has ${expectedCubes}`,
      );
      await page.screenshot('07-authenticated.png');
      return `${AUTH_USER} signed in, ${cubes} cubes`;
    });

    await checkAsync('auth UI: a reload keeps the session (sessionStorage token), no login form', async () => {
      await page.navigate(appUrl);
      await page.waitFor(`document.querySelector('[data-node-id="section:cubes"]') !== null`, 'tree after reload');
      const loginForm = await page.evaluate(`document.querySelector('[data-testid="login-screen"]') !== null`);
      assert.equal(loginForm, false, 'reload lost the session');
      const user = await page.text('[data-testid="header-user"]');
      assert.equal(user, AUTH_USER);
      return 'session restored in the tab';
    });

    await checkAsync('auth UI: Sign out returns to the login form', async () => {
      await page.click('[data-testid="logout"]');
      await page.waitFor(`document.querySelector('[data-testid="login-screen"]') !== null`, 'login form after sign-out');
      const userChip = await page.evaluate(`document.querySelector('[data-testid="header-user"]') !== null`);
      assert.equal(userChip, false, 'user chip survived sign-out');
      return 'signed out locally';
    });

    await checkAsync('auth UI: an engine restart invalidates the session and prompts a re-login', async () => {
      await setInputValue(page, '[data-testid="login-user"]', AUTH_USER);
      await setInputValue(page, '[data-testid="login-password"]', AUTH_PASSWORD);
      await page.click('[data-testid="login-submit"]');
      await page.waitFor(`document.querySelector('[data-node-id="section:cubes"]') !== null`, 'tree after re-login');

      // Sessions live in engine memory: restarting the engine logs everyone out.
      killTree(engineRef.current);
      engineRef.current = await startAuthEngine(binary);
      await waitForHttpOk(`${authUrl}v1/capabilities`, 10_000, 'auth engine after restart');

      // Any data request now 401s; the shell must react by showing the login
      // screen with the "session expired" explanation (not a stuck tree).
      // Use a cube the authenticated role can see (role-based access may hide
      // some cubes, e.g. Sales).
      const clickableCube = authStats?.firstUserCube ?? 'Sales';
      await page.click(`[data-node-id="cube:${clickableCube}"]`);
      await page.waitFor(`document.querySelector('[data-testid="login-screen"]') !== null`, 'login after expiry');
      const note = await page.text('.login-note');
      assert.ok(note.includes('session expired'), `login note lacks the expiry hint: ${note}`);
      await page.screenshot('08-session-expired.png');
      return '401 handled as an expired session';
    });

    await checkAsync('auth UI: no uncaught page errors', () => {
      assert.deepEqual(page.pageErrors, [], page.pageErrors.join(' | '));
      return 'clean console';
    });
  } catch (error) {
    fail('auth UI walkthrough', error);
    try {
      if (cdp) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileWithRetry(path.join(SHOTS_DIR, '99-failure.png'), Buffer.from(shot.data, 'base64'));
      }
    } catch {
      /* best effort */
    }
  } finally {
    try {
      cdp?.close();
    } catch {
      /* best effort */
    }
    killTree(chrome);
    await sleep(400);
  }
}

async function setInputValue(page, selector, value) {
  const applied = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!applied) throw new Error(`No input matches ${selector}`);
}

// ---------------------------------------------------------------------- main

async function engineIsUp() {
  try {
    const response = await fetchWithTimeout(`${ENGINE}/v1/capabilities`, 2500);
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('OLAP Object Explorer — verification');
  console.log(`  engine : ${ENGINE}`);
  console.log(`  project: ${ROOT}`);

  rmSync(VERIFY_DIR, { recursive: true, force: true });
  mkdirSync(VERIFY_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  const engineUp = await engineIsUp();
  console.log(`  engine status: ${engineUp ? 'up' : 'DOWN (data/UI checks will fail)'}`);

  try {
    await phaseBuild();
  } catch (error) {
    // A failed typecheck/build leaves nothing meaningful to test.
    fail('build', error);
    return finish();
  }

  await phaseUnit();
  const data = await phaseDataChecks(engineUp);

  let preview = null;
  let engineRef = null;
  try {
    preview = await startPreviewServer();
    const baseUrl = `http://127.0.0.1:${PREVIEW_PORT}/`;
    await phaseAnonymousUi(engineUp, baseUrl);

    const binary = findAuthEngineBinary();
    if (binary === null || !existsSync(REFERENCE_DB)) {
      console.log('\n  SKIP  authentication phases — no auth-capable serve.exe and/or reference database found.');
      console.log('        Set OLAP_ENGINE_BIN / OLAP_ENGINE_DB to run them (see README).');
    } else if (data === null) {
      fail('authentication checks', new Error('skipped: the app data layer did not load'));
    } else {
      engineRef = { current: await startAuthEngine(binary) };
      const authBase = `http://127.0.0.1:${AUTH_PORT}/`;
      const authStats = await phaseAuthData(authBase, data);
      await phaseAuthUi(baseUrl, authBase, engineRef, binary, authStats);
    }
  } finally {
    killTree(engineRef?.current ?? null);
    killTree(preview);
    await sleep(400);
  }

  return finish();
}

function finish() {
  console.log('\n-------------------------------------------------------------');
  if (failures.length === 0) {
    console.log(`RESULT: ${checks} checks, 0 failures.`);
    console.log('Screenshots: docs/screenshots/');
    process.exitCode = 0;
  } else {
    console.log(`RESULT: ${checks} checks, ${failures.length} failure(s):`);
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nVerification crashed:', error);
  process.exitCode = 1;
});
