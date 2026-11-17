import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isCalendarDate } from '../../../common/http.js';
import { AUDIENCE_OF_TYPE, AUDIENCES, DOCUMENT_TYPES } from './knowledge.policy.js';

/**
 * Markdown ingestion. PDF is deliberately not supported: the approved corpus is Markdown, and a PDF text
 * extractor would add a parsing risk without a source that needs it. Upload Markdown instead.
 */

export const MAX_CHUNK_CHARS = 700;
export const MAX_DOCUMENT_CHARS = 200_000;

const calendarDate = z.string().refine(isCalendarDate, 'use a real date in the format YYYY-MM-DD');

export const frontMatterSchema = z
  .strictObject({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens').min(3).max(80),
    title: z.string().trim().min(3).max(200),
    documentType: z.enum(DOCUMENT_TYPES),
    version: z.coerce.number().int().min(1).max(10000),
    effectiveFrom: calendarDate,
    effectiveTo: calendarDate.optional(),
    region: z.string().regex(/^IN(-[A-Z]{2})?$/, 'IN or IN-XX').default('IN'),
    audience: z.enum(AUDIENCES),
    status: z.enum(['DRAFT', 'APPROVED']).default('DRAFT'),
    source: z.string().trim().min(3).max(300),
  })
  .superRefine((m, ctx) => {
    if (AUDIENCE_OF_TYPE[m.documentType] !== m.audience) {
      ctx.addIssue({ code: 'custom', path: ['audience'], message: `a ${m.documentType} document must have audience ${AUDIENCE_OF_TYPE[m.documentType]}` });
    }
    if (m.effectiveTo && m.effectiveTo < m.effectiveFrom) {
      ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'must not be before effectiveFrom' });
    }
  });
export type FrontMatter = z.infer<typeof frontMatterSchema>;

export class KnowledgeValidationError extends Error {
  constructor(public readonly issues: { path: string; message: string }[]) {
    super(`Invalid knowledge document: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    this.name = 'KnowledgeValidationError';
  }
}

export interface ParsedDocument {
  meta: FrontMatter;
  body: string;
  contentSha256: string;
}

/** Splits `---` front matter (key: value lines) from the Markdown body, then validates both. Errors never echo content. */
export function parseKnowledgeMarkdown(raw: string): ParsedDocument {
  if (typeof raw !== 'string' || raw.length > MAX_DOCUMENT_CHARS) {
    throw new KnowledgeValidationError([{ path: 'document', message: `must be text under ${MAX_DOCUMENT_CHARS} characters` }]);
  }
  const text = raw.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new KnowledgeValidationError([{ path: 'frontMatter', message: 'is missing (expected --- key: value lines ---)' }]);
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) throw new KnowledgeValidationError([{ path: 'frontMatter', message: 'has a line that is not key: value' }]);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value !== '') fields[key] = value;
  }
  const parsed = frontMatterSchema.safeParse(fields);
  if (!parsed.success) {
    throw new KnowledgeValidationError(parsed.error.issues.map((i) => ({ path: String(i.path[0] ?? 'frontMatter'), message: i.message })));
  }
  const body = m[2]!.trim();
  if (body.length < 20) throw new KnowledgeValidationError([{ path: 'body', message: 'is too short to index' }]);
  return { meta: parsed.data, body, contentSha256: sha256(text) };
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface Chunk {
  chunkIndex: number;
  section: string;
  headingPath: string;
  content: string;
}

/**
 * Preserves headings and splits each section into paragraph-based chunks of at most MAX_CHUNK_CHARS.
 * A chunk never crosses a section boundary, so every chunk has exactly one section and heading path.
 */
export function chunkMarkdown(body: string, title: string): Chunk[] {
  type Section = { heading: string; path: string; lines: string[] };
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Section = { heading: title, path: title, lines: [] };
  sections.push(current);

  for (const line of body.split('\n')) {
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!.trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text });
      const names = stack.map((s) => s.text);
      // A top-level heading that already equals the title is not repeated in the path.
      current = { heading: text, path: (names[0] === title ? names : [title, ...names]).join(' > '), lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }

  const out: Chunk[] = [];
  for (const s of sections) {
    const paragraphs = s.lines
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap(splitLongParagraph);
    let buffer = '';
    const flush = () => {
      if (buffer.trim()) {
        out.push({ chunkIndex: out.length, section: s.heading, headingPath: s.path, content: buffer.trim() });
      }
      buffer = '';
    };
    for (const p of paragraphs) {
      if (buffer && buffer.length + p.length + 2 > MAX_CHUNK_CHARS) flush();
      buffer = buffer ? `${buffer}\n\n${p}` : p;
    }
    flush();
  }
  if (out.length === 0) throw new KnowledgeValidationError([{ path: 'body', message: 'produced no indexable text' }]);
  return out;
}

/** A paragraph longer than the limit is split at sentence ends, then hard-cut as a last resort. */
function splitLongParagraph(p: string): string[] {
  if (p.length <= MAX_CHUNK_CHARS) return [p];
  const sentences = p.split(/(?<=[.!?])\s+/);
  const parts: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (s.length > MAX_CHUNK_CHARS) {
      if (buf) parts.push(buf);
      buf = '';
      for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) parts.push(s.slice(i, i + MAX_CHUNK_CHARS));
      continue;
    }
    if (buf && buf.length + s.length + 1 > MAX_CHUNK_CHARS) {
      parts.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/** Text sent to the embedding model: the title and heading path give the passage its context. */
export const embeddingText = (title: string, c: Chunk): string => `${title} — ${c.headingPath}\n${c.content}`;
