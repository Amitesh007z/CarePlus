import { useId, type SelectHTMLAttributes } from 'react';

interface Option {
  value: string;
  label: string;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label: string;
  options: readonly Option[];
  error?: string;
  placeholder?: string;
}

export function Select({ label, options, error, placeholder, className = '', id, ...rest }: SelectProps) {
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <div className="space-y-1.5">
      <label htmlFor={selectId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <select
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${selectId}-error` : undefined}
        className={`block min-h-11 w-full rounded-xl border bg-white/90 px-3.5 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none ${
          error ? 'border-rose-400' : 'border-slate-200'
        } ${className}`}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${selectId}-error`} role="alert" className="text-sm font-medium text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
