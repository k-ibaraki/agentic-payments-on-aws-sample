import { describe, expect, it } from 'vitest';
import { corsAllowedOrigins } from './cors-origins.js';

// Amplify Hosting のブランチ URL は https://<branch>.<appId>.amplifyapp.com。
// Lambda の CORS_ALLOWED_ORIGINS は各項目を ^…$ で括った正規表現として扱う（core README）
describe('corsAllowedOrigins', () => {
  it('Amplify の AWS_APP_ID から amplifyapp.com のブランチ URL を許す正規表現を作る', () => {
    const pattern = corsAllowedOrigins({ AWS_APP_ID: 'd1abc2def3ghij' });
    expect(pattern).toBeDefined();
    const re = new RegExp(`^${pattern}$`);
    expect(re.test('https://main.d1abc2def3ghij.amplifyapp.com')).toBe(true);
    expect(re.test('https://feat-x.d1abc2def3ghij.amplifyapp.com')).toBe(true);
    // 別アプリ・別ドメイン・http は通さない
    expect(re.test('https://main.d9zzz.amplifyapp.com')).toBe(false);
    expect(re.test('https://main.d1abc2def3ghij.amplifyapp.com.evil.example')).toBe(false);
    expect(re.test('http://main.d1abc2def3ghij.amplifyapp.com')).toBe(false);
  });

  it('CORS_ALLOWED_ORIGINS が明示されていればそれを優先する（独自ドメイン向け）', () => {
    expect(
      corsAllowedOrigins({ AWS_APP_ID: 'd1abc2def3ghij', CORS_ALLOWED_ORIGINS: 'https://buyer\\.example' }),
    ).toBe('https://buyer\\.example');
  });

  it('どちらも無ければ undefined（sandbox では BlocksBackend が localhost を許すので上書きしない）', () => {
    expect(corsAllowedOrigins({})).toBeUndefined();
  });
});
