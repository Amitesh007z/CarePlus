import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMigrationStatus, readMigrationFiles } from '../src/infrastructure/database/migrate.js';
import { fakeDb } from './helpers.js';

describe('migration files', () => {
  it('reads the foundation migration with a checksum', async () => {
    const files = await readMigrationFiles();
    expect(files.map((f) => f.name)).toContain('0001_foundation.sql');
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores files that do not follow the NNNN_name.sql convention', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '0002_ok.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, 'notes.md'), 'x');
    await writeFile(path.join(dir, '2_bad.sql'), 'SELECT 1;');
    expect((await readMigrationFiles(dir)).map((f) => f.name)).toEqual(['0002_ok.sql']);
  });
});

describe('getMigrationStatus', () => {
  it('reports all migrations pending when the tracking table is missing', async () => {
    const s = await getMigrationStatus(fakeDb(() => [{ t: null }]));
    expect(s.applied).toBe(0);
    expect(s.pending).toContain('0001_foundation.sql');
  });

  it('detects drift when an applied file was edited', async () => {
    const db = fakeDb((t) =>
      t.includes('to_regclass') ? [{ t: 'schema_migrations' }] : [{ name: '0001_foundation.sql', checksum: 'stale' }],
    );
    const s = await getMigrationStatus(db);
    expect(s.pending).toEqual([]);
    expect(s.drifted).toEqual(['0001_foundation.sql']);
  });
});
