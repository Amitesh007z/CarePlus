export function DisclaimerBar({ text }: { text: string }) {
  return (
    <p className="rounded-xl bg-slate-100/80 px-4 py-3 text-xs leading-relaxed text-slate-600">
      <span className="font-semibold text-slate-700">Disclaimer. </span>
      {text}
    </p>
  );
}
