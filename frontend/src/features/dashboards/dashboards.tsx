import { Link } from 'react-router-dom';
import { CalendarDays, ClipboardList, FileText, HeartPulse, PackageSearch, Pill, ShieldCheck, ShoppingBag, Sparkles, Stethoscope, Users, Boxes, BookOpen, BadgeCheck, Activity, UserRound } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import { DoctorAppointments } from '../appointments/DoctorAppointments';
import type { SessionUser } from '../../types/auth';
import { Hero, InfoRow, ModuleTile, RoleDashboard } from './RoleDashboard';

const firstName = (name: string) => name.split(' ').find((p) => !/^(dr\.?|mr\.?|ms\.?|mrs\.?)$/i.test(p)) ?? name;

/** A tile that opens a live page. Unbuilt modules use plain ModuleTile with their checkpoint label. */
function LinkTile(props: { to: string; icon: Parameters<typeof ModuleTile>[0]['icon']; tone: Parameters<typeof ModuleTile>[0]['tone']; title: string; text: string }) {
  return (
    <Link to={props.to} className="block rounded-2xl focus-visible:outline-2">
      <ModuleTile icon={props.icon} tone={props.tone} title={props.title} text={props.text} checkpoint="Open →" />
    </Link>
  );
}

export function PatientDashboard() {
  return (
    <RoleDashboard path="/patient/dashboard" role="PATIENT">
      {(user) => <PatientView user={user} />}
    </RoleDashboard>
  );
}

function PatientView({ user }: { user: SessionUser }) {
  const p = user.patient;
  return (
    <div className="space-y-8">
      <Hero
        role="PATIENT"
        title={`Hello, ${firstName(user.displayName)}`}
        subtitle="Book a visit, keep your health details current and see your appointments in one place."
        chips={[
          p ? `${p.age} years` : '',
          p?.bloodGroup && p.bloodGroup !== 'UNKNOWN' ? `Blood group ${p.bloodGroup}` : '',
          p?.consentStatus ? 'Health-data consent on file' : 'Consent withdrawn',
        ].filter(Boolean)}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <LinkTile to="/doctors" icon={Stethoscope} tone="indigo" title="Find a doctor" text="Browse doctors and book a time." />
        <LinkTile to="/appointments" icon={CalendarDays} tone="teal" title="Appointments" text="Upcoming visits, history, reschedule or cancel." />
        <LinkTile to="/patient/health" icon={HeartPulse} tone="rose" title="Health & privacy" text="Allergies, conditions, medicines and consent." />
        <LinkTile to="/patient/profile" icon={UserRound} tone="emerald" title="My profile" text="Personal, address and emergency details." />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModuleTile icon={FileText} tone="emerald" title="Prescriptions" text="Digital prescriptions with PDF." checkpoint="Coming in C3" />
        <ModuleTile icon={ShoppingBag} tone="amber" title="Medicine orders" text="Buy exactly what you were prescribed." checkpoint="Coming in C4" />
      </div>

      <Card title="Safety" description="Medicine safety is checked before anything is recommended or ordered.">
        <ul className="grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
          <li className="flex gap-3 rounded-xl bg-slate-50 p-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-600" aria-hidden="true" />Your allergies are shown to your doctor and checked before you are offered a medicine.</li>
          <li className="flex gap-3 rounded-xl bg-slate-50 p-3"><Sparkles className="mt-0.5 size-4 shrink-0 text-teal-600" aria-hidden="true" />The care assistant gives guidance only, never a diagnosis.</li>
          <li className="flex gap-3 rounded-xl bg-slate-50 p-3"><HeartPulse className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden="true" />For emergencies, call your local emergency number.</li>
        </ul>
      </Card>
    </div>
  );
}

export function DoctorDashboard() {
  return (
    <RoleDashboard path="/doctor/dashboard" role="DOCTOR">
      {(user) => <DoctorView user={user} />}
    </RoleDashboard>
  );
}

function DoctorView({ user }: { user: SessionUser }) {
  const d = user.doctor;
  return (
    <div className="space-y-8">
      <Hero
        role="DOCTOR"
        title={`${user.displayName}`}
        subtitle="Your patients for the next week. You only see patients who have booked with you and consented to share."
        chips={[d?.specialty ?? '', d ? `${d.experienceYears} yrs experience` : ''].filter(Boolean)}
      />
      <DoctorAppointments />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ModuleTile icon={ClipboardList} tone="teal" title="Consultations" text="Record complaints, vitals and diagnosis." checkpoint="Coming in C3" />
        <ModuleTile icon={Pill} tone="emerald" title="Prescriptions" text="Preview, sign and issue." checkpoint="Coming in C3" />
        <ModuleTile icon={Activity} tone="amber" title="Priority support" text="Assistive ranking, never a diagnosis." checkpoint="Coming in C6" />
      </div>
      <Card title="Practice details" description="Registered details shown to patients and staff.">
        <dl className="grid gap-x-8 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0">
          <div className="sm:divide-y sm:divide-slate-100">
            <InfoRow label="Specialty" value={d?.specialty ?? ''} />
            <InfoRow label="Registration no." value={d?.registrationNo ?? ''} />
          </div>
          <div className="sm:divide-y sm:divide-slate-100">
            <InfoRow label="Experience" value={d ? `${d.experienceYears} years` : ''} />
            <InfoRow label="Email" value={user.email} />
          </div>
        </dl>
      </Card>
    </div>
  );
}

export function PharmacistDashboard() {
  return (
    <RoleDashboard path="/pharmacy/dashboard" role="PHARMACIST">
      {(user) => (
        <div className="space-y-8">
          <Hero role="PHARMACIST" title={user.displayName} subtitle="Prescription verification, fulfilment and stock, in one queue." />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ModuleTile icon={BadgeCheck} tone="emerald" title="Verification queue" text="Prescription orders waiting for checks." checkpoint="Coming in C5" />
            <ModuleTile icon={PackageSearch} tone="teal" title="Fulfilment" text="Packed, out for delivery, delivered." checkpoint="Coming in C5" />
            <ModuleTile icon={Boxes} tone="amber" title="Inventory" text="Stock levels and movement history." checkpoint="Coming in C5" />
            <ModuleTile icon={Sparkles} tone="indigo" title="Agent proposals" text="Optional AI proposals for approval." checkpoint="Stretch (C9)" />
          </div>
        </div>
      )}
    </RoleDashboard>
  );
}

export function AdminDashboard() {
  return (
    <RoleDashboard path="/admin/dashboard" role="ADMIN">
      {(user) => (
        <div className="space-y-8">
          <Hero role="ADMIN" title={user.displayName} subtitle="Manage staff accounts, the medicine catalogue and approved knowledge documents. Clinical notes are not visible to admins." />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ModuleTile icon={Users} tone="amber" title="Staff accounts" text="Doctors, pharmacists and admins." checkpoint="Coming in C8" />
            <ModuleTile icon={Pill} tone="emerald" title="Medicine catalogue" text="Products, prices and stock policy." checkpoint="Coming in C8" />
            <ModuleTile icon={BookOpen} tone="teal" title="Knowledge documents" text="Versioned, approved policy documents." checkpoint="Coming in C7" />
            <ModuleTile icon={ShieldCheck} tone="rose" title="Audit log" text="Who changed what, and when." checkpoint="Coming in C8" />
          </div>
        </div>
      )}
    </RoleDashboard>
  );
}
