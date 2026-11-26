// Profile names are shown to other families in Versus: homoglyph / glued-root bypasses (red team RT-05) and
// "Zalgo" stacks of combining marks (RT-14). The rules live in shared/names.ts (foundation); the server enforces
// them on every profile create/rename. These cases run once shared/ carries the fix, which bumps
// WORDLIST_VERSION to 2 (until then they are reported as skipped, not silently passed).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORDLIST_VERSION } from '../../shared/wordlist.js';
import { makeProfile } from './support/helpers.js';
import { makeTestApp, type SignedIn, type TestApp } from './support/testApp.js';

const FIXED = WORDLIST_VERSION >= 2;
let t: TestApp;
let A: SignedIn;

beforeEach(async () => {
  t = await makeTestApp();
  A = await t.signIn('parent-a');
});
afterEach(async () => {
  await t.close();
});

const create = (name: string) => t.call('POST', '/v1/profiles', { token: A.token, body: { name, avatar: { animal: 'lion', color: 0 } } });

describe.runIf(FIXED)('RT-05: homoglyphs and glued short roots', () => {
  it('are refused with 422 bad_name (not_nice)', async () => {
    const bypasses = ['Fuсk', 'Ѕhit', 'ЅΗΙΤ', 'BigFuck', 'Fuckhole', 'Shitbag', 'Batshit', 'Cuntface'];
    for (const name of bypasses) {
      const r = await create(name);
      expect(r.status, name).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'bad_name', details: { problem: 'not_nice' } });
    }
  });

  it('real names that contain those letters still work', async () => {
    for (const name of ['Harshit', 'Shital', 'Shitake', 'Scunthorpe', 'Маша', 'Νίκος']) await makeProfile(t, A.token, name);
  });
});

describe.runIf(FIXED)('RT-14: stacked combining marks', () => {
  it("'Mia' + 171 combining marks is 422 bad_chars; ordinary marks in other scripts are fine", async () => {
    const zalgo = 'Mia' + '̶̷̸̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̏'.repeat(9);
    const r = await create(zalgo);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'bad_name', details: { problem: 'bad_chars' } });
    for (const name of ['Zoë', 'Ñandú', 'हुँ', 'ကျော်']) await makeProfile(t, A.token, name);
  });
});

describe('the shared name filter version', () => {
  it('is 1 (before the fix) or 2+ (the cases above run)', () => {
    expect(WORDLIST_VERSION).toBeGreaterThanOrEqual(1);
  });
});
