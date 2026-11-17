import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../../../infrastructure/database/pool.js';
import type { LlmProvider } from '../llm/provider.js';
import { parseKnowledgeMarkdown } from './knowledge.ingest.js';
import { approveVersion, createDraftVersion, indexDocument } from './knowledge.service.js';

export interface SeedResult {
  file: string;
  slug: string;
  version: number;
  status: 'DRAFT' | 'APPROVED';
}

/**
 * Idempotent corpus seed from a folder of Markdown files. An existing version with the same content is left alone.
 * A version is approved only when its front matter says APPROVED and it is still a draft. Older approved versions of
 * the same slug are superseded by approveVersion, never edited.
 */
export async function seedKnowledgeCorpus(
  db: Database,
  llm: LlmProvider | null,
  dir: string,
  actorUserId: string,
): Promise<SeedResult[]> {
  const actor = { actorId: actorUserId, userId: actorUserId };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const out: SeedResult[] = [];
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    const parsed = parseKnowledgeMarkdown(raw);
    const created = await createDraftVersion(db, raw, actor, llm);
    if (created.indexingStatus !== 'INDEXED') {
      // A draft that failed indexing is re-indexed from its stored content before it can be approved.
      await indexDocument(db, created.id, parsed.body, parsed.meta.title, llm);
    }
    if (parsed.meta.status === 'APPROVED') {
      const cur = await db.query<{ status: string }>('SELECT status FROM knowledge_documents WHERE id = $1', [created.id]);
      if (cur.rows[0]?.status === 'DRAFT') await approveVersion(db, created.id, actor);
    }
    out.push({ file: f, slug: parsed.meta.slug, version: parsed.meta.version, status: parsed.meta.status });
  }
  return out;
}
