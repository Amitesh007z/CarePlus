import { audit, type AuditContext } from '../../../common/audit.js';
import { AppError, notFound } from '../../../common/errors/AppError.js';
import type { Database, Queryable } from '../../../infrastructure/database/pool.js';
import type { LlmProvider } from '../llm/provider.js';
import { chunkMarkdown, embeddingText, KnowledgeValidationError, parseKnowledgeMarkdown, type Chunk } from './knowledge.ingest.js';
import type { DocumentType, Audience } from './knowledge.policy.js';

export const EMBED_BATCH = 50;
/** Indexing is an admin action with a larger budget than a patient question. */
export const INDEX_EMBED_TIMEOUT_MS = 30_000;

export type IndexingStatus = 'PENDING' | 'INDEXING' | 'INDEXED' | 'FAILED';

export interface KnowledgeDocumentView {
  id: string;
  slug: string;
  title: string;
  documentType: DocumentType;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  region: string;
  audience: Audience;
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'ARCHIVED';
  source: string;
  indexingStatus: IndexingStatus;
  indexingError: string | null;
  indexedAt: string | null;
  chunkCount: number;
  supersededById: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  slug: string;
  title: string;
  document_type: DocumentType;
  version: number;
  effective_from: string;
  effective_to: string | null;
  region: string;
  audience: Audience;
  status: KnowledgeDocumentView['status'];
  source: string;
  indexing_status: IndexingStatus;
  indexing_error: string | null;
  indexed_at: Date | null;
  chunk_count: number;
  superseded_by_id: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const LIST_COLS = `id, slug, title, document_type, version, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
  to_char(effective_to, 'YYYY-MM-DD') AS effective_to, region, audience, status, source, indexing_status, indexing_error,
  indexed_at, chunk_count, superseded_by_id, approved_at, created_at, updated_at`;

export const toView = (r: Row): KnowledgeDocumentView => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  documentType: r.document_type,
  version: r.version,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  region: r.region,
  audience: r.audience,
  status: r.status,
  source: r.source,
  indexingStatus: r.indexing_status,
  indexingError: r.indexing_error,
  indexedAt: r.indexed_at?.toISOString() ?? null,
  chunkCount: r.chunk_count,
  supersededById: r.superseded_by_id,
  approvedAt: r.approved_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export const vectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

/** Error codes stored in indexing_error. Short and fixed, so they never carry document text or provider output. */
function indexingCode(err: unknown): string {
  if (err && typeof err === 'object' && 'kind' in err) {
    return (err as { kind: string }).kind === 'TIMEOUT' ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_UNAVAILABLE';
  }
  return 'INDEXING_FAILED';
}

/**
 * Creates a DRAFT version from Markdown. Versions are never overwritten: the same slug and version number with
 * different content is refused, and the same content is returned as-is (idempotent).
 */
export async function createDraftVersion(
  db: Database,
  raw: string,
  actor: AuditContext & { userId: string },
  llm: LlmProvider | null,
): Promise<KnowledgeDocumentView> {
  const parsed = parseKnowledgeMarkdown(raw);
  const m = parsed.meta;
  // Uploads arrive as DRAFT; approval is a separate, explicit step.
  const doc = await db.transaction(async (tx) => {
    const existing = await tx.query<Row>(`SELECT ${LIST_COLS} FROM knowledge_documents WHERE slug = $1 AND version = $2`, [m.slug, m.version]);
    if (existing.rows[0]) {
      const sameContent = await tx.query<{ content_sha256: string }>(`SELECT content_sha256 FROM knowledge_documents WHERE id = $1`, [existing.rows[0].id]);
      if (sameContent.rows[0]?.content_sha256 === parsed.contentSha256) return { row: existing.rows[0], created: false };
      throw new AppError(409, 'VERSION_EXISTS', `Version ${m.version} of this document already exists with different content. Use the next version number.`);
    }
    const latest = await tx.query<{ v: number }>(`SELECT COALESCE(MAX(version), 0)::int AS v FROM knowledge_documents WHERE slug = $1`, [m.slug]);
    if (m.version <= (latest.rows[0]?.v ?? 0)) {
      throw new AppError(409, 'VERSION_NOT_NEWER', `Version must be greater than ${latest.rows[0]!.v} for this document.`);
    }
    const ins = await tx.query<Row>(
      `INSERT INTO knowledge_documents (slug, title, document_type, version, effective_from, effective_to, region, audience,
         status, source, content_markdown, content_sha256, indexing_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10, $11, 'PENDING', $12)
       RETURNING ${LIST_COLS}`,
      [m.slug, m.title, m.documentType, m.version, m.effectiveFrom, m.effectiveTo ?? null, m.region, m.audience, m.source, parsed.body, parsed.contentSha256, actor.userId],
    );
    await audit(tx, actor, { action: 'knowledge.version_created', entityType: 'knowledge_document', entityId: ins.rows[0]!.id, after: { slug: m.slug, version: m.version } });
    return { row: ins.rows[0]!, created: true };
  });
  if (!doc.created) return toView(doc.row);
  // Indexing happens outside the transaction: embedding calls are slow and must not hold a database transaction open.
  return toView(await indexDocument(db, doc.row.id, parsed.body, m.title, llm));
}

/**
 * Chunks, embeds and persists one document version. Chunks are replaced atomically: a failure leaves the previous
 * chunks in place and records FAILED with a short code.
 */
export async function indexDocument(
  db: Database,
  docId: string,
  body: string,
  title: string,
  llm: LlmProvider | null,
): Promise<Row> {
  await db.query(`UPDATE knowledge_documents SET indexing_status = 'INDEXING', indexing_error = NULL WHERE id = $1 AND status <> 'APPROVED'`, [docId]);
  try {
    let chunks: Chunk[];
    try {
      chunks = chunkMarkdown(body, title);
    } catch (err) {
      if (err instanceof KnowledgeValidationError) throw new IndexingError('CHUNKING_FAILED');
      throw err;
    }
    if (!llm?.embed) throw new IndexingError('EMBEDDING_NOT_CONFIGURED');
    const vectors: number[][] = [];
    const texts = chunks.map((c) => embeddingText(title, c));
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      vectors.push(...(await llm.embed(texts.slice(i, i + EMBED_BATCH), 'document', INDEX_EMBED_TIMEOUT_MS)));
    }
    if (vectors.length !== chunks.length) throw new IndexingError('EMBEDDING_SHAPE');
    const row = await db.transaction(async (tx) => {
      await tx.query('DELETE FROM document_chunks WHERE document_id = $1', [docId]);
      for (const [i, c] of chunks.entries()) {
        await tx.query(
          `INSERT INTO document_chunks (document_id, chunk_index, section, heading_path, content, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)`,
          [docId, c.chunkIndex, c.section.slice(0, 200), c.headingPath.slice(0, 400), c.content, vectorLiteral(vectors[i]!)],
        );
      }
      const r = await tx.query<Row>(
        `UPDATE knowledge_documents SET indexing_status = 'INDEXED', indexing_error = NULL, indexed_at = now(), chunk_count = $2
         WHERE id = $1 RETURNING ${LIST_COLS}`,
        [docId, chunks.length],
      );
      return r.rows[0]!;
    });
    return row;
  } catch (err) {
    const code = err instanceof IndexingError ? err.code : indexingCode(err);
    await db.query(`UPDATE knowledge_documents SET indexing_status = 'FAILED', indexing_error = $2 WHERE id = $1`, [docId, code]);
    throw new AppError(502, 'INDEXING_FAILED', 'Indexing failed. The document was not published. See the indexing error code.', [{ path: 'indexingError', message: code }]);
  }
}

