import { HelpCircle } from 'lucide-react';

/** Clarification state: asks one question and shows no recommendations until the patient answers. */
export function ClarificationPrompt({ question }: { question: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-sky-50 p-4 text-sm text-sky-900 ring-1 ring-sky-100">
      <HelpCircle className="mt-0.5 size-5 shrink-0 text-sky-600" aria-hidden="true" />
      <p>{question}</p>
    </div>
  );
}
