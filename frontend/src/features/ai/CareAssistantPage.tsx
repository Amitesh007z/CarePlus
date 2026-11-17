import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Send, Sparkles } from 'lucide-react';
import { ApiError, apiRequest } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import { Hero } from '../dashboards/RoleDashboard';
import { AddToCartDialog } from './AddToCartDialog';
import { ClarificationPrompt } from './ClarificationPrompt';
import { DisclaimerBar } from './DisclaimerBar';
import { DoctorCard } from './DoctorCard';
import { EmergencyPanel } from './EmergencyPanel';
import { ProductCard } from './ProductCard';
import { UrgencyBadge } from './UrgencyBadge';
import type { CareResponse, RecommendedProduct } from './types';

const MAX_CHARS = 500;

type Turn =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; response: CareResponse }
  | { id: number; kind: 'error'; code: string; message: string };

let turnSeq = 0;
const nextId = () => ++turnSeq;

export default function CareAssistantPage() {
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState('');
  const [cartCandidate, setCartCandidate] = useState<RecommendedProduct | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const pending = pendingText !== null;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [turns, pending]);

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || pending) return;
    setLastSent(clean);
    setTurns((t) => [...t, { id: nextId(), kind: 'user', text: clean }]);
    setInput('');
    setPendingText(clean);
    try {
      const response = await apiRequest<CareResponse>('/api/v1/ai/care/message', { method: 'POST', body: { message: clean } });
      setTurns((t) => [...t, { id: nextId(), kind: 'assistant', response }]);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const message = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
      setTurns((t) => [...t, { id: nextId(), kind: 'error', code, message }]);
    } finally {
      setPendingText(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  async function confirmAddToCart() {
    if (!cartCandidate) return;
    setCartBusy(true);
    try {
      // The only cart write on this screen. It is reached solely through the confirmation dialog.
      await apiRequest('/api/v1/patients/me/cart/items', { method: 'POST', body: { medicineId: cartCandidate.id, quantity: 1 } });
      toast.notify('success', `${cartCandidate.name} added to your cart.`);
      setCartCandidate(null);
    } catch (err) {
      toast.notify('error', err instanceof ApiError ? err.message : 'Could not add to cart. Please try again.');
    } finally {
      setCartBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Hero
        role="PATIENT"
        title="Ask the CarePulse care assistant"
        subtitle="Describe what you need. I suggest doctors and over-the-counter items from CarePulse. I do not diagnose."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <section aria-label="Conversation" className="flex min-h-[28rem] flex-col rounded-3xl bg-white/80 p-4 shadow-sm ring-1 ring-slate-900/5 sm:p-6">
          <div className="flex-1 space-y-5">
            {turns.length === 0 && !pending && (
              <div className="grid place-items-center gap-3 py-10 text-center text-slate-500">
                <Sparkles className="size-10 text-teal-500" aria-hidden="true" />
                <p className="max-w-sm text-sm">Try: “I have a dry cough for two days.” Adding details such as how long it has lasted helps.</p>
              </div>
            )}

            {turns.map((t) => {
              if (t.kind === 'user') {
                return (
                  <div key={t.id} className="flex justify-end">
                    <p className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-r from-teal-600 to-emerald-500 px-4 py-2.5 text-sm text-white shadow-md shadow-teal-600/20">
                      {t.text}
                    </p>
                  </div>
                );
              }
              if (t.kind === 'error') {
                const consent = t.code === 'CONSENT_REQUIRED';
                const rateLimited = t.code === 'RATE_LIMITED';
                return (
                  <div key={t.id} role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-100">
                    <span>{rateLimited ? 'You have asked a lot in a short time. Please wait a few minutes, then try again.' : t.message}</span>
                    {consent && (
                      <Link to="/patient/profile" className="font-semibold underline">
                        Grant consent in your profile
                      </Link>
                    )}
                    {!consent && !rateLimited && lastSent && (
                      <Button variant="secondary" onClick={() => void send(lastSent)}>
                        Try again
                      </Button>
                    )}
                  </div>
                );
              }
              return <AssistantTurn key={t.id} response={t.response} onAddToCart={setCartCandidate} />;
            })}

            {pending && (
              <div role="status" className="flex items-center gap-3 text-sm text-slate-500">
                <span className="grid size-8 place-items-center rounded-full bg-teal-50 text-teal-700">
                  <Bot className="size-4 animate-pulse" aria-hidden="true" />
                </span>
                <span>Checking CarePulse…</span>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={onSubmit} className="mt-6 flex items-end gap-3 border-t border-slate-100 pt-4">
            <label className="flex-1">
              <span className="sr-only">Describe what you need</span>
              <textarea
                rows={2}
                maxLength={MAX_CHARS}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                placeholder="Describe what you need help with…"
                className="w-full resize-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none"
              />
            </label>
            <Button type="submit" loading={pending} disabled={!input.trim()} aria-label="Send message">
              <Send className="size-4" aria-hidden="true" /> Send
            </Button>
          </form>
          <p className="mt-2 text-right text-xs text-slate-400">
            {input.length}/{MAX_CHARS}
          </p>
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl bg-white/80 p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-900/5">
            <h2 className="mb-2 font-semibold text-ink">How this works</h2>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>Suggestions come only from CarePulse doctors and the catalogue.</li>
              <li>Prescription-only medicines are never suggested.</li>
              <li>Nothing is booked or added to your cart until you confirm.</li>
              <li>For an emergency, call your local emergency number.</li>
            </ul>
          </div>
        </aside>
      </div>

      <AddToCartDialog product={cartCandidate} busy={cartBusy} onConfirm={() => void confirmAddToCart()} onCancel={() => setCartCandidate(null)} />
    </div>
  );
}

function AssistantTurn({ response, onAddToCart }: { response: CareResponse; onAddToCart: (p: RecommendedProduct) => void }) {
  const emergency = response.urgency === 'EMERGENCY';
  // Cards appear only in the normal state. Emergency and clarification never show recommendations.
  const showCards = !emergency && !response.clarificationRequired;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-8 place-items-center rounded-full bg-teal-50 text-teal-700">
          <Bot className="size-4" aria-hidden="true" />
        </span>
        {!emergency && <UrgencyBadge urgency={response.urgency} />}
      </div>

      {emergency ? (
        <EmergencyPanel message={response.safetyMessage} />
      ) : (
        <>
          <p className="text-sm leading-relaxed text-ink">{response.summary}</p>
          {response.clarificationRequired && response.clarificationQuestion && <ClarificationPrompt question={response.clarificationQuestion} />}
          {showCards && response.recommendedDoctors.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {response.recommendedDoctors.map((d) => (
                <DoctorCard key={d.id} doctor={d} />
              ))}
            </div>
          )}
          {showCards && response.recommendedProducts.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {response.recommendedProducts.map((p) => (
                <ProductCard key={p.id} product={p} onAddToCart={onAddToCart} />
              ))}
            </div>
          )}
          {showCards && response.safetyMessage && <p className="text-sm text-slate-600">{response.safetyMessage}</p>}
        </>
      )}

      <DisclaimerBar text={response.disclaimer} />
    </div>
  );
}
