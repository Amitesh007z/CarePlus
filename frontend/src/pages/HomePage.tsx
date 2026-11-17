import { ApiStatusCard } from '../features/status/ApiStatusCard';

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Welcome to CarePulse</h1>
        <p className="mt-1 text-slate-600">Foundation build. Feature modules are added checkpoint by checkpoint.</p>
      </div>
      <div className="max-w-md">
        <ApiStatusCard />
      </div>
    </div>
  );
}
