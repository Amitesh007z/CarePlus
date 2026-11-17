import { useState, type FormEvent } from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { useToast } from '../../components/ui/Toast';
import { ApiError, apiRequest } from '../../lib/api';
import { messageOf, useApi } from '../../lib/useApi';
import { BLOOD_GROUP_OPTIONS, GENDER_OPTIONS, normalizeMobile } from '../auth/registration';
import type { PatientInfo } from '../../types/auth';
import { Hero, InfoRow } from '../dashboards/RoleDashboard';

interface ProfileResponse {
  profile: PatientInfo | null;
  email: string | null;
  mobile: string | null;
}

type Form = Omit<PatientInfo, 'age' | 'consentStatus' | 'consentAt'>;

const toForm = (p: PatientInfo): Form => ({
  fullName: p.fullName,
  dob: p.dob,
  gender: p.gender,
  bloodGroup: p.bloodGroup,
  addressLine: p.addressLine,
  city: p.city,
  state: p.state,
  pincode: p.pincode,
  emergencyContactName: p.emergencyContactName,
  emergencyContactPhone: p.emergencyContactPhone,
});

export default function ProfilePage() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<ProfileResponse>('/api/v1/patients/me');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (loading) return <PageLoader label="Loading your profile" />;
  if (error || !data?.profile) {
    return <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{error ?? 'Profile not found.'}</p>;
  }
  const p = data.profile;

  const set = (key: keyof Form, value: string) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  function startEdit() {
    setForm(toForm(p));
    setErrors({});
    setFormError(null);
    setEditing(true);
  }

  function validate(f: Form): Record<string, string> {
    const e: Record<string, string> = {};
    if (f.fullName.trim().length < 2) e.fullName = 'Enter your full name';
    if (!f.dob || f.dob > new Date().toISOString().slice(0, 10)) e.dob = 'Enter a valid date of birth';
    if (f.addressLine.trim().length < 5) e.addressLine = 'Enter your address';
    if (f.city.trim().length < 2) e.city = 'Enter your city';
    if (f.state.trim().length < 2) e.state = 'Enter your state';
    if (!/^\d{6}$/.test(f.pincode.trim())) e.pincode = 'Pincode must be 6 digits';
    if (f.emergencyContactName.trim().length < 2) e.emergencyContactName = 'Enter an emergency contact name';
    if (!normalizeMobile(f.emergencyContactPhone)) e.emergencyContactPhone = 'Enter a valid 10-digit mobile number';
    return e;
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const v = validate(form);
    setErrors(v);
    if (Object.keys(v).length) return;
    setSaving(true);
    setFormError(null);
    try {
      await apiRequest('/api/v1/patients/me', {
        method: 'PUT',
        body: { ...form, pincode: form.pincode.trim(), emergencyContactPhone: normalizeMobile(form.emergencyContactPhone) ?? form.emergencyContactPhone },
      });
      toast.notify('success', 'Profile saved');
      setEditing(false);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.details.length) {
        setErrors(Object.fromEntries(err.details.filter((d) => d.path).map((d) => [d.path!, d.message])));
      }
      setFormError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <Hero
        role="PATIENT"
        title={p.fullName}
        subtitle="Keep your details current. Your age is calculated from your date of birth."
        chips={[`${p.age} years old`, `Blood group ${p.bloodGroup === 'UNKNOWN' ? 'not known' : p.bloodGroup}`]}
      />

      {!editing && (
        <Card
          title="Personal details"
          description="Only you and your treating team can see clinical details."
          actions={<Button variant="secondary" onClick={startEdit}><Pencil className="size-4" aria-hidden="true" /> Edit</Button>}
        >
          <dl className="grid gap-x-10 sm:grid-cols-2">
            <div className="sm:divide-y sm:divide-slate-100">
              <InfoRow label="Email" value={data.email ?? ''} />
              <InfoRow label="Mobile" value={data.mobile ? `+91 ${data.mobile}` : ''} />
              <InfoRow label="Date of birth" value={p.dob} />
              <InfoRow label="Age" value={`${p.age} years`} />
              <InfoRow label="Gender" value={p.gender.toLowerCase()} />
              <InfoRow label="Blood group" value={p.bloodGroup === 'UNKNOWN' ? 'Not known' : p.bloodGroup} />
            </div>
            <div className="sm:divide-y sm:divide-slate-100">
              <InfoRow label="Address" value={p.addressLine} />
              <InfoRow label="City" value={p.city} />
              <InfoRow label="State" value={p.state} />
              <InfoRow label="Pincode" value={p.pincode} />
              <InfoRow label="Emergency contact" value={p.emergencyContactName} />
              <InfoRow label="Emergency mobile" value={p.emergencyContactPhone} />
            </div>
          </dl>
        </Card>
      )}

      {editing && form && (
        <Card title="Edit your details" description="Changes are saved to your record straight away.">
          <form onSubmit={onSave} noValidate className="grid gap-5 sm:grid-cols-2">
            {formError && <p role="alert" className="sm:col-span-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{formError}</p>}
            <Input label="Full name" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} error={errors.fullName} />
            <Input label="Date of birth" type="date" value={form.dob} onChange={(e) => set('dob', e.target.value)} error={errors.dob} />
            <Select label="Gender" options={GENDER_OPTIONS} value={form.gender} onChange={(e) => set('gender', e.target.value)} />
            <Select label="Blood group" options={BLOOD_GROUP_OPTIONS} value={form.bloodGroup} onChange={(e) => set('bloodGroup', e.target.value)} />
            <div className="sm:col-span-2">
              <Input label="Address" value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} error={errors.addressLine} />
            </div>
            <Input label="City" value={form.city} onChange={(e) => set('city', e.target.value)} error={errors.city} />
            <Input label="State" value={form.state} onChange={(e) => set('state', e.target.value)} error={errors.state} />
            <Input label="Pincode" inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => set('pincode', e.target.value)} error={errors.pincode} />
            <span className="hidden sm:block" aria-hidden="true" />
            <Input label="Emergency contact name" value={form.emergencyContactName} onChange={(e) => set('emergencyContactName', e.target.value)} error={errors.emergencyContactName} />
            <Input label="Emergency contact mobile" type="tel" value={form.emergencyContactPhone} onChange={(e) => set('emergencyContactPhone', e.target.value)} error={errors.emergencyContactPhone} />
            <div className="sm:col-span-2 flex justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={saving}><X className="size-4" aria-hidden="true" /> Cancel</Button>
              <Button type="submit" loading={saving}><Save className="size-4" aria-hidden="true" /> Save changes</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
