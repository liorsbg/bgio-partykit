import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(process.cwd());

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf-8'));
}

describe('project scaffold', () => {
  it('has pnpm-workspace.yaml', () => {
    expect(existsSync(resolve(root, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('has partykit.json with main and serve', () => {
    const pk = readJson('partykit.json');
    expect(pk.main).toBe('src/server.ts');
    expect(pk.serve).toBeDefined();
    expect(pk.serve.path).toBe('static');
    expect(pk.parties).toBeDefined();
    expect(pk.parties.lobby).toBe('src/server.ts');
    expect(pk.parties.match).toBe('src/server.ts');
  });

  it('has TypeScript strict config', () => {
    const ts = readJson('tsconfig.json');
    expect(ts.compilerOptions.strict).toBe(true);
    expect(ts.compilerOptions.target).toBe('ES2022');
    expect(ts.compilerOptions.module).toBe('ESNext');
  });

  it('has eslint config', () => {
    expect(existsSync(resolve(root, 'eslint.config.js'))).toBe(true);
  });

  it('has vitest config', () => {
    expect(existsSync(resolve(root, 'vitest.config.ts'))).toBe(true);
  });

  it('has vendored party.io with reconnect fix', () => {
    expect(existsSync(resolve(root, 'packages/party.io/src/index.ts'))).toBe(true);
    const adapter = readFileSync(resolve(root, 'packages/party.io/src/socket.io/lib/party-adapter.ts'), 'utf-8');
    expect(adapter).toContain('#scheduleReconnect');
    expect(adapter).not.toContain('TODO: reconnect');
    expect(adapter).toContain('connector.addEventListener("close"');
  });

  it('has static assets', () => {
    expect(existsSync(resolve(root, 'static/index.html'))).toBe(true);
    expect(existsSync(resolve(root, 'static/demo.css'))).toBe(true);
    expect(existsSync(resolve(root, 'static/demo.js'))).toBe(true);
  });

  it('has print-config script', () => {
    expect(existsSync(resolve(root, 'scripts/print-config.mjs'))).toBe(true);
  });

  it('has git initialized', () => {
    expect(existsSync(resolve(root, '.git'))).toBe(true);
  });
});
