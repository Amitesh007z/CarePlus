import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/config/env.js';

const valid = {
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:supersecret@host.neon.tech/db?sslmode=require',
};

describe('loadEnv', () => {
  it('applies defaults and parses origins', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.APP_ORIGIN).toEqual(['http://localhost:5173']);
    expect(env.DIRECT_DATABASE_URL).toBeUndefined();
  });

  it('normalizes a multi-origin allow-list and strips trailing slashes', () => {
    const env = loadEnv({ ...valid, APP_ORIGIN: 'http://localhost:5173/, https://app.example.com' });
    expect(env.APP_ORIGIN).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('fails fast listing every missing variable', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
    try {
      loadEnv({});
    } catch (err) {
      const vars = (err as EnvValidationError).issues.map((i) => i.variable);
      expect(vars).toEqual(expect.arrayContaining(['APP_ORIGIN', 'DATABASE_URL']));
    }
  });

  it('rejects a non-postgres database URL without echoing its value', () => {
    try {
      loadEnv({ ...valid, DATABASE_URL: 'mysql://user:supersecret@host/db' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('DATABASE_URL');
      expect((err as Error).message).not.toContain('supersecret');
    }
  });

  it('rejects invalid origins and out-of-range values', () => {
    expect(() => loadEnv({ ...valid, APP_ORIGIN: 'not a url' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...valid, APP_ORIGIN: 'ftp://example.com' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...valid, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('treats an empty DIRECT_DATABASE_URL as unset', () => {
    expect(loadEnv({ ...valid, DIRECT_DATABASE_URL: '' }).DIRECT_DATABASE_URL).toBeUndefined();
  });
});
