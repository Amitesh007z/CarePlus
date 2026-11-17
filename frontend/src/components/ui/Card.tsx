import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function Card({ title, description, actions, className = '', children, ...rest }: CardProps) {
  return (
    <section
      {...rest}
      className={`rounded-2xl border border-white/70 bg-white/85 p-6 shadow-[0_1px_2px_rgba(15,42,46,0.04),0_8px_24px_-12px_rgba(15,42,46,0.12)] ring-1 ring-slate-900/5 backdrop-blur ${className}`}
    >
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
