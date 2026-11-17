import { CalendarDays, ClipboardList, FileText, HeartPulse, PackageSearch, Pill, ShieldCheck, ShoppingBag, Sparkles, Stethoscope, Users, Boxes, BookOpen, BadgeCheck, Activity } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import type { SessionUser } from '../../types/auth';
import { Hero, InfoRow, ModuleTile, RoleDashboard } from './RoleDashboard';

const firstName = (name: string) => name.split(' ').find((p) => !/^(dr\.?|mr\.?|ms\.?|mrs\.?)$/i.test(p)) ?? name;

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
        subtitle="Your appointments, prescriptions and orders live here. Modules light up as they are built."
        chips={[
          p ? `${p.age} years` : '',
          p?.bloodGroup && p.bloodGroup !== 'UNKNOWN' ? `Blood group ${p.bloodGroup}` : '',
          p?.consentStatus ? 'Health-data consent on file' : 'Consent missing',
        ].filter(Boolean)}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ModuleTile icon={CalendarDays} tone="teal" title="Appointments" text="Book and track doctor visits." checkpoint="Coming in C2" />
        <ModuleTile icon={Stethoscope} tone="indigo" title="Visits & diagnoses" text="Your consultation history." checkpoint="Coming in C2" />
        <ModuleTile icon={FileText} tone="emerald" title="Prescriptions" text="Digital prescriptions with PDF." checkpoint="Coming in C3" />
        <ModuleTile icon={ShoppingBag} tone="amber" title="Medicine orders" text="Buy exactly what you were prescribed." checkpoint="Coming in C4" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Your profile" description="Stored securely. Only you and your treating team can see clinical details.">
          <dl className="grid gap-x-8 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0">
            <div className="sm:col-span-1 sm:divide-y sm:divide-slate-100">
              <InfoRow label="Email" value={user.email} />
              <InfoRow label="Mobile" value={user.mobile ? `+91 ${user.mobile}` : ''} />
              <InfoRow label="Date of birth" value={p?.dob ?? ''} />
              <InfoRow label="Gender" value={p?.gender ?? ''} />
            </div>
            <div className="sm:col-span-1 sm:divide-y sm:divide-slate-100">
              <InfoRow label="Address" value={p ? `${p.addressLine}, ${p.city}, ${p.state} ${p.pincode}` : ''} />
              <InfoRow label="Emergency contact" value={p ? `${p.emergencyContactName} · ${p.emergencyContactPhone}` : ''} />
              <InfoRow label="Consent recorded" value={p?.consentAt ? new Date(p.consentAt).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : ''} />
            </div>
          </dl>
        </Card>

        <Card title="Safety" description="Medicine safety is checked before anything is recommended or ordered.">
          <ul className="space-y-3 text-sm text-slate-600">
            <li className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-600" aria-hidden="true" />Allergies are checked against every prescription.</li>
            <li className="flex gap-3"><Sparkles className="mt-0.5 size-4 shrink-0 text-teal-600" aria-hidden="true" />The care assistant gives guidance only, never a diagnosis.</li>
            <li className="flex gap-3"><HeartPulse className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden="true" />For emergencies, call your local emergency number.</li>
          </ul>
        </Card>
      </div>
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
        subtitle="Today's patients, consultations and prescriptions. You only see patients under your care."
        chips={[d?.specialty ?? '', d ? `${d.experienceYears} yrs experience` : ''].filter(Boolean)}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ModuleTile icon={CalendarDays} tone="indigo" title="Today's appointments" text="Your queue, in booking order." checkpoint="Coming in C2" />
        <ModuleTile icon={ClipboardList} tone="teal" title="Consultations" text="Record complaints, vitals and diagnosis." checkpoint="Coming in C2" />
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
