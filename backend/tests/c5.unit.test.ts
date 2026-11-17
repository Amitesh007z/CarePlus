import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/config/env.js';
import { createAlgoliaProvider } from '../src/modules/search/algolia.adapter.js';
import { createSearchProvider } from '../src/modules/search/search-runtime.js';
import { INDEX_MEDICINES, SearchProviderError, type IndexRecord } from '../src/modules/search/search-provider.js';
import { BASE_DELAY_MS, MAX_DELAY_MS, medicineRecord, retryDelayMs } from '../src/modules/search/search-sync.js';
import { availabilityOf } from '../src/modules/medicines/catalogue.service.js';

const base = { APP_ORIGIN: 'http://localhost:5173', DATABASE_URL: 'postgresql://user:pw@host/db' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake fetch that records calls and answers with the given response factory. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('C5 unit: retry, records and availability', () => {
  it('retry delays grow exponentially and are bounded', () => {
    expect(retryDelayMs(1)).toBe(BASE_DELAY_MS);
    expect(retryDelayMs(2)).toBe(BASE_DELAY_MS * 2);
    expect(retryDelayMs(5)).toBe(BASE_DELAY_MS * 16);
    expect(retryDelayMs(30)).toBe(MAX_DELAY_MS);
  });

  it('the medicine record is an explicit allow-list: no stock, no internal flags, no timestamps', () => {
    const rec = medicineRecord({
      id: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', sku: 'MED-1', name: 'N', strength: null, form: 'Tablet', category: 'C',
      pack_size: 'Strip', price_inr: '12.50', rx_required: true, allergy_class: null, description: null, manufacturer: null,
    });
    expect(rec).toEqual({
      objectID: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', sku: 'MED-1', name: 'N', strength: null, form: 'Tablet', category: 'C',
      packSize: 'Strip', priceInr: 12.5, rxRequired: true, allergyClass: null, description: null, manufacturer: null,
    });
    expect(Object.keys(rec)).not.toEqual(expect.arrayContaining(['stock_qty', 'stockQty', 'active', 'created_at']));
  });

  it('availability bands: out, low (10 or fewer) and in stock', () => {
    expect(availabilityOf(0)).toBe('OUT_OF_STOCK');
    expect(availabilityOf(10)).toBe('LOW_STOCK');
    expect(availabilityOf(11)).toBe('IN_STOCK');
  });
});

describe('C5 unit: Algolia adapter wire format and failure handling', () => {
  const config = { appId: 'APPTEST', adminKey: 'admin-key-value-123', searchKey: 'search-key-value-456', timeoutMs: 500 };

  it('batch saves use addObject (whole-object replace) on the write host with the backend admin key', async () => {
    const { fn, calls } = fakeFetch(() => json({ taskID: 1 }));
    const p = createAlgoliaProvider(config, fn);
    const rec = { objectID: 'a', sku: 'S' } as unknown as IndexRecord;
    await p.saveObjects(INDEX_MEDICINES, [rec]);
    expect(calls[0]!.url).toBe('https://APPTEST.algolia.net/1/indexes/carepulse_medicines/batch');
    expect(calls[0]!.headers['X-Algolia-API-Key']).toBe('admin-key-value-123');
    expect(calls[0]!.body).toEqual({ requests: [{ action: 'addObject', body: rec }] });
  });

  it('deletes send deleteObject; large batches are split into requests of at most 1000', async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const p = createAlgoliaProvider(config, fn);
    await p.deleteObjects(INDEX_MEDICINES, ['x']);
    expect(calls[0]!.body).toEqual({ requests: [{ action: 'deleteObject', body: { objectID: 'x' } }] });
    const many = Array.from({ length: 2500 }, (_, i) => ({ objectID: String(i) }) as unknown as IndexRecord);
    calls.length = 0;
    await p.saveObjects(INDEX_MEDICINES, many);
    expect(calls).toHaveLength(3);
    expect((calls[0]!.body as { requests: unknown[] }).requests).toHaveLength(1000);
  });

  it('search uses the restricted search key on the read host and returns object IDs only', async () => {
    const { fn, calls } = fakeFetch(() => json({ hits: [{ objectID: 'id-1' }], nbHits: 1 }));
    const p = createAlgoliaProvider(config, fn);
    const out = await p.searchIds(INDEX_MEDICINES, 'amox', 50);
    expect(out).toEqual({ ids: ['id-1'], nbHits: 1 });
    expect(calls[0]!.url).toBe('https://APPTEST-dsn.algolia.net/1/indexes/carepulse_medicines/query');
    expect(calls[0]!.headers['X-Algolia-API-Key']).toBe('search-key-value-456');
    expect(calls[0]!.body).toMatchObject({ query: 'amox', attributesToRetrieve: ['objectID'] });
  });

  it('browse follows the cursor until the index is exhausted', async () => {
    const pages = [{ hits: [{ objectID: 'a' }], cursor: 'next' }, { hits: [{ objectID: 'b' }] }];
    const { fn, calls } = fakeFetch(() => json(pages.shift()));
    expect(await createAlgoliaProvider(config, fn).listObjectIds(INDEX_MEDICINES)).toEqual(['a', 'b']);
    expect(calls[1]!.body).toMatchObject({ cursor: 'next' });
  });

  it('a timeout becomes TIMEOUT and never leaks the provider or the URL', async () => {
    const p = createAlgoliaProvider(config, async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const err = await p.searchIds(INDEX_MEDICINES, 'x', 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchProviderError);
    expect((err as SearchProviderError).kind).toBe('TIMEOUT');
    expect((err as Error).message).not.toMatch(/algolia|APPTEST|key/i);
  });

  it('a provider 503 is retryable and its body never reaches the error message', async () => {
    const p = createAlgoliaProvider(config, async () => new Response('internal: account suspended for admin-key-value-123', { status: 503 }));
    const err = (await p.saveObjects(INDEX_MEDICINES, [{ objectID: 'a' } as unknown as IndexRecord]).catch((e: unknown) => e)) as SearchProviderError;
    expect(err.kind).toBe('UNAVAILABLE');
    expect(err.status).toBe(503);
    expect(err.code).toBe('UNAVAILABLE_503');
    expect(err.message).not.toMatch(/suspended|admin-key/);
  });

  it('a 4xx from the provider is REJECTED, with its status only', async () => {
    const p = createAlgoliaProvider(config, async () => new Response('{"message":"Invalid API key"}', { status: 403 }));
    const err = (await p.configure(INDEX_MEDICINES).catch((e: unknown) => e)) as SearchProviderError;
    expect(err).toMatchObject({ kind: 'REJECTED', status: 403 });
    expect(err.message).not.toMatch(/Invalid API key/);
  });

  it('a network failure is UNAVAILABLE', async () => {
    const p = createAlgoliaProvider(config, async () => {
      throw new TypeError('fetch failed');
    });
    expect((await p.searchIds(INDEX_MEDICINES, 'x', 1).catch((e: unknown) => e) as SearchProviderError).kind).toBe('UNAVAILABLE');
  });
});

describe('C5 unit: configuration and secret handling', () => {
  it('search is optional: without credentials there is no provider and nothing fails at startup', () => {
    const env = loadEnv({ ...base, ALGOLIA_APP_ID: '', ALGOLIA_ADMIN_API_KEY: '' });
    expect(createSearchProvider(env)).toBeNull();
  });

  it('an app ID without its admin key is refused, and only the variable name is reported', () => {
    try {
      loadEnv({ ...base, ALGOLIA_APP_ID: 'APPTEST', ALGOLIA_ADMIN_API_KEY: '' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const message = (err as Error).message;
      expect(message).toContain('ALGOLIA_ADMIN_API_KEY');
      expect(message).not.toContain('APPTEST');
    }
  });

  it('no frontend source or env file mentions Algolia or a VITE_ credential', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const frontend = path.join(here, '..', '..', 'frontend');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?|env[\w.-]*|html)$/.test(name) || name.startsWith('.env')) {
          const text = fs.readFileSync(full, 'utf8');
          // Credential names, Algolia endpoints and VITE_ secret-looking variables. The plain engine label 'algolia' is allowed.
          if (/ALGOLIA_[A-Z_]*(KEY|APP|SECRET)|X-Algolia|algolia\.net|VITE_[A-Z_]*(KEY|SECRET|TOKEN)/i.test(text)) offenders.push(path.relative(frontend, full));
        }
      }
    };
    walk(frontend);
    expect(offenders).toEqual([]);
  });
});
