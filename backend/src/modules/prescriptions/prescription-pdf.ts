import PDFDocument from 'pdfkit';
import type { PrescriptionView } from './prescriptions.service.js';

/**
 * Server-side PDF built only from the persisted record. ASCII text only, so the standard fonts render
 * everything. The document is clearly labelled as synthetic demo output.
 */
export function renderPrescriptionPdf(rx: PrescriptionView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Prescription ${rx.rxNumber ?? ''}`, Author: 'CarePulse (synthetic demo)' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#0f766e').fontSize(20).font('Helvetica-Bold').text('CarePulse - Prescription');
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('Fictional demo document. Synthetic data. Not valid for dispensing.');
    doc.moveDown(0.8);

    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text(`Prescription no: ${rx.rxNumber ?? 'not issued'}`);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Issued: ${rx.issuedAt ? rx.issuedAt.slice(0, 10) : '-'}     Valid till: ${rx.validTill ?? '-'}     Status: ${rx.status}`);
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').text('Doctor');
    doc.font('Helvetica').text(`${rx.doctor.name}, ${rx.doctor.specialty}`);
    doc.text(`Registration no: ${rx.doctor.registrationNo}`);
    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').text('Patient');
    doc.font('Helvetica').text(`${rx.patient.name}, ${rx.patient.age} years`);
    doc.moveDown(0.6);

    const allergyLine = rx.allergyCheck && rx.allergyCheck.matches.length === 0
      ? 'Allergy check at issue: no conflicts with recorded allergies.'
      : 'Allergy check: see the record in CarePulse.';
    doc.font('Helvetica-Oblique').fontSize(9).text(allergyLine).fontSize(10).moveDown(0.8);

    doc.font('Helvetica-Bold').text('Medicines');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9.5);
    rx.items.forEach((it) => {
      doc.font('Helvetica-Bold').text(`${it.lineNo}. ${it.medicine.name}`, { continued: false });
      doc.font('Helvetica').text(
        `    Dose: ${it.dose}   Frequency: ${it.frequency}   Duration: ${it.durationDays} day(s)   Quantity: ${it.quantity}`,
      );
      if (it.instructions) doc.text(`    Instructions: ${it.instructions}`);
      doc.moveDown(0.4);
    });

    if (rx.advice) {
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(10).text('Advice');
      doc.font('Helvetica').text(rx.advice);
    }

    doc.moveDown(2).fontSize(8).fillColor('#64748b').text(
      'Signature: ____________________________ (issuing doctor, demo only)',
    );
    doc.end();
  });
}
