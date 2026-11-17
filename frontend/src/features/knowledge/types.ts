/** Mirrors the AI-B (knowledge assistant) response and the admin knowledge API. Keep in step with the backend. */

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface KnowledgeSource {
  documentId: string;
  chunkId: string;
  title: string;
  documentType: string;
  section: string;
  version: number;
  effectiveFrom: string;
  score: number;
}

export type EscalationOption = 'SUPPORT' | 'PHARMACIST';

export interface Escalation {
  offered: true;
  message: string;
  options: EscalationOption[];
}

export interface KnowledgeAnswer {
  answer: string;
  confidence: Confidence;
  notCovered: boolean;
  /** True when the model could not summarise and the approved passage is shown verbatim. */
  fallback: boolean;
  sources: KnowledgeSource[];
  followUpRequired: boolean;
  escalation: Escalation | null;
}

export type DocStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'ARCHIVED';
export type IndexingStatus = 'PENDING' | 'INDEXING' | 'INDEXED' | 'FAILED';

export interface DocView {
  id: string;
  slug: string;
  title: string;
  documentType: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  region: string;
  audience: string;
  status: DocStatus;
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

export interface DocDetail {
  document: DocView;
  content: string;
  versions: DocView[];
}
