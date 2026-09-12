#!/usr/bin/env node
// Validate access boundaries without a Docker daemon or real credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compose = fileURLToPath(new URL('../deploy/traefik/compose.yml', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'gev-compose-'));
const envFile = join(dir, '.env');
const fixture = {
  GEV_IMAGE: 'gev:test',
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
  assert.equal(config.configs.allowed_emails.content.trim(), fixture.GEV_ALLOWED_EMAILS);
  assert.ok(login.configs.some(c => c.source === 'allowed_emails'
    && c.target === login.environment.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE));
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
  console.log('Traefik Compose checks passed: private app, login route, secret separation, allowlist, and required values.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
