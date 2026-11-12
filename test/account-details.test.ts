import { expect, test } from 'bun:test';
import { parseUsage, profilePicture, photoType } from '../src/account-details';
import { fakeAuth } from '../tools/fixtures/fake-auth';

test('usage identifies windows by duration and preserves unknown limits', () => {
  const limits = parseUsage({ rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 10080, usedPercent: 90, resetsAt: 2000000000 }, secondary: { windowDurationMins: 300, usedPercent: 25 } } } });
  expect(limits.fiveHour?.remaining).toBe(75);
  expect(limits.weekly?.remaining).toBe(10);
  expect(limits.weekly?.resetsAt).toBe(2000000000);
  expect(parseUsage({ rateLimits: { primary: { windowDurationMins: 15, usedPercent: 0 } } }).fiveHour).toBeNull();
  expect(parseUsage({}).weekly).toBeNull();
  expect(parseUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: NaN } } }).fiveHour).toBeNull();
});
test('profile image only accepts supported HTTPS picture claims', () => {
  const auth = fakeAuth('one');
  const withPicture = (picture: string) => {
    const claims = { picture };
    return JSON.stringify({ ...auth, tokens: { ...auth.tokens, id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x` } });
  };
  expect(profilePicture(withPicture('https://lh3.googleusercontent.com/a/photo'))).toBe('https://lh3.googleusercontent.com/a/photo');
  for (const url of ['javascript:alert(1)', 'http://127.0.0.1/private', 'https://evil.example/photo', 'https://cdn.openai.com.evil.example/photo']) expect(profilePicture(withPicture(url))).toBeNull();
  expect(profilePicture(JSON.stringify(auth))).toBeNull();
  expect(photoType(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toBeNull();
});
