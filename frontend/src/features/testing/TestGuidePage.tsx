import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../lib/auth-context';
import type { Role } from '../../types/auth';

/**
 * In-app testing guide. Synthetic demo accounts only. Passwords shown here are local demo passwords and must never
 * be used outside the demo database. The mirror of this content lives in docs/testing/rbac-and-checklist.md.
 */
const DEMO_PASSWORD = 'Demo@1234';

const ACCOUNTS: { role: Role; email: string; password: string; use: string }[] = [
  { role: 'PATIENT', email: 'anita.rao@example.com', password: DEMO_PASSWORD, use: 'Patient with consent and profile. Care assistant, Ask CarePulse, orders.' },
  { role: 'PATIENT', email: 'vikram.s@example.com', password: DEMO_PASSWORD, use: 'Second patient, for checking that data stays separate.' },
  { role: 'DOCTOR', email: 'dr.mehta@example.com', password: DEMO_PASSWORD, use: 'Doctor workspace. Can read clinician documents through Ask CarePulse.' },
  { role: 'PHARMACIST', email: 'pharmacist@example.com', password: 'value of SEED_PHARMACIST_PASSWORD in backend/.env', use: 'Pharmacy queue, stock, prescription review. Can read staff procedures.' },
  { role: 'ADMIN', email: 'admin@example.com', password: DEMO_PASSWORD, use: 'Catalogue, knowledge console and versions. Reads every audience for review.' },
];

const ACCESS: { area: string; PATIENT: string; DOCTOR: string; PHARMACIST: string; ADMIN: string }[] = [
  { area: 'Dashboard (own role)', PATIENT: 'Yes', DOCTOR: 'Yes', PHARMACIST: 'Yes', ADMIN: 'Yes' },
  { area: 'Doctor directory and booking', PATIENT: 'Yes', DOCTOR: 'No', PHARMACIST: 'No', ADMIN: 'No' },
  { area: 'Doctor consultations and patient chart', PATIENT: 'No', DOCTOR: 'Yes', PHARMACIST: 'No', ADMIN: 'No' },
  { area: 'Prescriptions (issue)', PATIENT: 'No', DOCTOR: 'Yes', PHARMACIST: 'No', ADMIN: 'No' },
  { area: 'Prescriptions (view own)', PATIENT: 'Yes', DOCTOR: 'No', PHARMACIST: 'No', ADMIN: 'No' },
  { area: 'Cart, checkout, orders', PATIENT: 'Yes', DOCTOR: 'No', PHARMACIST: 'No', ADMIN: 'No' },
  { area: 'Pharmacy queue, orders, stock', PATIENT: 'No', DOCTOR: 'No', PHARMACIST: 'Yes', ADMIN: 'No' },
  { area: 'Admin medicines and knowledge console', PATIENT: 'No', DOCTOR: 'No', PHARMACIST: 'No', ADMIN: 'Yes' },
  { area: 'Medicine catalogue (public)', PATIENT: 'Yes', DOCTOR: 'Yes', PHARMACIST: 'Yes', ADMIN: 'Yes' },
  { area: 'Care assistant (AI-A)', PATIENT: 'Yes', DOCTOR: 'No', PHARMACIST: 'No', ADMIN: 'No' },
  { area: 'Ask CarePulse (AI-B)', PATIENT: 'Yes', DOCTOR: 'Yes', PHARMACIST: 'Yes', ADMIN: 'Yes' },
  { area: 'This test guide', PATIENT: 'Yes', DOCTOR: 'Yes', PHARMACIST: 'Yes', ADMIN: 'Yes' },
];

interface Item {
  id: string;
  text: string;
  roles: Role[] | 'ALL';
}

