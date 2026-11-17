import { hash, verify } from '@node-rs/argon2';

const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id

export interface HashParams {
  memoryCost: number; // KiB
  timeCost: number;
  parallelism: number;
}

/** OWASP-recommended Argon2id baseline (19 MiB, 2 iterations, 1 lane). */
export const DEFAULT_PARAMS: HashParams = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
  /** True when the stored hash was produced with weaker/different parameters. */
  needsRehash(passwordHash: string): boolean;
}

export function createPasswordHasher(params: HashParams = DEFAULT_PARAMS): PasswordHasher {
  return {
    hash: (password) => hash(password, { algorithm: ARGON2ID, ...params }),
    async verify(passwordHash, password) {
      try {
        return await verify(passwordHash, password);
      } catch {
        return false; // malformed hash must never throw into the login path
      }
    },
    needsRehash(passwordHash) {
      const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash);
      if (!m) return true;
      return Number(m[1]) !== params.memoryCost || Number(m[2]) !== params.timeCost || Number(m[3]) !== params.parallelism;
    },
  };
}
