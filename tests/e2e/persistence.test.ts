import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';
import { io } from 'socket.io-client';
import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import TicTacToe from '../../src/games/tic-tac-toe';

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
  await new Promise((r) => setTimeout(r, 2000));
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

function startDevServer() {
  const proc = spawn('pnpm', ['dev'], {
    cwd: process.cwd(),
    detached: false,
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return proc;
}

async function createMatch(): Promise<string> {
  const res = await fetch(`${BASE_URL}/games/tic-tac-toe/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numPlayers: 2 }),
  });
  expect(res.status).toBe(201);
  const { matchID } = (await res.json()) as { matchID: string };
  return matchID;
}

async function joinMatch(matchID: string, playerName: string): Promise<{ playerID: string; playerCredentials: string }> {
  const res = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { playerID: string; playerCredentials: string };
}

function createSocketIOClient(socketOpts?: Record<string, unknown>) {
  return io(BASE_URL, {
    transports: ['websocket'],
    ...socketOpts,
  });
}

function waitForSocketEvent(socket: any, event: string, timeoutMs = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (...args: unknown[]) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(args);
    };
    socket.on(event, handler);
  });
}

function createBgioClient(matchID: string, playerID: string, credentials: string, socketOpts?: Record<string, unknown>) {
  return Client({
    game: TicTacToe,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts }),
    matchID,
    playerID,
    credentials,
  });
}

async function waitForClientState(client: any, predicate: (state: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;  // eslint-disable-line prefer-const
    const timer = setTimeout(() => {
      if (unsub) unsub();
      reject(new Error('Timeout waiting for client state'));
    }, timeoutMs);
    unsub = client.subscribe((state: any) => {
      if (state && predicate(state)) {
        clearTimeout(timer);
        if (unsub) unsub();
        resolve(state);
      }
    });
  });
}

describe('persistence and reconnect e2e', () => {
  let devProcess: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
    // Ensure port is free
    try {
      execSync('lsof -ti :1999 | xargs kill 2>/dev/null; sleep 1; lsof -ti :1999 | xargs kill -9 2>/dev/null');
    } catch {
      // ignore
    }

    devProcess = startDevServer();

    devProcess.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[dev] ${line}`);
    });
    devProcess.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[dev:err] ${line}`);
    });

    const healthRes = await waitForHealth(HEALTH_URL);
    expect(healthRes.status).toBe(200);
  }, 30000);

  afterAll(async () => {
    await cleanup(devProcess);
    await assertPortFree();
  });

  it('e2e cleanup removes test matches', async () => {
    const matchID = await createMatch();

    // Verify match exists
    const detailRes = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}`);
    expect(detailRes.status).toBe(200);

    // Cleanup
    const cleanupRes = await fetch(`${BASE_URL}/e2e/cleanup`, { method: 'POST' });
    expect(cleanupRes.status).toBe(200);
    const cleanupBody = (await cleanupRes.json()) as { cleaned: number };
    expect(cleanupBody.cleaned).toBeGreaterThanOrEqual(1);

    // Verify match is gone
    const afterRes = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}`);
    expect(afterRes.status).toBe(404);
  });

  it('reconnecting client receives latest persisted state after disconnect', async () => {
    const matchID = await createMatch();
    const { playerID, playerCredentials } = await joinMatch(matchID, 'Alice');

    const socket = createSocketIOClient();
    socket.connect();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (err: any) => {
        clearTimeout(timer);
        reject(new Error(`Socket connect error: ${err.message}`));
      });
    });

    // Sync and make a move
    socket.emit('sync', matchID, playerID, playerCredentials, 2);
    const [syncMatchID, syncInfo] = (await waitForSocketEvent(socket, 'sync')) as [string, any];
    expect(syncMatchID).toBe(matchID);
    expect(syncInfo.state._stateID).toBe(0);
    expect(syncInfo.state.G.cells).toEqual(Array(9).fill(null));

    socket.emit('update', { type: 'MAKE_MOVE', payload: { type: 'clickCell', args: [0], playerID } }, 0, matchID, playerID);
    const [updateMatchID, updateState] = (await waitForSocketEvent(socket, 'update')) as [string, any];
    expect(updateMatchID).toBe(matchID);
    expect(updateState._stateID).toBe(1);
    expect(updateState.G.cells[0]).toBe(playerID);

    // Disconnect
    socket.close();
    await new Promise((r) => setTimeout(r, 500));

    // Reconnect with new socket
    const socket2 = createSocketIOClient();
    socket2.connect();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket2 connect timeout')), 5000);
      socket2.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket2.on('connect_error', (err: any) => {
        clearTimeout(timer);
        reject(new Error(`Socket2 connect error: ${err.message}`));
      });
    });

    socket2.emit('sync', matchID, playerID, playerCredentials, 2);
    const [syncMatchID2, syncInfo2] = (await waitForSocketEvent(socket2, 'sync')) as [string, any];
    expect(syncMatchID2).toBe(matchID);
    // Reconnect should see the persisted state with the move
    expect(syncInfo2.state._stateID).toBe(1);
    expect(syncInfo2.state.G.cells[0]).toBe(playerID);
    expect(syncInfo2.log.length).toBeGreaterThanOrEqual(1);

    socket2.close();
  }, 15000);

  it('cold-start recovery after all clients disconnect', async () => {
    const matchID = await createMatch();
    const p0 = await joinMatch(matchID, 'Alice');

    // Player 0 connects and makes a move
    const socket0 = createSocketIOClient();
    socket0.connect();
    await waitForSocketEvent(socket0, 'connect');
    socket0.emit('sync', matchID, p0.playerID, p0.playerCredentials, 2);
    await waitForSocketEvent(socket0, 'sync');

    socket0.emit('update', { type: 'MAKE_MOVE', payload: { type: 'clickCell', args: [0], playerID: p0.playerID } }, 0, matchID, p0.playerID);
    await waitForSocketEvent(socket0, 'update');

    // Disconnect ALL clients
    socket0.close();
    await new Promise((r) => setTimeout(r, 1000));

    // Cold-start reconnect with fresh socket after room goes idle
    const socket2 = createSocketIOClient();
    socket2.connect();
    await waitForSocketEvent(socket2, 'connect');
    socket2.emit('sync', matchID, p0.playerID, p0.playerCredentials, 2);
    const [, syncInfo] = (await waitForSocketEvent(socket2, 'sync')) as [string, any];

    // Should see the latest persisted state, not initial
    expect(syncInfo.state._stateID).toBe(1);
    expect(syncInfo.state.G.cells[0]).toBe(p0.playerID);
    expect(syncInfo.log.length).toBeGreaterThanOrEqual(1);

    socket2.close();
  }, 15000);

  it('persists match state across PartyKit dev server restart', async () => {
    const matchID = await createMatch();
    const { playerID, playerCredentials } = await joinMatch(matchID, 'Alice');

    // Connect and make a move
    const socket = createSocketIOClient();
    socket.connect();
    await waitForSocketEvent(socket, 'connect');
    socket.emit('sync', matchID, playerID, playerCredentials, 2);
    await waitForSocketEvent(socket, 'sync');

    socket.emit('update', { type: 'MAKE_MOVE', payload: { type: 'clickCell', args: [0], playerID } }, 0, matchID, playerID);
    const [, updateState] = (await waitForSocketEvent(socket, 'update')) as [string, any];
    expect(updateState._stateID).toBe(1);
    expect(updateState.G.cells[0]).toBe(playerID);

    socket.close();
    await new Promise((r) => setTimeout(r, 500));

    // Restart the dev server
    await cleanup(devProcess);
    await assertPortFree();

    devProcess = startDevServer();
    devProcess.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[dev] ${line}`);
    });
    devProcess.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[dev:err] ${line}`);
    });

    const healthRes = await waitForHealth(HEALTH_URL);
    expect(healthRes.status).toBe(200);

    // Reconnect after restart
    const socket2 = createSocketIOClient();
    socket2.connect();
    await waitForSocketEvent(socket2, 'connect');
    socket2.emit('sync', matchID, playerID, playerCredentials, 2);
    const [syncMatchID, syncInfo] = (await waitForSocketEvent(socket2, 'sync')) as [string, any];
    expect(syncMatchID).toBe(matchID);
    expect(syncInfo.state._stateID).toBe(1);
    expect(syncInfo.state.G.cells[0]).toBe(playerID);
    expect(syncInfo.log.length).toBeGreaterThanOrEqual(1);

    socket2.close();
  }, 45000);

  it('boardgame.io Client works with websocket-only transport', async () => {
    // VAL-MATCH-017
    const matchID = await createMatch();
    const { playerID, playerCredentials } = await joinMatch(matchID, 'Alice');

    const client = createBgioClient(matchID, playerID, playerCredentials, { transports: ['websocket'] });
    client.start();

    try {
      const state = await waitForClientState(client, (s: any) => s !== null && s._stateID !== undefined, 5000);
      expect(state._stateID).toBe(0);
      expect(state.ctx.currentPlayer).toBe('0');

      // Make a move using the boardgame.io client API
      client.moves.clickCell(0);

      const updatedState = await waitForClientState(client, (s: any) => s && s._stateID === 1, 5000);
      expect(updatedState.G.cells[0]).toBe(playerID);
    } finally {
      client.stop();
    }
  }, 15000);

  it('boardgame.io Client works with default transport config', async () => {
    // VAL-MATCH-018
    const matchID = await createMatch();
    const { playerID, playerCredentials } = await joinMatch(matchID, 'Alice');

    // Default SocketIO config (no socketOpts override) uses polling then upgrade
    const client = createBgioClient(matchID, playerID, playerCredentials);
    client.start();

    try {
      const state = await waitForClientState(client, (s: any) => s !== null && s._stateID !== undefined, 5000);
      expect(state._stateID).toBe(0);
      expect(state.ctx.currentPlayer).toBe('0');

      client.moves.clickCell(0);

      const updatedState = await waitForClientState(client, (s: any) => s && s._stateID === 1, 5000);
      expect(updatedState.G.cells[0]).toBe(playerID);
    } finally {
      client.stop();
    }
  }, 15000);
});