const CHECKLIST: Item[] = [
  { id: 'c1', roles: 'ALL', text: 'Sign in with your account. The role chip and nav match the role in the access table.' },
  { id: 'c2', roles: 'ALL', text: 'Nav bar fits the window at narrow, tablet and wide widths. Links scroll sideways in the middle sizes.' },
  { id: 'c3', roles: 'ALL', text: 'Sign out returns you to the login page, and the Back button does not reopen the session.' },
  { id: 'p1', roles: ['PATIENT'], text: 'Care assistant: "I have a dry cough for two days" shows SELF_CARE, product cards with prices and doctor cards.' },
  { id: 'p2', roles: ['PATIENT'], text: 'Care assistant: "Severe chest pain since this morning" shows the emergency panel and no cards.' },
  { id: 'p3', roles: ['PATIENT'], text: 'Care assistant: "I feel off" asks what you need help with and shows no cards.' },
  { id: 'p4', roles: ['PATIENT'], text: 'Care assistant: "Add to cart" opens a confirmation first. Cancelling adds nothing.' },
  { id: 'p5', roles: ['PATIENT'], text: 'Ask CarePulse: "What is your return and refund policy?" gives a grounded answer with a source chip, section and version.' },
  { id: 'p6', roles: ['PATIENT'], text: 'Ask CarePulse: "Show me the clinician triage protocol" returns not-found with support and pharmacist options.' },
  { id: 'p7', roles: ['PATIENT'], text: 'Ask CarePulse: "Does CarePulse cover my health insurance claims?" returns not-found.' },
  { id: 'p8', roles: ['PATIENT'], text: 'Doctor booking: pick a slot and confirm. Cancelling inside 2 hours shows the simulated INR 100 fee.' },
  { id: 'p9', roles: ['PATIENT'], text: 'Health page: add a penicillin allergy. The care assistant then removes penicillin-class items.' },
  { id: 'p10', roles: ['PATIENT'], text: 'Profile: withdraw consent. The care assistant then refuses with a consent message.' },
  { id: 'd1', roles: ['DOCTOR'], text: 'Open a patient chart and a consultation. Add vitals, and check that an impossible value is refused.' },
  { id: 'd2', roles: ['DOCTOR'], text: 'Issue a prescription. A medicine that matches a recorded allergy is blocked.' },
  { id: 'd3', roles: ['DOCTOR'], text: 'Ask CarePulse: "Clinician triage protocol for chest pain" gives the clinician document as a source.' },
  { id: 'd4', roles: ['DOCTOR'], text: 'Doctor cannot open the admin console or the pharmacy queue (access table).' },
  { id: 'h1', roles: ['PHARMACIST'], text: 'Pharmacy queue: open a prescription, review it, and check the allergy warning is shown.' },
  { id: 'h2', roles: ['PHARMACIST'], text: 'Stock: adjust a quantity and check the movement appears in the history.' },
  { id: 'h3', roles: ['PHARMACIST'], text: 'Ask CarePulse: "What does the dispensing procedure say about the allergy record?" gives the staff procedure.' },
  { id: 'h4', roles: ['PHARMACIST'], text: 'Pharmacist cannot open clinician documents through Ask CarePulse (only patient and staff documents).' },
  { id: 'a1', roles: ['ADMIN'], text: 'Knowledge: list documents and open one. Check audience, effective date and indexing status.' },
  { id: 'a2', roles: ['ADMIN'], text: 'Knowledge: upload a new version as a draft, re-index it, then approve. The old version is marked superseded.' },
  { id: 'a3', roles: ['ADMIN'], text: 'Knowledge: uploading the same version number with different text is refused.' },
  { id: 'a4', roles: ['ADMIN'], text: 'Medicines: add or change a medicine and check the public catalogue reflects it.' },
  { id: 'a5', roles: ['ADMIN'], text: 'Admin pages are closed to patients, doctors and pharmacists (direct URL gives access denied).' },
  { id: 'x1', roles: 'ALL', text: 'Turn off the AI key (or stop the AI call) and check that appointments, orders and prescriptions still work.' },
];

const STORAGE_KEY = 'carepulse-test-checklist';

export function TestGuidePage() {
  const { user } = useAuth();
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    try {
      setDone(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>);
    } catch {
      setDone({});
    }
  }, []);

  const toggle = (id: string) => {
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const items = useMemo(
    () => CHECKLIST.filter((i) => showAll || i.roles === 'ALL' || (user && i.roles.includes(user.role))),
    [showAll, user],
  );
  const total = items.length;
  const finished = items.filter((i) => done[i.id]).length;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-teal-700">Testing</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink">Test guide</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Demo accounts, what each role can reach, and a checklist. Everything here is synthetic. Passwords are local demo passwords only.
        </p>
      </header>

      <section aria-labelledby="accounts" className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 id="accounts" className="text-lg font-semibold text-ink">Demo accounts</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Password</th>
                <th className="py-2">Use it for</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ACCOUNTS.map((a) => (
                <tr key={a.email}>
                  <td className="py-2 pr-3 font-semibold text-ink">{a.role}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{a.email}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{a.password}</td>
                  <td className="py-2 text-slate-600">{a.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          If an account is missing, run <code>npm run seed</code> in backend. The pharmacist account needs SEED_PHARMACIST_PASSWORD set.
        </p>
      </section>

      <section aria-labelledby="access" className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 id="access" className="text-lg font-semibold text-ink">Who can reach what (RBAC)</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3">Area</th>
                <th className="py-2 pr-3">Patient</th>
                <th className="py-2 pr-3">Doctor</th>
                <th className="py-2 pr-3">Pharmacist</th>
                <th className="py-2">Admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ACCESS.map((r) => (
                <tr key={r.area}>
                  <td className="py-2 pr-3 text-ink">{r.area}</td>
                  {(['PATIENT', 'DOCTOR', 'PHARMACIST', 'ADMIN'] as const).map((role) => (
                    <td key={role} className={`py-2 pr-3 font-semibold ${r[role] === 'Yes' ? 'text-emerald-700' : 'text-slate-400'}`}>
                      {r[role]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="checklist" className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="checklist" className="text-lg font-semibold text-ink">
            Checklist <span className="text-sm font-normal text-slate-500">({finished} of {total} done)</span>
          </h2>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4 accent-teal-600" />
            Show every role
          </label>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <div className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all" style={{ width: `${total ? (finished / total) * 100 : 0}%` }} />
        </div>
        <ul className="mt-4 space-y-2">
          {items.map((i) => (
            <li key={i.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-slate-50">
                <input type="checkbox" checked={!!done[i.id]} onChange={() => toggle(i.id)} className="mt-1 size-4 shrink-0 accent-teal-600" />
                <span className={`text-sm ${done[i.id] ? 'text-slate-400 line-through' : 'text-ink'}`}>{i.text}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">Progress is saved in this browser only.</p>
      </section>
    </div>
  );
}

export default TestGuidePage;
