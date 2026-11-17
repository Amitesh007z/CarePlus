import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/AppError.js';
import { assertOwner } from '../src/common/security/ownership.js';
import { createPasswordHasher } from '../src/modules/auth/password.js';
import { cookieName, csrfGuard, readCookie, requireRole } from '../src/modules/auth/auth.middleware.js';
import { ageFromDob } from '../src/modules/auth/user.repository.js';
import { loginSchema, normalizeEmail, normalizeMobile, passwordIssues, registerSchema } from '../src/modules/auth/validation.js';
import type { Request, Response } from 'express';

const valid = {
  fullName: 'Test Person', email: ' Test@Example.COM ', mobile: '+91 98765-43210', password: 'Strong@123',
  dob: '1990-01-31', gender: 'FEMALE', bloodGroup: 'O+', addressLine: '1 Main Road', city: 'Pune', state: 'MH',
  pincode: '411001', emergencyContactName: 'Kin', emergencyContactPhone: '9123456789', consent: true,
};

describe('normalization', () => {
  it('normalizes email and mobile', () => {
    expect(normalizeEmail('  A@B.Com ')).toBe('a@b.com');
    expect(normalizeMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeMobile('09876543210')).toBe('9876543210');
    expect(normalizeMobile('919876543210')).toBe('9876543210');
    expect(normalizeMobile('1234567890')).toBeNull();
    expect(normalizeMobile('98765')).toBeNull();
  });
});

describe('password policy', () => {
  it('accepts a strong password and lists every missing rule for a weak one', () => {
    expect(passwordIssues('Demo@1234')).toEqual([]);
    expect(passwordIssues('abc')).toEqual(expect.arrayContaining(['at least 8 characters', 'an uppercase letter', 'a digit', 'a special character']));
    expect(passwordIssues('x'.repeat(129) + 'A1!')).toContain('at most 128 characters');
  });
});

describe('registerSchema', () => {
  it('parses and normalizes valid input', () => {
    const r = registerSchema.parse(valid);
    expect(r.email).toBe('test@example.com');
    expect(r.mobile).toBe('9876543210');
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['unknown field', { isAdmin: true }],
    ['weak password', { password: 'password' }],
    ['bad email', { email: 'nope' }],
    ['bad mobile', { mobile: '12345' }],
    ['bad pincode', { pincode: '12345' }],
    ['future dob', { dob: '2999-01-01' }],
    ['impossible dob', { dob: '1990-02-31' }],
    ['no consent', { consent: false }],
    ['bad gender', { gender: 'X' }],
  ])('rejects %s', (_name, patch) => {
    expect(registerSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('rejects unknown keys on login too', () => {
    expect(loginSchema.safeParse({ identifier: 'a@b.com', password: 'x', role: 'ADMIN' }).success).toBe(false);
  });
});

describe('password hasher', () => {
  const hasher = createPasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });
  it('produces Argon2id hashes, verifies, and never throws on garbage', async () => {
    const h = await hasher.hash('Demo@1234');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(h, 'Demo@1234')).toBe(true);
    expect(await hasher.verify(h, 'wrong')).toBe(false);
    expect(await hasher.verify('not-a-hash', 'x')).toBe(false);
    expect(hasher.needsRehash(h)).toBe(false);
    expect(createPasswordHasher().needsRehash(h)).toBe(true);
  });
});

describe('middleware and helpers', () => {
  const req = (over: Partial<Request>) => over as Request;
  const run = (fn: (...a: never[]) => void, r: Request) => () => (fn as unknown as (q: Request, s: Response, n: () => void) => void)(r, {} as Response, () => undefined);

  it('reads cookies safely and prefixes the name in production', () => {
    expect(readCookie(req({ headers: { cookie: 'a=1; cp_sid=tok%20en; b=2' } }), 'cp_sid')).toBe('tok en');
    expect(readCookie(req({ headers: {} }), 'cp_sid')).toBeUndefined();
    expect(cookieName('production')).toBe('__Host-cp_sid');
    expect(cookieName('development')).toBe('cp_sid');
  });

  it('requireRole: 401 without auth, 403 for a wrong role, passes the right role', () => {
    const guard = requireRole('DOCTOR');
    expect(run(guard, req({}))).toThrow(expect.objectContaining({ status: 401 }));
    expect(run(guard, req({ auth: { role: 'PATIENT' } as never }))).toThrow(expect.objectContaining({ status: 403 }));
    expect(run(guard, req({ auth: { role: 'DOCTOR' } as never }))).not.toThrow();
  });

  it('csrfGuard: skips safe methods, requires the matching token on writes', () => {
    const auth = { csrfToken: 'tok-123' } as never;
    expect(run(csrfGuard, req({ method: 'GET', auth }))).not.toThrow();
    expect(run(csrfGuard, req({ method: 'POST', auth, header: () => undefined } as never))).toThrow(expect.objectContaining({ code: 'CSRF_INVALID' }));
    expect(run(csrfGuard, req({ method: 'POST', auth, header: () => 'tok-124' } as never))).toThrow(expect.objectContaining({ code: 'CSRF_INVALID' }));
    expect(run(csrfGuard, req({ method: 'POST', auth, header: () => 'tok-123' } as never))).not.toThrow();
  });

  it('assertOwner conceals foreign records as 404', () => {
    const actor = { userId: 'u1' } as never;
    expect(() => assertOwner(actor, 'u1')).not.toThrow();
    try {
      assertOwner(actor, 'u2');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(404);
    }
  });

  it('derives age from DOB', () => {
    expect(ageFromDob('2000-06-15', new Date('2026-06-14T00:00:00Z'))).toBe(25);
    expect(ageFromDob('2000-06-15', new Date('2026-06-15T00:00:00Z'))).toBe(26);
  });
});
