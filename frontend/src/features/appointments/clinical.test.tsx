import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { istIso, mockApi, ok, patientSession, renderAt } from '../../test/apiMock';

const doctor = {
  id: 'doc-1',
  displayName: 'Dr. Mehta',
  specialty: 'General Physician',
  experienceYears: 12,
  availability: [{ weekday: 1, startTime: '09:00:00', endTime: '10:00:00', slotMinutes: 30 }],
};
const freeSlot = { id: 'slot-free', startsAt: istIso(3, '10:00'), endsAt: istIso(3, '10:30'), booked: false };
const takenSlot = { id: 'slot-taken', startsAt: istIso(3, '10:30'), endsAt: istIso(3, '11:00'), booked: true };
const emptyList = { items: [], meta: { page: 1, pageSize: 100, total: 0, totalPages: 1 } };

describe('clinical flows', () => {
  it('books a doctor with symptoms only, after an explicit review and confirmation', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/doctors/doc-1': () => ok(doctor),
      'GET /api/v1/doctors/doc-1/slots': () => ok({ timezone: 'Asia/Kolkata', from: '', days: 14, slots: [freeSlot, takenSlot] }),
      'GET /api/v1/patients/me/health-info': () =>
        ok({
          items: [{ id: 'h1', type: 'ALLERGY', name: 'Penicillin', allergyClass: 'Penicillin', severity: 'SEVERE', notedOn: '2015-03-10', active: true, notes: null }],
          meta: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
        }),
      'GET /api/v1/patients/me/medications': () => ok(emptyList),
      'POST /api/v1/appointments': () => ok({ id: 'appt-1', status: 'REQUESTED' }),
      'GET /api/v1/appointments/me': () => ok(emptyList),
    });
    renderAt('/doctors/doc-1');

    await userEvent.click(await screen.findByRole('button', { name: /10:00 am, available/ }));
    expect(await screen.findByText('Allergy: Penicillin · severe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /10:30 am, booked/ })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('What is your main concern?'), 'Fever for two days');
    await userEvent.click(screen.getByRole('button', { name: 'Fever' }));
    await userEvent.type(screen.getByLabelText('How many days?'), '2');
    await userEvent.selectOptions(screen.getByLabelText('How severe does it feel?'), 'MODERATE');
    await userEvent.click(screen.getByRole('button', { name: 'Review booking' }));

    const dialog = await screen.findByRole('dialog', { name: 'Confirm your appointment' });
    expect(within(dialog).getByText('Fever for two days')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm booking' }));

    expect(await screen.findByRole('heading', { name: 'Your appointments' })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/appointments')!;
    expect(Object.keys(post.body!).sort()).toEqual(['additionalNotes', 'chiefComplaint', 'durationDays', 'severity', 'slotId', 'symptoms']);
    expect(post.body).toMatchObject({ slotId: 'slot-free', symptoms: ['Fever'], durationDays: 2, severity: 'MODERATE' });
    expect(post.body).not.toHaveProperty('patientId');
    expect(post.body).not.toHaveProperty('doctorId');
  });

  it('asks for confirmation before cancelling and states the fee consequence', async () => {
    const appointment = {
      id: 'appt-9',
      status: 'CONFIRMED',
      chiefComplaint: 'Cough',
      symptoms: ['Cough'],
      durationDays: 3,
      severity: 'MILD',
      additionalNotes: null,
      doctor: { id: 'doc-1', name: 'Dr. Mehta', specialty: 'General Physician' },
      patient: { id: 'u-1', name: 'Anita Rao' },
      slot: { id: 'slot-free', startsAt: freeSlot.startsAt, endsAt: freeSlot.endsAt },
      booking: { feeInr: 100, feeStatus: 'SIMULATED_HELD' },
      cancellation: null,
      rescheduledCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/appointments/me': () => ok({ items: [appointment], meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 } }),
      'POST /api/v1/appointments/appt-9/cancel': () => ok({ ...appointment, status: 'CANCELLED' }),
    });
    renderAt('/appointments');

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    expect(within(dialog).getByText(/Free cancellation/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/cancel'))).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, cancel' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/appointments/appt-9/cancel')).toBe(true));
  });

  it('withdraws consent with one action and reflects the new state', async () => {
    let consent = true;
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/patients/me': () => ok({ profile: { ...patientSession.user.patient, consentStatus: consent }, email: 'a@b.co', mobile: '9876500001' }),
      'GET /api/v1/patients/me/health-info': () => ok(emptyList),
      'GET /api/v1/patients/me/medications': () => ok(emptyList),
      'POST /api/v1/patients/me/consent': (c) => {
        consent = Boolean((c.body as { granted: boolean }).granted);
        return ok({ consentStatus: consent, consentAt: null, consentWithdrawnAt: null });
      },
    });
    renderAt('/patient/health');

    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw consent' }));
    expect(await screen.findByText(/Consent is off/)).toBeInTheDocument();
    const post = calls.find((c) => c.path === '/api/v1/patients/me/consent')!;
    expect(post.body).toEqual({ granted: false });
  });
});
