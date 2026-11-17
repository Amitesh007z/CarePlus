import nodemailer from 'nodemailer';
import type { Mailer } from './notifications.js';

/**
 * SMTP mailer. Returns null when SMTP_URL is not configured: notifications then stay PENDING in the database and
 * are sent once a mailer is configured. Transport errors are reduced to a generic failure; the URL is never logged.
 */
export function createMailer(env: { SMTP_URL?: string; SMTP_FROM?: string }): Mailer | null {
  if (!env.SMTP_URL || !env.SMTP_FROM) return null;
  const transport = nodemailer.createTransport(env.SMTP_URL);
  const TIMEOUT_MS = 15_000;
  return {
    async send(message) {
      try {
        await Promise.race([
          transport.sendMail({ from: env.SMTP_FROM, to: message.to, subject: message.subject, text: message.text }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS).unref()),
        ]);
      } catch {
        throw new Error('SMTP send failed');
      }
    },
  };
}
