-- C9: approved, versioned knowledge documents for the AI-B assistant. Storage and vector search are both in
-- PostgreSQL (Neon) using pgvector. No external graph or vector database.
--
-- Version rules enforced here, not only in code:
--   * Content and identity columns of a non-DRAFT version never change. A change means a new version row.
--   * Status moves only DRAFT -> APPROVED | ARCHIVED and APPROVED -> SUPERSEDED | ARCHIVED.
--   * Versions are never deleted.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  document_type     text NOT NULL CHECK (document_type IN ('POLICY', 'FAQ', 'MEDICINE_LEAFLET', 'CLINICAL_PROTOCOL', 'PHARMACY_PROCEDURE')),
  version           integer NOT NULL CHECK (version >= 1),
  effective_from    date NOT NULL,
  effective_to      date,
  region            text NOT NULL DEFAULT 'IN' CHECK (region ~ '^IN(-[A-Z]{2})?$'),
  audience          text NOT NULL CHECK (audience IN ('PATIENT', 'CLINICIAN', 'STAFF')),
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED', 'ARCHIVED')),
  source            text NOT NULL CHECK (char_length(source) BETWEEN 3 AND 300),
  content_markdown  text NOT NULL CHECK (char_length(content_markdown) BETWEEN 20 AND 200000),
  content_sha256    text NOT NULL CHECK (char_length(content_sha256) = 64),
  indexing_status   text NOT NULL DEFAULT 'PENDING' CHECK (indexing_status IN ('PENDING', 'INDEXING', 'INDEXED', 'FAILED')),
  -- A short error code only. Never document text, never provider responses.
  indexing_error    text CHECK (indexing_error IS NULL OR char_length(indexing_error) <= 120),
  indexed_at        timestamptz,
  chunk_count       integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  superseded_by_id  uuid REFERENCES knowledge_documents (id) ON DELETE RESTRICT,
  approved_at       timestamptz,
  created_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_version_unique UNIQUE (slug, version),
  CONSTRAINT knowledge_effective_range_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Audience follows document type, so a clinician protocol can never be labelled as patient-facing.
  CONSTRAINT knowledge_type_audience_chk CHECK (
    (document_type IN ('POLICY', 'FAQ', 'MEDICINE_LEAFLET') AND audience = 'PATIENT')
    OR (document_type = 'CLINICAL_PROTOCOL' AND audience = 'CLINICIAN')
    OR (document_type = 'PHARMACY_PROCEDURE' AND audience = 'STAFF')
  )
);
-- Retrieval requires indexing_status = 'INDEXED'. A version that fails re-indexing while approved is therefore
-- excluded from answers (fail closed) until it is re-indexed successfully. Approval itself requires INDEXED.
-- At most one approved version per document slug at a time. Supersession is a single transaction.
CREATE UNIQUE INDEX knowledge_one_approved_per_slug_uniq ON knowledge_documents (slug) WHERE status = 'APPROVED';
CREATE INDEX knowledge_documents_retrieval_idx ON knowledge_documents (status, audience, document_type, region, effective_from);
CREATE TRIGGER knowledge_documents_set_updated_at BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE document_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES knowledge_documents (id) ON DELETE RESTRICT,
  chunk_index   integer NOT NULL CHECK (chunk_index >= 0),
  section       text NOT NULL CHECK (char_length(section) BETWEEN 1 AND 200),
  heading_path  text NOT NULL CHECK (char_length(heading_path) BETWEEN 1 AND 400),
  content       text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  -- Gemini gemini-embedding-001 with outputDimensionality 768. Must match the adapter setting.
  embedding     vector(768) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_order_uniq UNIQUE (document_id, chunk_index)
);
CREATE INDEX document_chunks_document_idx ON document_chunks (document_id);
CREATE INDEX document_chunks_embedding_hnsw_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION knowledge_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge versions are never deleted; archive them instead';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.slug IS DISTINCT FROM OLD.slug
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
    OR NEW.region IS DISTINCT FROM OLD.region
    OR NEW.audience IS DISTINCT FROM OLD.audience
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.content_markdown IS DISTINCT FROM OLD.content_markdown
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
  ) THEN
    RAISE EXCEPTION 'approved knowledge versions are immutable; create a new version instead';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'ARCHIVED'))
      OR (OLD.status = 'APPROVED' AND NEW.status IN ('SUPERSEDED', 'ARCHIVED'))
    ) THEN
      RAISE EXCEPTION 'invalid knowledge status change % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_documents_guard_trg BEFORE UPDATE OR DELETE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION knowledge_documents_guard();
