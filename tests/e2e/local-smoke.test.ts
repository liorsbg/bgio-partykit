import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';

async function waitForHealth(url: string, timeoutMs = 15000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
    } catch (err) {
      lastErr = err as Error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr || new Error(`Health check timed out for ${url}`);
}

function killProcessTree(pid: number) {
  try {
    const stdout = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8' });
    const children = stdout.trim().split('\n').filter(Boolean);
    for (const child of children) {
      killProcessTree(parseInt(child, 10));
    }
  } catch {
    // no children
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead
  }
}

describe('local PartyKit e2e', () => {
  let devProcess: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
    // Ensure port is free
    try {
      execSync('lsof -ti :1999 | xargs kill 2>/dev/null; sleep 1; lsof -ti :1999 | xargs kill -9 2>/dev/null');
    } catch {
      // ignore
    }

    devProcess = spawn('pnpm', ['dev'], {
      cwd: process.cwd(),
      detached: false,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    // Wait for server to be ready
    const healthRes = await waitForHealth('http://127.0.0.1:1999/health');
    expect(healthRes.status).toBe(200);
  }, 30000);

  afterAll(async () => {
    if (devProcess && devProcess.pid) {
      killProcessTree(devProcess.pid);
    }
    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 2000));
    try {
      execSync('lsof -ti :1999 | xargs kill -9 2>/dev/null');
    } catch {
      // ignore
    }
  });

  it('health endpoint returns service identity', async () => {
    const res = await fetch('http://127.0.0.1:1999/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; status: string; games: string[] };
    expect(body.service).toBe('bgio-partykit');
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.games)).toBe(true);
    expect(body.games).toContain('tic-tac-toe');
  });

  it('static HTML is served', async () => {
    const res = await fetch('http://127.0.0.1:1999/');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('bgio-partykit');
  });

  it('static CSS asset is served', async () => {
    const res = await fetch('http://127.0.0.1:1999/demo.css');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('text/css');
  });

  it('static JS asset is served', async () => {
    const res = await fetch('http://127.0.0.1:1999/demo.js');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('javascript');
  });

  it('missing static asset returns 404', async () => {
    const res = await fetch('http://127.0.0.1:1999/assets/__missing-bgio-partykit-test__.js');
    expect(res.status).toBe(404);
  });

  it('unknown route returns controlled error', async () => {
    const res = await fetch('http://127.0.0.1:1999/__unknown__', { method: 'POST' });
    expect(res.status).toBeOneOf([404, 405]);
  });

  it('print-config emits valid JSON', async () => {
    const stdout = execSync('node scripts/print-config.mjs', { encoding: 'utf-8' });
    const config = JSON.parse(stdout) as Record<string, unknown>;
    expect(config.localBaseUrl).toBe('http://127.0.0.1:1999');
    expect(Array.isArray(config.gameNames)).toBe(true);
    expect(config.lobbyRoutePrefix).toBe('/games');
    expect(Array.isArray(config.allowedOrigins)).toBe(true);
    expect(Array.isArray(config.disallowedOrigins)).toBe(true);
    expect(config.localPartyKitDevPort).toBe(1999);
  });
});
