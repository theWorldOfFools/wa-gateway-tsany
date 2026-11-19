import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/wa_gateway'
};

describe('dashboard cookie configuration', () => {
  it('defaults COOKIE_SECURE to true in production', () => {
    const config = loadConfig({ ...baseEnv, NODE_ENV: 'production' });
    assert.equal(config.COOKIE_SECURE, true);
  });

  it('defaults COOKIE_SECURE to false outside production', () => {
    const config = loadConfig({ ...baseEnv, NODE_ENV: 'development' });
    assert.equal(config.COOKIE_SECURE, false);
  });

  it('honors an explicit COOKIE_SECURE override', () => {
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false'
    });
    assert.equal(config.COOKIE_SECURE, false);
  });

  it('reads the dashboard session lifetime', () => {
    const config = loadConfig({
      ...baseEnv,
      DASHBOARD_SESSION_TTL_DAYS: '14'
    });
    assert.equal(config.DASHBOARD_SESSION_TTL_DAYS, 14);
  });
});
