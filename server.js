const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const indexPath = path.join(publicDir, 'index.html');

loadEnvFile(path.join(rootDir, '.env'));
loadEnvFile(path.join(rootDir, '.env.local'));

const port = Number.parseInt(process.env.PORT || '8080', 10);
const requestedCacheTtlHours = Number.parseFloat(process.env.RED61_CACHE_TTL_HOURS || '24');
const cacheTtlHours = Number.isFinite(requestedCacheTtlHours) && requestedCacheTtlHours > 0
  ? requestedCacheTtlHours
  : 24;
const cacheTtlMs = cacheTtlHours * 60 * 60 * 1000;

let refreshInFlight = null;

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/health') {
      return sendJson(response, 200, await getHealth());
    }

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
      await ensureFreshCache();
      return sendFile(response, indexPath, 'text/html; charset=utf-8');
    }

    const staticPath = path.normalize(path.join(publicDir, requestUrl.pathname));
    if (!staticPath.startsWith(publicDir)) {
      return sendText(response, 403, 'Forbidden');
    }

    return sendFile(response, staticPath);
  } catch (error) {
    console.error(error);

    if (await fileExists(indexPath)) {
      response.setHeader('X-Red61-Cache', 'stale');
      return sendFile(response, indexPath, 'text/html; charset=utf-8');
    }

    return sendText(response, 500, 'Unable to fetch Red61 report and no cached page exists yet.');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Chris Grace report server listening on http://0.0.0.0:${port}`);
  console.log(`Red61 cache TTL: ${cacheTtlHours} hours`);
});

ensureFreshCache().catch((error) => {
  console.error(`Initial Red61 refresh failed: ${error.message}`);
}).finally(() => {
  scheduleNextCacheCheck();
});

async function ensureFreshCache() {
  if (await isCacheFresh()) return;

  if (!refreshInFlight) {
    refreshInFlight = refreshCache().finally(() => {
      refreshInFlight = null;
    });
  }

  await refreshInFlight;
}

async function scheduleNextCacheCheck() {
  let delay = 60 * 1000;
  try {
    delay = await getDelayUntilRefresh();
  } catch (error) {
    console.error(`Unable to inspect Red61 cache age: ${error.message}`);
  }

  setTimeout(async () => {
    try {
      await ensureFreshCache();
    } catch (error) {
      console.error(`Scheduled Red61 refresh failed: ${error.message}`);
    } finally {
      scheduleNextCacheCheck();
    }
  }, delay);
}

async function isCacheFresh() {
  try {
    const stat = await fs.stat(indexPath);
    return Date.now() - stat.mtimeMs < cacheTtlMs;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function getDelayUntilRefresh() {
  try {
    const stat = await fs.stat(indexPath);
    const age = Date.now() - stat.mtimeMs;
    return Math.max(cacheTtlMs - age, 60 * 1000);
  } catch (error) {
    if (error.code === 'ENOENT') return 60 * 1000;
    throw error;
  }
}

async function refreshCache() {
  console.log('Refreshing Red61 cache...');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'refresh-red61.js')], {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Red61 refresh exited with code ${code}`));
      }
    });
  });
}

async function getHealth() {
  let cache = null;
  try {
    const stat = await fs.stat(indexPath);
    cache = {
      exists: true,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      ageSeconds: Math.round((Date.now() - stat.mtimeMs) / 1000),
      fresh: Date.now() - stat.mtimeMs < cacheTtlMs,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cache = { exists: false, fresh: false };
  }

  return {
    ok: cache.exists,
    cache,
    cacheTtlHours,
  };
}

async function sendFile(response, filePath, contentType = contentTypeFor(filePath)) {
  try {
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') return sendText(response, 404, 'Not found');
    throw error;
  }
}

function sendText(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body, null, 2));
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function loadEnvFile(filePath) {
  let contents;
  try {
    contents = require('node:fs').readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
