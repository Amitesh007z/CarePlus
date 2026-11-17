import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Library, RefreshCw, Upload, XCircle } from 'lucide-react';
import { ApiError, apiRequest } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { DocDetail, DocStatus, DocView } from './types';

type Confirm = { kind: 'approve' | 'archive'; doc: DocView } | null;

/** Turns an API failure into text. Indexing failures carry a short code in details[0].message. */
function adminErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502 && err.code === 'INDEXING_FAILED') {
      const code = err.details[0]?.message;
      return `Indexing failed${code ? ` (${code})` : ''}. The version was not published.`;
    }
    if (err.status === 422 && err.details.length) {
      return err.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ');
    }
    if (err.status === 401 || err.status === 403) return 'You need an administrator session to manage knowledge documents.';
    return `${err.message}${err.code ? ` (${err.code})` : ''}`;
  }
  return 'Something went wrong. Please try again.';
}

const STATUS_CLS: Record<DocStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 ring-slate-200',
  APPROVED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  SUPERSEDED: 'bg-amber-50 text-amber-800 ring-amber-200',
  ARCHIVED: 'bg-zinc-100 text-zinc-600 ring-zinc-200',
};

export default function KnowledgeAdminPage() {
  const [items, setItems] = useState<DocView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [markdown, setMarkdown] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const r = await apiRequest<{ items: DocView[] }>('/api/v1/admin/knowledge/documents');
      setItems(r.items);
      setListError(null);
    } catch (err) {
      setListError(adminErrorMessage(err));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await apiRequest<DocDetail>(`/api/v1/admin/knowledge/documents/${id}`));
    } catch (err) {
      setActionError(adminErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  async function act(path: string, success: string) {
    if (!selectedId) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await apiRequest<DocView>(`/api/v1/admin/knowledge/documents/${selectedId}/${path}`, { method: 'POST' });
      setNotice(success);
      await Promise.all([loadList(), loadDetail(selectedId)]);
    } catch (err) {
      setActionError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runConfirmed() {
    if (!confirm) return;
    const { kind, doc } = confirm;
    setConfirm(null);
    await act(kind, kind === 'approve' ? `Approved ${doc.slug} v${doc.version}. The previous approved version is superseded.` : `Archived ${doc.slug} v${doc.version}.`);
  }

  async function submitVersion(e: FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setNotice(null);
    setBusy(true);
    try {
      const created = await apiRequest<DocView>('/api/v1/admin/knowledge/documents', { method: 'POST', body: { markdown } });
      setNotice(`Draft ${created.slug} v${created.version} created and indexed. Review it, then approve.`);
      setMarkdown('');
      setSelectedId(created.id);
      await loadList();
    } catch (err) {
      setUploadError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const selected = detail?.document ?? null;
  const canApprove = !!selected && selected.status === 'DRAFT' && selected.indexingStatus === 'INDEXED';
  const canArchive = !!selected && (selected.status === 'DRAFT' || selected.status === 'APPROVED');
  const canReindex = !!selected && selected.status !== 'ARCHIVED';
  const currentApproved = detail?.versions.find((v) => v.status === 'APPROVED') ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <header className="rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-900 to-violet-800 p-6 text-white shadow-xl">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/20">
            <Library className="size-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Knowledge documents</h1>
            <p className="text-sm text-indigo-200">Approved, versioned documents behind Ask CarePulse. Approved versions are never edited in place.</p>
          </div>
        </div>
      </header>

      {notice && (
        <p role="status" className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="flex items-center gap-2 rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200">
          <XCircle className="size-4" aria-hidden="true" />
          {actionError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section aria-labelledby="doc-list-title" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="doc-list-title" className="text-lg font-semibold text-ink">
              Documents
            </h2>
            <Button variant="secondary" onClick={() => void loadList()}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Refresh
            </Button>
          </div>
          {listError && <p role="alert" className="text-sm text-rose-700">{listError}</p>}
          {items === null && !listError && <p role="status" className="text-sm text-slate-500">Loading documents…</p>}
          <ul className="space-y-2" aria-label="Knowledge documents">
            {items?.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  aria-current={selectedId === d.id ? 'true' : undefined}
                  className={`w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition hover:shadow-md ${
                    selectedId === d.id ? 'ring-2 ring-violet-400' : 'ring-slate-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{d.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${STATUS_CLS[d.status]}`}>{d.status}</span>
                    {d.indexingStatus === 'FAILED' ? (
                      <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[11px] font-bold text-white">
                        Failed{d.indexingError ? `: ${d.indexingError}` : ''}
                      </span>
                    ) : (
                      <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800 ring-1 ring-sky-200">
                        {d.indexingStatus}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {d.slug} · v{d.version} · {d.documentType} · {d.audience} · {d.region} · from {d.effectiveFrom}
                    {d.effectiveTo ? ` to ${d.effectiveTo}` : ''} · {d.chunkCount} chunks
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-6">
          <section aria-labelledby="doc-detail-title" className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 id="doc-detail-title" className="text-lg font-semibold text-ink">
              Version details
            </h2>
            {!selected && <p className="text-sm text-slate-500">Select a document to see its versions, content and actions.</p>}
            {selected && detail && (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-slate-500">Audience</dt>
                  <dd className="font-medium text-ink">{selected.audience}</dd>
                  <dt className="text-slate-500">Effective</dt>
                  <dd className="font-medium text-ink">
                    {selected.effectiveFrom}
                    {selected.effectiveTo ? ` to ${selected.effectiveTo}` : ' onward'}
                  </dd>
                  <dt className="text-slate-500">Indexing</dt>
                  <dd className="font-medium text-ink">
                    {selected.indexingStatus}
                    {selected.indexingStatus === 'FAILED' && selected.indexingError && (
                      <span className="ml-2 rounded bg-rose-50 px-1.5 py-0.5 font-mono text-xs text-rose-700">{selected.indexingError}</span>
                    )}
                  </dd>
                  <dt className="text-slate-500">Source</dt>
                  <dd className="text-ink">{selected.source}</dd>
                </dl>

                {selected.status === 'DRAFT' && currentApproved && (
                  <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    Approving this draft supersedes the current approved v{currentApproved.version}. The old version stays in history.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void act('reindex', `Re-indexed ${selected.slug} v${selected.version}.`)} disabled={!canReindex} loading={busy}>
                    Re-index
                  </Button>
                  <Button onClick={() => setConfirm({ kind: 'approve', doc: selected })} disabled={!canApprove || busy}>
                    Approve
                  </Button>
                  <Button variant="danger" onClick={() => setConfirm({ kind: 'archive', doc: selected })} disabled={!canArchive || busy}>
                    Archive
                  </Button>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink">Version history</h3>
                  <ol className="space-y-1.5 text-sm" aria-label="Version history">
                    {detail.versions.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-600">v{v.version}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${STATUS_CLS[v.status]}`}>{v.status}</span>
                        <span className="text-xs text-slate-500">effective {v.effectiveFrom}{v.effectiveTo ? ` to ${v.effectiveTo}` : ''}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink">Content (read-only)</h3>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-100">
                    {detail.content}
                  </pre>
                </div>
              </>
            )}
          </section>

          <section aria-labelledby="new-version-title" className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 id="new-version-title" className="text-lg font-semibold text-ink">
              New version
            </h2>
            <p className="text-sm text-slate-600">
              Paste Markdown with a <code className="font-mono">---</code> front matter block (slug, title, documentType, version,
              effectiveFrom, audience, source). It is saved as a draft and indexed; approve it when you are ready.
            </p>
            <form onSubmit={submitVersion} className="space-y-3">
              <label htmlFor="new-version-markdown" className="sr-only">
                Markdown document
              </label>
              <textarea
                id="new-version-markdown"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                rows={8}
                spellCheck={false}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-ink focus:border-violet-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-violet-100"
                placeholder={'---\nslug: example-policy\ntitle: Example policy\ndocumentType: POLICY\nversion: 2\neffectiveFrom: 2026-01-01\naudience: PATIENT\nsource: Approved by policy owner\n---\n# Example policy\n\nText.'}
              />
              {uploadError && (
                <p role="alert" className="text-sm text-rose-700">
                  {uploadError}
                </p>
              )}
              <div className="flex justify-end">
                <Button type="submit" loading={busy} disabled={markdown.trim().length < 20}>
                  <Upload className="size-4" aria-hidden="true" />
                  Create draft
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>

      <Modal
        open={confirm !== null}
        title={confirm?.kind === 'approve' ? 'Approve this version?' : 'Archive this version?'}
        onClose={() => setConfirm(null)}
      >
        {confirm && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              {confirm.kind === 'approve'
                ? `Approving ${confirm.doc.slug} v${confirm.doc.version} makes it the current answer source. Any approved version of the same document is superseded and kept in history.`
                : `Archiving ${confirm.doc.slug} v${confirm.doc.version} removes it from answers. It stays in the history.`}
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant={confirm.kind === 'archive' ? 'danger' : 'primary'} onClick={() => void runConfirmed()} loading={busy}>
                {confirm.kind === 'approve' ? 'Yes, approve' : 'Yes, archive'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
