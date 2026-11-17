import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'inverse';

const variants: Record<Variant, string> = {
  primary:
    'bg-gradient-to-r from-teal-600 to-emerald-500 text-white shadow-md shadow-teal-600/20 hover:from-teal-700 hover:to-emerald-600 hover:shadow-lg',
  secondary: 'bg-white text-ink ring-1 ring-slate-200 shadow-sm hover:bg-slate-50 hover:ring-slate-300',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
  ghost: 'text-ink hover:bg-white/70',
  inverse: 'bg-white text-teal-800 shadow-lg shadow-black/10 hover:bg-teal-50',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

export function Button({ variant = 'primary', loading = false, disabled, className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 ${variants[variant]} ${className}`}
    >
      {loading && (
        <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}