class IndexingError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export async function reindexDocument(db: Database, docId: string, llm: LlmProvider | null, actor: AuditContext): Promise<KnowledgeDocumentView> {
  const r = await db.query<Row & { content_markdown: string }>(
    `SELECT ${LIST_COLS}, content_markdown FROM knowledge_documents WHERE id = $1`,
    [docId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Document version not found');
  if (row.status === 'ARCHIVED') throw new AppError(409, 'ARCHIVED', 'Archived versions cannot be re-indexed');
  const updated = await indexDocument(db, docId, row.content_markdown, row.title, llm);
  await audit(db, actor, { action: 'knowledge.reindexed', entityType: 'knowledge_document', entityId: docId, after: { chunks: updated.chunk_count } });
  return toView(updated);
}

/**
 * Approves an indexed DRAFT. In one transaction the previous approved version of the same slug is SUPERSEDED and
 * kept for history. Only one version per slug can be APPROVED at any time.
 */
export async function approveVersion(db: Database, docId: string, actor: AuditContext): Promise<KnowledgeDocumentView> {
  return db.transaction(async (tx: Queryable) => {
    const cur = await tx.query<Row>(`SELECT ${LIST_COLS} FROM knowledge_documents WHERE id = $1 FOR UPDATE`, [docId]);
    const doc = cur.rows[0];
    if (!doc) throw notFound('Document version not found');
    if (doc.status !== 'DRAFT') throw new AppError(409, 'NOT_DRAFT', 'Only a draft version can be approved');
    if (doc.indexing_status !== 'INDEXED') throw new AppError(409, 'NOT_INDEXED', 'Index the version successfully before approving it');
    const prev = await tx.query<{ id: string }>(
      `SELECT id FROM knowledge_documents WHERE slug = $1 AND status = 'APPROVED' FOR UPDATE`,
      [doc.slug],
    );
    for (const p of prev.rows) {
      await tx.query(`UPDATE knowledge_documents SET status = 'SUPERSEDED', superseded_by_id = $2 WHERE id = $1`, [p.id, docId]);
    }
    const up = await tx.query<Row>(
      `UPDATE knowledge_documents SET status = 'APPROVED', approved_at = now() WHERE id = $1 RETURNING ${LIST_COLS}`,
      [docId],
    );
    await audit(tx, actor, {
      action: 'knowledge.approved',
      entityType: 'knowledge_document',
      entityId: docId,
      after: { slug: doc.slug, version: doc.version, supersededIds: prev.rows.map((p) => p.id) },
    });
    return toView(up.rows[0]!);
  });
}

export async function archiveVersion(db: Database, docId: string, actor: AuditContext): Promise<KnowledgeDocumentView> {
  const cur = await db.query<Row>(`SELECT ${LIST_COLS} FROM knowledge_documents WHERE id = $1`, [docId]);
  if (!cur.rows[0]) throw notFound('Document version not found');
  if (cur.rows[0].status === 'SUPERSEDED') throw new AppError(409, 'SUPERSEDED', 'Superseded versions are kept as history and cannot be archived');
  const up = await db.query<Row>(`UPDATE knowledge_documents SET status = 'ARCHIVED' WHERE id = $1 RETURNING ${LIST_COLS}`, [docId]);
  await audit(db, actor, { action: 'knowledge.archived', entityType: 'knowledge_document', entityId: docId });
  return toView(up.rows[0]!);
}

export async function listDocuments(db: Queryable): Promise<KnowledgeDocumentView[]> {
  const r = await db.query<Row>(`SELECT ${LIST_COLS} FROM knowledge_documents ORDER BY slug ASC, version DESC`);
  return r.rows.map(toView);
}

/** One document with its full version history (same slug). Content is returned to admins only. */
export async function getDocument(db: Queryable, docId: string): Promise<{ document: KnowledgeDocumentView; content: string; versions: KnowledgeDocumentView[] }> {
  const r = await db.query<Row & { content_markdown: string }>(`SELECT ${LIST_COLS}, content_markdown FROM knowledge_documents WHERE id = $1`, [docId]);
  const row = r.rows[0];
  if (!row) throw notFound('Document not found');
  const versions = await db.query<Row>(`SELECT ${LIST_COLS} FROM knowledge_documents WHERE slug = $1 ORDER BY version DESC`, [row.slug]);
  return { document: toView(row), content: row.content_markdown, versions: versions.rows.map(toView) };
}
