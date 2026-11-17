import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function Input({ label, error, hint, className = '', id, ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`block min-h-11 w-full rounded-xl border bg-white/90 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none ${
          error ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/15' : 'border-slate-200'
        } ${className}`}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-sm font-medium text-rose-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
