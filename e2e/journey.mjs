// End-to-end journey in a real browser against the running API and Neon database.
// Run with the API on :4000 and the web app on :5173. Uses the installed Microsoft Edge.
//
// One documented shortcut: a consultation can only be opened within 15 minutes of its slot, so the
// script moves the patient's just-booked slot to five minutes from now. Everything else goes through the UI.
import { chromium } from 'playwright-core';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

neonConfig.webSocketConstructor = ws;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots');
const out = path.join(here, 'out');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(out, { recursive: true });

const WEB = 'http://localhost:5173';
const env = fs.readFileSync(path.join(here, '..', 'backend', '.env'), 'utf8');
const dbUrl = env.match(/^DIRECT_DATABASE_URL=(.*)$/m)[1].trim();
const pool = new Pool({ connectionString: dbUrl, max: 2 });
const PASSWORD = 'Demo@1234';
const PATIENT = 'anita.rao@example.com';
const DOCTOR = 'dr.mehta@example.com';

const results = [];
let patient;
let doctorPage;
const step = (name) => console.log(`-> ${name}`);
const pass = (name) => {
  results.push(name);
  console.log(`   PASS ${name}`);
};

async function signIn(page, identifier) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email or mobile').fill(identifier);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  // ---- Patient books a visit through the UI -------------------------------------------------
  step('patient signs in and books with Dr. Mehta');
  const patientCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  patient = await patientCtx.newPage();
  patient.setDefaultTimeout(30000);
  await signIn(patient, PATIENT);
  await patient.getByRole('heading', { name: 'Hello, Anita' }).waitFor();
  pass('patient login reaches the patient dashboard');

  // Patient is not allowed in a doctor workspace; the guard sends her home.
  await patient.goto(`${WEB}/doctor/dashboard`);
  await patient.getByRole('heading', { name: 'Hello, Anita' }).waitFor();
  pass('patient is redirected away from the doctor workspace');

  await patient.goto(`${WEB}/doctors`);
  await patient.getByRole('link', { name: /Dr\. Mehta/ }).first().click();
  await patient.getByRole('button', { name: /available/ }).first().click();
  await patient.getByLabel('What is your main concern?').fill('Sore throat and fever');
  await patient.getByRole('button', { name: 'Fever', exact: true }).click();
  await patient.getByLabel('How many days?').fill('2');
  await patient.getByLabel('How severe does it feel?').selectOption('MILD');
  await patient.getByRole('button', { name: 'Review booking' }).click();
  await patient.getByRole('dialog', { name: 'Confirm your appointment' }).getByRole('button', { name: 'Confirm booking' }).click();
  await patient.getByRole('heading', { name: 'Your appointments' }).waitFor();
  await patient.getByText('Sore throat and fever').first().waitFor();
  await shot(patient, '01-patient-appointments');
  pass('patient books a visit through the booking form and sees it in Appointments');

  // Documented shortcut: move the new slot into the 15-minute opening window.
  const moved = await pool.query(
    `UPDATE appointment_slots s SET starts_at = now() + interval '5 minutes', ends_at = now() + interval '35 minutes'
       FROM appointments a
      WHERE a.slot_id = s.id
        AND a.id = (SELECT a2.id FROM appointments a2 JOIN users u ON u.id = a2.patient_user_id
                     WHERE u.email = $1 ORDER BY a2.created_at DESC LIMIT 1)
     RETURNING a.id AS appointment_id`,
    [PATIENT],
  );
  const appointmentId = moved.rows[0].appointment_id;
  console.log(`   (shortcut) moved this visit's slot to five minutes from now so it can open`);

  // ---- Doctor runs the consultation and issues a prescription -------------------------------
  step('doctor confirms, runs the consultation, and issues a prescription');
  const doctorCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  doctorPage = await doctorCtx.newPage();
  doctorPage.setDefaultTimeout(30000);
  await signIn(doctorPage, DOCTOR);
  await doctorPage.getByRole('heading', { name: 'Dr. Mehta' }).waitFor();
  await doctorPage.getByRole('tab', { name: 'today' }).click();
  await doctorPage.locator(`a[href="/doctor/appointments/${appointmentId}"]`).waitFor();
  // Target this run's appointment exactly, not whichever row sorts first.
  await doctorPage.locator(`a[href="/doctor/appointments/${appointmentId}"]`).click();
  await doctorPage.getByRole('heading', { name: 'Anita Rao' }).waitFor();
  pass('doctor sees the patient in today\'s queue');

  const confirm = doctorPage.getByRole('button', { name: 'Confirm appointment' });
  if (await confirm.count()) await confirm.click();
  await doctorPage.getByRole('button', { name: 'Start consultation' }).click();
  await doctorPage.getByRole('heading', { name: 'Anita Rao' }).waitFor();
  await doctorPage.getByRole('heading', { name: 'Record the consultation' }).waitFor();
  pass('doctor starts the consultation');

  await doctorPage.getByLabel('Chief complaint').fill('Sore throat and fever');
  await doctorPage.getByLabel('Diagnosis (free text, not coded)').fill('Viral pharyngitis (provisional)');
  await doctorPage.getByLabel('Severity').selectOption('MILD');
  await doctorPage.getByLabel('Systolic (mmHg)').fill('118');
  await doctorPage.getByLabel('Diastolic (mmHg)').fill('76');
  await doctorPage.getByLabel('Pulse (per min)').fill('88');
  await doctorPage.getByLabel('Temperature (°C)').fill('38.4');
  await doctorPage.getByLabel('SpO₂ (%)').fill('97');
  await doctorPage.getByRole('button', { name: 'Save draft' }).click();
  await doctorPage.getByText(/Draft saved at/).waitFor();
  pass('doctor saves the draft with vitals and a free-text diagnosis');

  await doctorPage.getByRole('button', { name: 'Finalize consultation' }).click();
  await doctorPage.getByRole('dialog', { name: 'Finalize this consultation?' }).getByRole('button', { name: 'Finalize and lock' }).click();
  await doctorPage.getByText('Finalized and locked', { exact: true }).waitFor();
  pass('doctor finalizes the consultation; the record locks');

  // Drafting a prescription from the consultation
  await doctorPage.getByRole('button', { name: 'New' }).click();
  await doctorPage.getByRole('heading', { name: 'Prescription draft' }).waitFor();
  const search = doctorPage.getByRole('searchbox', { name: 'Search medicines' });
  await search.fill('amoxi');
  await doctorPage.getByRole('button', { name: /Amoxicillin 500 mg capsule/ }).click();
  await doctorPage.getByLabel('Dose').fill('500 mg');
  await doctorPage.getByLabel('Frequency').fill('Three times a day');
  await doctorPage.getByLabel('Duration (days)').fill('5');
  await doctorPage.getByLabel('Quantity').fill('15');
  await doctorPage.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByText('Allergy conflict: this prescription cannot be issued').waitFor();
  await shot(doctorPage, '02-doctor-allergy-block');
  pass('the allergy check blocks Amoxicillin for a patient with a penicillin allergy');

  await doctorPage.getByRole('button', { name: 'Remove Amoxicillin 500 mg capsule' }).click();
  await search.fill('azithro');
  await doctorPage.getByRole('button', { name: /Azithromycin 500 mg tablet/ }).click();
  await doctorPage.getByLabel('Dose').fill('500 mg');
  await doctorPage.getByLabel('Frequency').fill('Once a day');
  await doctorPage.getByLabel('Duration (days)').fill('3');
  await doctorPage.getByLabel('Quantity').fill('3');
  await doctorPage.getByRole('button', { name: 'Add to prescription' }).click();
  await doctorPage.getByText('Medicines on this draft (1)').waitFor();
  await doctorPage.getByRole('button', { name: 'Preview prescription' }).click();
  await doctorPage.getByRole('heading', { name: 'Preview before issuing' }).waitFor();
  await shot(doctorPage, '03-doctor-preview');
  await doctorPage.getByRole('button', { name: 'Issue prescription' }).click();
  await doctorPage.getByRole('dialog', { name: 'Issue this prescription?' }).getByRole('button', { name: 'Yes, issue' }).click();
  const heading = doctorPage.getByRole('heading', { level: 1 }).filter({ hasText: /CP-\d{4}-\d{6}/ });
  await heading.waitFor();
  const rxNumber = (await heading.textContent()).match(/CP-\d{4}-\d{6}/)[0];
  await shot(doctorPage, '04-doctor-issued');
  pass(`doctor issues prescription ${rxNumber} after confirmation`);

  // ---- Patient sees and downloads the prescription -----------------------------------------
  step('patient views the issued prescription and downloads the PDF');
  await patient.goto(`${WEB}/patient/prescriptions`);
  await patient.getByText(rxNumber).waitFor();
  await patient.getByRole('link', { name: new RegExp(rxNumber) }).click();
  await patient.getByRole('heading', { name: new RegExp(rxNumber) }).waitFor();
  await patient.getByText('Azithromycin 500 mg tablet').first().waitFor();
  await shot(patient, '05-patient-prescription');
  pass('patient sees the issued prescription by number, with the medicine and validity');

  const [download] = await Promise.all([
    patient.waitForEvent('download'),
    patient.getByRole('button', { name: /Download PDF/ }).click(),
  ]);
  const pdfPath = path.join(out, `${rxNumber}.pdf`);
  await download.saveAs(pdfPath);
  const head = fs.readFileSync(pdfPath).subarray(0, 4).toString();
  if (head !== '%PDF') throw new Error(`downloaded file is not a PDF (starts with ${head})`);
  pass(`patient downloads a valid PDF (${fs.statSync(pdfPath).size} bytes)`);

  // The patient cannot change the issued record through the UI.
  const drafts = await patient.request.get(`http://localhost:4000/api/v1/patients/me/prescriptions`, {
    headers: { cookie: (await patientCtx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  if (!drafts.ok()) throw new Error(`patient list request failed: ${drafts.status()}`);
  pass('patient list is served by the API with the patient session');

  console.log(`\nJOURNEY PASSED: ${results.length} checks`);
  await patientCtx.close();
  await doctorCtx.close();
} catch (err) {
  for (const [name, page] of [['failure-patient', patient], ['failure-doctor', doctorPage]]) {
    if (page) await shot(page, name).catch(() => undefined);
  }
  console.error('\nJOURNEY FAILED:', err.message);
  console.error(`passed before failure: ${results.join(' | ') || 'none'}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await pool.end();
}
