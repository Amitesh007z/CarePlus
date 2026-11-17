import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, ok, renderAt } from '../../test/apiMock';
import type { ConsultationDetail, PatientContext } from '../../types/clinical';

const doctorSession = {
  user: {
    id: 'doc-1', role: 'DOCTOR', email: 'dr.mehta@example.com', mobile: '9876500003', emailVerified: true,
    displayName: 'Dr. Mehta', createdAt: '2026-01-01T00:00:00.000Z',
    doctor: { specialty: 'General Physician', registrationNo: 'SYN-1', experienceYears: 12 },
  },
  csrfToken: 'csrf-doc',
};

const context: PatientContext = {
  patient: { fullName: 'Anita Rao', age: 35, gender: 'FEMALE', bloodGroup: 'B+' },
  allergies: [{ name: 'Penicillin', allergyClass: 'Penicillin', severity: 'SEVERE', notedOn: '2015-03-10', notes: null }],
  conditions: [],
  medications: [],
};

function draft(overrides: Partial<ConsultationDetail> = {}): ConsultationDetail {
  return {
    id: 'c-1', status: 'DRAFT', appointmentId: 'a-1',
    patient: { id: 'p-1', name: 'Anita Rao' }, doctor: { id: 'doc-1', name: 'Dr. Mehta', specialty: 'General Physician' },
    slotStartsAt: new Date(Date.now() + 60_000).toISOString(),
    chiefComplaint: null, examinationNotes: null, diagnosis: { description: null, coded: false },
    severity: null, followUpOn: null, finalizedAt: null, vitals: null, addenda: [],
    ...overrides,
  };
}

describe('consultation workspace', () => {
  it('blocks an impossible blood pressure before anything is sent', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(doctorSession),
      'GET /api/v1/doctor/consultations/c-1': () => ok(draft()),
      'GET /api/v1/doctor/patients/p-1/context': () => ok(context),
    });
    renderAt('/doctor/consultations/c-1');

    await userEvent.type(await screen.findByLabelText('Systolic (mmHg)'), '70');
    await userEvent.type(screen.getByLabelText('Diastolic (mmHg)'), '110');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Systolic must be higher than diastolic')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('saves a draft with vitals and a free-text, unlabelled-code diagnosis', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(doctorSession),
      'GET /api/v1/doctor/consultations/c-1': () => ok(draft()),
      'GET /api/v1/doctor/patients/p-1/context': () => ok(context),
      'PUT /api/v1/doctor/consultations/c-1': () => ok(draft({
        chiefComplaint: 'Fever for two days',
        diagnosis: { description: 'Viral fever (provisional)', coded: false },
        severity: 'MODERATE',
        vitals: { bpSystolic: 118, bpDiastolic: 76, pulse: 88, temperatureC: 38.4, spo2: 97 },
      })),
    });
    renderAt('/doctor/consultations/c-1');

    await userEvent.type(await screen.findByLabelText('Chief complaint'), 'Fever for two days');
    await userEvent.type(screen.getByLabelText('Diagnosis (free text, not coded)'), 'Viral fever (provisional)');
    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'MODERATE');
    await userEvent.type(screen.getByLabelText('Systolic (mmHg)'), '118');
    await userEvent.type(screen.getByLabelText('Diastolic (mmHg)'), '76');
    await userEvent.type(screen.getByLabelText('Pulse (per min)'), '88');
    await userEvent.type(screen.getByLabelText('Temperature (°C)'), '38.4');
    await userEvent.type(screen.getByLabelText('SpO₂ (%)'), '97');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      chiefComplaint: 'Fever for two days',
      diagnosisDescription: 'Viral fever (provisional)',
      severity: 'MODERATE',
      vitals: { bpSystolic: 118, bpDiastolic: 76, pulse: 88, temperatureC: 38.4, spo2: 97 },
    });
    expect(put.body).not.toHaveProperty('status');
    expect(put.body).not.toHaveProperty('doctorId');
  });

  it('finalizes after confirmation, then shows a locked record with the correction form only', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(doctorSession),
      'GET /api/v1/doctor/consultations/c-1': () =>
        ok(draft({ chiefComplaint: 'Fever for two days', diagnosis: { description: 'Viral fever', coded: false }, severity: 'MILD' })),
      'GET /api/v1/doctor/patients/p-1/context': () => ok(context),
      'PUT /api/v1/doctor/consultations/c-1': () => ok(draft({ chiefComplaint: 'Fever for two days', diagnosis: { description: 'Viral fever', coded: false }, severity: 'MILD' })),
      'POST /api/v1/doctor/consultations/c-1/finalize': () =>
        ok(draft({ status: 'FINALIZED', finalizedAt: new Date().toISOString(), chiefComplaint: 'Fever for two days', diagnosis: { description: 'Viral fever', coded: false }, severity: 'MILD' })),
    });
    renderAt('/doctor/consultations/c-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Finalize consultation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Finalize this consultation?' });
    expect(within(dialog).getByText(/cannot be edited/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finalize and lock' }));

    expect(await screen.findByText('Finalized and locked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Add a correction')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/doctor/consultations/c-1/finalize')).toBe(true);
  });
});
