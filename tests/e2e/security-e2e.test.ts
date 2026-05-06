import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';
import { io } from 'socket.io-client';

const BASE_URL = 'http://127.0.0.1:1999';
const HEALTH_URL = `${BASE_URL}/health`;
const TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 500;

async function waitForHealth(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
    } catch (err) {
      lastErr = err as Error;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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

async function cleanup(devProcess: any) {
  if (devProcess && devProcess.pid) {
    killProcessTree(devProcess.pid);
  }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    execSync('lsof -ti :1999 | xargs kill -9 2>/dev/null');
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 500));
}

async function assertPortFree() {
  try {
    const pids = execSync('lsof -ti :1999', { encoding: 'utf-8' }).trim();
    if (pids) {
      throw new Error(`Port 1999 is still occupied by PIDs: ${pids.split('\n').join(', ')}`);
    }
  } catch (err: any) {
    if (err.message.includes('Port 1999 is still occupied')) {
      throw err;
    }
  }
}

describe('security and boundaries e2e', () => {
  let devProcess: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
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

    const healthRes = await waitForHealth(HEALTH_URL);
    expect(healthRes.status).toBe(200);
  }, 30000);

  afterAll(async () => {
    await cleanup(devProcess);
    await assertPortFree();
  });

  it('unknown API route returns 404 with JSON error body', async () => {
    const res = await fetch(`${BASE_URL}/__unknown__`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBeDefined();
  });

  it('disallows Socket.IO connection from forbidden origin', async () => {
    return new Promise<void>((resolve, reject) => {
      const socket = io(BASE_URL, {
        transports: ['websocket'],
        extraHeaders: { origin: 'https://evil.example.invalid' },
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.close();
          reject(new Error('Expected connection to fail but it did not'));
        }
      }, 5000);

      socket.on('connect_error', (_err: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          // The error may contain a message about the forbidden origin
          resolve();
        }
      });

      socket.on('connect', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          reject(new Error('Expected connection to be rejected but it succeeded'));
        }
      });
    });
  });

  it('allows Socket.IO connection from allowed origin', async () => {
    return new Promise<void>((resolve, reject) => {
      const socket = io(BASE_URL, {
        transports: ['websocket'],
        extraHeaders: { origin: 'http://127.0.0.1:1999' },
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.close();
          reject(new Error('Expected connection to succeed but timed out'));
        }
      }, 5000);

      socket.on('connect', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      });

      socket.on('connect_error', (err: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          reject(new Error(`Connection failed unexpectedly: ${err.message}`));
        }
      });
    });
  });

  it('rejects sync with missing credentials over Socket.IO', async () => {
    // Create a real match first
    const createRes = await fetch(`${BASE_URL}/games/tic-tac-toe/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numPlayers: 2 }),
    });
    expect(createRes.status).toBe(201);
    const { matchID } = (await createRes.json()) as { matchID: string };

    return new Promise<void>((resolve, reject) => {
      const socket = io(BASE_URL, {
        transports: ['websocket'],
        extraHeaders: { origin: 'http://127.0.0.1:1999' },
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.close();
          reject(new Error('Expected sync_error but timed out'));
        }
      }, 5000);

      socket.on('connect', () => {
        // Send sync without credentials for an existing match
        socket.emit('sync', matchID, '0', undefined, 2);
      });

      socket.on('sync_error', (error: string) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          expect(error).toBe('auth_invalid');
          resolve();
        }
      });

      socket.on('connect_error', (_err: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          reject(new Error('Connection failed'));
        }
      });
    });
  });

  it('returns unsupported_frame_type for chat event without disconnecting', async () => {
    return new Promise<void>((resolve, reject) => {
      const socket = io(BASE_URL, {
        transports: ['websocket'],
        extraHeaders: { origin: 'http://127.0.0.1:1999' },
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.close();
          reject(new Error('Expected error but timed out'));
        }
      }, 5000);

      socket.on('connect', () => {
        socket.emit('chat', { message: 'hello' });
      });

      socket.on('error', (error: string) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          expect(error).toBe('unsupported_frame_type');
          // Verify socket is still connected
          expect(socket.connected).toBe(true);
          socket.close();
          resolve();
        }
      });

      socket.on('connect_error', (_err: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          reject(new Error('Connection failed'));
        }
      });
    });
  });
});
