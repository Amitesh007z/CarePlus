import { useState, type FormEvent } from 'react';
import { AlertTriangle, BookOpen, CircleHelp, Search } from 'lucide-react';
import { ApiError, apiRequest } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import type { Confidence, EscalationOption, KnowledgeAnswer, KnowledgeSource } from './types';

const MIN_CHARS = 3;
const MAX_CHARS = 500;

const CONFIDENCE_TEXT: Record<Confidence, { label: string; meaning: string; cls: string }> = {
  HIGH: {
    label: 'High confidence',
    meaning: 'The answer closely matches approved CarePulse text.',
    cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  },
  MEDIUM: {
    label: 'Medium confidence',
    meaning: 'Related approved text was found. Check the source before you act on it.',
    cls: 'bg-amber-50 text-amber-800 ring-amber-200',
  },
  LOW: {
    label: 'Low confidence',
    meaning: 'Only limited evidence was found. Please confirm with support or a pharmacist.',
    cls: 'bg-rose-50 text-rose-800 ring-rose-200',
  },
};

const ESCALATION_LABEL: Record<EscalationOption, string> = {
  SUPPORT: 'Contact support',
  PHARMACIST: 'Ask a pharmacist',
};

/** Support and pharmacist contact routes do not exist in the app yet, so these stay clearly labelled placeholders. */
const CONTACT_PLACEHOLDER = 'Contact details are not configured yet. This is a placeholder action.';

/** Maps API failures to user-facing messages. Codes are fixed strings from the backend; messages never echo input. */
function askErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session has ended. Please sign in again.';
    if (err.code === 'RATE_LIMITED' || err.status === 429) return 'You have asked a lot of questions in a short time. Please wait a few minutes and try again.';
    if (err.status === 502 || err.status === 503) return 'The knowledge assistant is unavailable right now. Please try again shortly.';
    if (err.status === 422) return err.message;
    if (err.code === 'NETWORK_ERROR') return err.message;
  }
  return 'Something went wrong while answering. Please try again.';
}

type Turn = { id: number; question: string; result: { ok: true; answer: KnowledgeAnswer } | { ok: false; message: string } };

let seq = 0;

