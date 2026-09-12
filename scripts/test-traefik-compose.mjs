#!/usr/bin/env node
// Validate access boundaries without a Docker daemon or real credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const compose = fileURLToPath(new URL('../deploy/traefik/compose.yml', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'gev-compose-'));
const envFile = join(dir, '.env');
const fixture = {
  GEV_IMAGE: process.argv[2] || 'gev:test',
  APP_DOMAIN: 'gev.example.com',
  GOOGLE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'fixture-oauth-secret',
  OAUTH2_PROXY_COOKIE_SECRET: Buffer.alloc(32, 1).toString('base64url'),
  GEV_ALLOWED_EMAILS: 'alice@example.com\nbob@example.com',
  TRAEFIK_TRUSTED_IPS: '172.22.0.2/32',
  OPENAI_API_KEY: 'fixture-private-provider-key',
};
function render(values) {
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n'));
  return spawnSync('docker', ['compose', '--env-file', envFile, '-f', compose, 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 30_000,
    // Never inherit the operator's provider keys or Compose overrides.
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}
try {
  const result = render(fixture);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.name, 'gods-eye-view', 'Do not share the existing Traefik Compose project');
  const app = config.services.app;
  const login = config.services.login;
  const prepare = config.services['prepare-login'];
  assert.ok(prepare, 'Create the email file before starting the read-only login service');
  assert.equal(login.read_only, true);
  assert.ok(!login.configs?.length, 'Generated Compose configs cannot enter a read-only service');
  assert.equal(prepare.network_mode, 'none');
  assert.equal(login.depends_on['prepare-login'].condition, 'service_completed_successfully');
  const loginMount = login.volumes.find(v => v.target === '/etc/gev-login');
  assert.equal(loginMount.read_only, true);
  assert.ok(prepare.volumes.some(v => v.source === loginMount.source));
  const prepared = spawnSync(process.execPath, [...prepare.command.slice(1, -1), dir], {
    env: prepare.environment, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(readFileSync(join(dir, 'allowed-emails.txt'), 'utf8').trim(), fixture.GEV_ALLOWED_EMAILS);
  const blank = spawnSync(process.execPath, [...prepare.command.slice(1, -1), dir], {
    env: { GEV_ALLOWED_EMAILS: '  \n ' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.notEqual(blank.status, 0, 'Whitespace-only email lists must fail');
  for (const service of [app, login]) {
    assert.ok(!service.ports?.length, 'No service may publish a host port');
    assert.ok(!service.network_mode, 'Do not bypass Compose network boundaries');
  }
  assert.equal(app.labels['traefik.enable'], 'false');
  const appNetworks = Object.keys(app.networks);
  assert.ok(appNetworks.length > 0);
  for (const network of appNetworks) {
    assert.ok(!config.networks[network].external, 'App must not join a shared server network');
    assert.ok(!config.networks[network].internal, 'App still needs outbound provider access');
    assert.ok(Object.hasOwn(login.networks, network), 'Login must reach the app');
  }
  assert.equal(login.labels['traefik.enable'], 'true');
  assert.equal(login.labels['traefik.docker.network'], config.networks.proxy.name);
  assert.equal(login.labels['traefik.http.services.gev-login.loadbalancer.server.port'], '4180');
  assert.equal(login.labels['traefik.http.routers.gev-login.entrypoints'], 'websecure');
  assert.equal(login.labels['traefik.http.routers.gev-login.tls'], 'true');
  assert.equal(login.labels['traefik.http.routers.gev-login.tls.certresolver'], 'le');
  assert.equal(login.environment.OAUTH2_PROXY_API_ROUTES, '^/api/');
  assert.equal(login.environment.OAUTH2_PROXY_UPSTREAMS, 'http://app:4173/');
  assert.equal(login.environment.OAUTH2_PROXY_REDIRECT_URL, 'https://gev.example.com/oauth2/callback');
  assert.equal(login.environment.OAUTH2_PROXY_COOKIE_SECURE, 'true');
  assert.equal(login.environment.OAUTH2_PROXY_COOKIE_HTTPONLY, 'true');
  assert.equal(login.environment.OAUTH2_PROXY_COOKIE_SAMESITE, 'lax');
  assert.equal(login.environment.OAUTH2_PROXY_TRUSTED_PROXY_IPS, fixture.TRAEFIK_TRUSTED_IPS);
  for (const bypass of ['EMAIL_DOMAINS', 'SKIP_AUTH_ROUTES', 'SKIP_AUTH_REGEX', 'TRUSTED_IPS']) {
    assert.ok(!login.environment[`OAUTH2_PROXY_${bypass}`], `Unexpected authentication bypass: ${bypass}`);
  }
  assert.equal(login.environment.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE, '/etc/gev-login/allowed-emails.txt');
  assert.ok(!JSON.stringify(app).includes(fixture.GOOGLE_CLIENT_SECRET), 'App must not receive OAuth secrets');
  assert.ok(!JSON.stringify(app).includes(fixture.OAUTH2_PROXY_COOKIE_SECRET), 'App must not receive cookie secrets');
  assert.ok(!JSON.stringify(login).includes(fixture.OPENAI_API_KEY), 'Login must not receive provider keys');
  assert.equal(app.environment.GEV_KEY_SETUP_DISABLED, '1');

  for (const key of ['GEV_IMAGE', 'APP_DOMAIN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'OAUTH2_PROXY_COOKIE_SECRET', 'GEV_ALLOWED_EMAILS', 'TRAEFIK_TRUSTED_IPS']) {
    const missing = render({ ...fixture, [key]: '' });
    assert.notEqual(missing.status, 0, `Empty ${key} must block startup`);
    assert.ok(missing.stderr.includes(key), `Error must identify ${key}`);
  }
  if (process.argv[2]) {
    // A real Compose start catches failures that `compose config` cannot see.
    render(fixture);
    const project = `gev-auth-${randomUUID()}`;
    const override = join(dir, 'override.json');
    writeFileSync(override, JSON.stringify({
      services: { login: { ports: ['127.0.0.1::4180'] } },
      networks: { proxy: { external: false, name: `${project}-proxy` } },
    }));
    const docker = (...args) => {
      const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const stack = (...args) => docker('compose', '--project-name', project, '--env-file', envFile,
      '-f', compose, '-f', override, ...args);
    try {
      stack('up', '-d', '--wait', '--wait-timeout', '120');
      const id = stack('ps', '-q', 'login');
      const base = `http://${docker('port', id, '4180/tcp').split('\n')[0]}`;
      const get = (path, options = {}) => fetch(base + path, {
        redirect: 'manual', signal: AbortSignal.timeout(3000), ...options,
      });
      for (let attempt = 0; attempt < 30; attempt++) {
        try { if ((await get('/ping')).status === 200) break; } catch {}
        await delay(500);
      }
      assert.equal((await get('/ping')).status, 200);
      for (const path of ['/', '/src/main.js', '/@vite/client']) {
        assert.equal((await get(path)).status, 403, `Unauthenticated page: ${path}`);
      }
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        assert.equal((await get('/api/realtime/token', {
          method, headers: { 'X-Forwarded-Email': 'alice@example.com' },
        })).status, 401, `Unauthenticated API: ${method}`);
      }
      const info = JSON.parse(docker('inspect', id))[0];
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.Mounts.find(m => m.Destination === '/etc/gev-login').RW, false);
      assert.equal((await get('/oauth2/start')).status, 302);
      console.log('Real Compose startup passed: email volume, read-only login, and anonymous access denial.');
    } catch (error) {
      console.error(stack('logs', '--no-color', '--tail', '40'));
      throw error;
    } finally {
      stack('down', '--volumes', '--remove-orphans');
    }
  }
  console.log('Traefik Compose checks passed: private app, login route, secret separation, allowlist, and required values.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
