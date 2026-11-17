import {
  INDEX_SETTINGS,
  SearchProviderError,
  type IndexName,
  type IndexRecord,
  type SearchProvider,
} from './search-provider.js';

export interface AlgoliaConfig {
  appId: string;
  /** Backend-only write/admin key. Never sent to the browser and never placed in a VITE_ variable. */
  adminKey: string;
  /** Optional restricted key with search ACL only. Used for query calls when present. */
  searchKey?: string;
  timeoutMs?: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_BATCH = 1000; // Algolia's documented batch ceiling per request.

/**
 * Thin REST adapter. Plain fetch keeps the dependency surface small and makes the wire format testable.
 * Every call has a hard timeout. Failures become SearchProviderError, which carries a kind and an HTTP
 * status but never the provider's response body, so no provider detail can reach a client.
 */
export function createAlgoliaProvider(config: AlgoliaConfig, fetchImpl: FetchLike = fetch): SearchProvider {
  const timeout = config.timeoutMs ?? 3000;
  const writeHost = `https://${config.appId}.algolia.net`;
  const readHost = `https://${config.appId}-dsn.algolia.net`;

  async function call(host: string, method: 'GET' | 'POST' | 'PUT', path: string, key: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${host}${path}`, {
        method,
        headers: {
          'X-Algolia-Application-Id': config.appId,
          'X-Algolia-API-Key': key,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new SearchProviderError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE');
    }
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new SearchProviderError(retryable ? 'UNAVAILABLE' : 'REJECTED', res.status);
    }
    return res.status === 204 ? null : res.json();
  }

  const batch = (index: IndexName, requests: { action: string; body: unknown }[]) =>
    call(writeHost, 'POST', `/1/indexes/${index}/batch`, config.adminKey, { requests });

  return {
    async saveObjects(index, records: IndexRecord[]) {
      for (let i = 0; i < records.length; i += MAX_BATCH) {
        // addObject with an objectID replaces the whole object: removed fields cannot linger.
        await batch(index, records.slice(i, i + MAX_BATCH).map((body) => ({ action: 'addObject', body })));
      }
    },

    async deleteObjects(index, objectIds) {
      for (let i = 0; i < objectIds.length; i += MAX_BATCH) {
        await batch(index, objectIds.slice(i, i + MAX_BATCH).map((objectID) => ({ action: 'deleteObject', body: { objectID } })));
      }
    },

    async searchIds(index, query, limit) {
      const out = (await call(readHost, 'POST', `/1/indexes/${index}/query`, config.searchKey ?? config.adminKey, {
        query,
        page: 0,
        hitsPerPage: Math.min(limit, 1000),
        attributesToRetrieve: ['objectID'],
        typoTolerance: true,
      })) as { hits: { objectID: string }[]; nbHits: number };
      return { ids: out.hits.map((h) => h.objectID), nbHits: out.nbHits };
    },

    async listObjectIds(index) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = (await call(readHost, 'POST', `/1/indexes/${index}/browse`, config.adminKey, {
          attributesToRetrieve: ['objectID'],
          hitsPerPage: 1000,
          ...(cursor ? { cursor } : {}),
        })) as { hits: { objectID: string }[]; cursor?: string };
        for (const h of page.hits) ids.push(h.objectID);
        cursor = page.cursor;
      } while (cursor);
      return ids;
    },

    async configure(index) {
      await call(writeHost, 'PUT', `/1/indexes/${index}/settings`, config.adminKey, INDEX_SETTINGS[index]);
    },
  };
}
