import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="py-20 text-center">
      <p className="text-sm font-bold tracking-[0.3em] text-teal-600">404</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink">Page not found</h1>
      <p className="mt-2 text-slate-600">The page you are looking for does not exist.</p>
      <Link to="/" className="mt-8 inline-block rounded-xl bg-gradient-to-r from-teal-600 to-emerald-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-teal-600/20">
        Back to home
      </Link>
    </div>
  );
}
