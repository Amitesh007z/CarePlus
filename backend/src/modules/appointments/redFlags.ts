/**
 * Deterministic escalation rules. They cover only the examples named in the source brief
 * (chest pain, breathing difficulty, stroke signs). They are not a clinical triage protocol
 * and must not be presented as one.
 */
export const EMERGENCY_GUIDANCE =
  'Some of the details you entered may describe an emergency. If you feel very unwell, call your local emergency number now. Do not wait for your appointment.';

const RULES: { label: string; pattern: RegExp }[] = [
  {
    label: 'chest pain',
    pattern: /\bchest\s+(pain|pressure|tightness)\b|\bpain\s+in\s+(my\s+|the\s+)?chest\b/i,
  },
  {
    label: 'breathing difficulty',
    pattern:
      /\bbreathing\s+difficult(y|ies)\b|\b(difficulty|difficult|trouble|hard|struggling)\s+(in\s+|with\s+)?breath(ing)?\b|\bcan'?t\s+breathe\b|\bshortness\s+of\s+breath\b|\bgasping\b/i,
  },
  {
    label: 'possible stroke signs',
    pattern: /\bface\s+droop(ing)?\b|\bslurred\s+speech\b|\bone[- ]sided\s+(weakness|numbness)\b|\bsudden\s+(weakness|numbness|confusion)\b/i,
  },
];

/** Returns the labels of every rule the free text matches. Empty means no escalation. */
export function redFlagReasons(text: string): string[] {
  return RULES.filter((r) => r.pattern.test(text)).map((r) => r.label);
}