export default function AskCarePulsePage() {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const trimmed = question.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_CHARS;

  async function ask(text: string) {
    if (busy) return;
    setBusy(true);
    try {
      const answer = await apiRequest<KnowledgeAnswer>('/api/v1/knowledge/ask', { method: 'POST', body: { question: text } });
      setTurns((t) => [...t, { id: ++seq, question: text, result: { ok: true, answer } }]);
      setQuestion('');
    } catch (err) {
      setTurns((t) => [...t, { id: ++seq, question: text, result: { ok: false, message: askErrorMessage(err) } }]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (trimmed.length < MIN_CHARS || trimmed.length > MAX_CHARS) return;
    void ask(trimmed);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header className="rounded-3xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 p-6 text-white shadow-xl shadow-violet-600/20">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-white/15 ring-1 ring-white/30">
            <BookOpen className="size-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Ask CarePulse</h1>
            <p className="text-sm text-violet-100">Answers come only from approved CarePulse documents, with their source and version.</p>
          </div>
        </div>
      </header>

      <form onSubmit={onSubmit} className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <label htmlFor="ask-question" className="block text-sm font-semibold text-ink">
          Your question
        </label>
        <textarea
          id="ask-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={MAX_CHARS}
          rows={3}
          placeholder="For example: How long does delivery take?"
          aria-describedby="ask-help"
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-ink focus:border-violet-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-violet-100"
        />
        <div id="ask-help" className="flex items-center justify-between text-xs text-slate-500">
          <span role="status">{tooShort ? `Ask at least ${MIN_CHARS} characters.` : 'Questions outside approved documents are not answered.'}</span>
          <span>
            {trimmed.length}/{MAX_CHARS}
          </span>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={trimmed.length < MIN_CHARS || trimmed.length > MAX_CHARS}>
            <Search className="size-4" aria-hidden="true" />
            Ask
          </Button>
        </div>
      </form>

      {busy && (
        <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-2xl bg-violet-50 p-4 text-sm text-violet-800 ring-1 ring-violet-100">
          <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          Searching approved documents…
        </div>
      )}

      <ol className="space-y-5" aria-label="Questions and answers">
        {turns.map((t) => (
          <li key={t.id} className="space-y-3">
            <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-3 text-sm text-white">{t.question}</p>
            {t.result.ok ? (
              <AnswerCard answer={t.result.answer} onFollowUp={() => setQuestion(t.question)} />
            ) : (
              <ErrorCard message={t.result.message} onRetry={() => void ask(t.question)} busy={busy} />
            )}
          </li>
        ))}
      </ol>

      {turns.length === 0 && !busy && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <CircleHelp className="size-4" aria-hidden="true" />
          Try asking about delivery, returns, or a medicine leaflet.
        </p>
      )}
    </div>
  );
}

function AnswerCard({ answer, onFollowUp }: { answer: KnowledgeAnswer; onFollowUp: () => void }) {
  if (answer.notCovered) {
    return (
      <section aria-label="Not found" className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-ink">Not covered by approved documents</h2>
            <p className="mt-1 text-sm text-slate-700">{answer.answer}</p>
          </div>
        </div>
        {answer.escalation && (
          <div className="space-y-3 rounded-xl bg-slate-50 p-4">
            <p className="text-sm text-slate-700">{answer.escalation.message}</p>
            <div className="flex flex-wrap gap-2">
              {answer.escalation.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  title={CONTACT_PLACEHOLDER}
                  className="rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-violet-800 ring-1 ring-violet-200 hover:bg-violet-50"
                >
                  {ESCALATION_LABEL[opt]}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              {CONTACT_PLACEHOLDER}
            </p>
          </div>
        )}
      </section>
    );
  }

  const conf = CONFIDENCE_TEXT[answer.confidence];
  return (
    <section aria-label="Answer" className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${conf.cls}`} data-confidence={answer.confidence}>
          {conf.label}
        </span>
        <span className="text-xs text-slate-500">{conf.meaning}</span>
      </div>
      {answer.fallback && (
        <p role="note" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          The assistant could not summarise this right now, so the closest approved text is shown exactly as written.
        </p>
      )}
      <p className="whitespace-pre-line text-[15px] leading-relaxed text-ink">{answer.answer}</p>
      {answer.sources.length > 0 && <SourceChips sources={answer.sources} />}
      {answer.followUpRequired && (
        <div className="space-y-3 rounded-xl bg-violet-50 p-4 ring-1 ring-violet-100">
          <p className="text-sm font-semibold text-violet-900">Still need help?</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onFollowUp}>
              Ask a follow-up
            </Button>
            {answer.escalation?.options.map((opt) => (
              <button
                key={opt}
                type="button"
                title={CONTACT_PLACEHOLDER}
                className="rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-violet-800 ring-1 ring-violet-200 hover:bg-violet-50"
              >
                {ESCALATION_LABEL[opt]}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SourceChips({ sources }: { sources: KnowledgeSource[] }) {
  return (
    <div aria-label="Sources" className="flex flex-wrap gap-2">
      {sources.map((s) => (
        <span
          key={s.chunkId}
          className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-900 ring-1 ring-indigo-100"
        >
          <BookOpen className="size-3.5" aria-hidden="true" />
          <span className="font-semibold">{s.title}</span>
          <span className="text-indigo-700">· {s.section}</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-indigo-800">v{s.version}</span>
        </span>
      ))}
    </div>
  );
}

function ErrorCard({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 p-4 ring-1 ring-rose-200">
      <p className="text-sm text-rose-800">{message}</p>
      <Button variant="secondary" onClick={onRetry} disabled={busy}>
        Try again
      </Button>
    </div>
  );
}
