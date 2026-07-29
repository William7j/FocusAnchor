// @vitest-environment node
import { describe, expect, it } from 'vitest';
import security from '../electron/security.cjs';

const { isAllowedWeReadUrl, parseCookieImport } = security;

describe('微信读书会话边界', () => {
  it('只允许微信读书和扫码登录所需的 HTTPS 页面', () => {
    expect(isAllowedWeReadUrl('https://weread.qq.com/')).toBe(true);
    expect(isAllowedWeReadUrl('https://open.weixin.qq.com/connect/qrconnect')).toBe(true);
    expect(isAllowedWeReadUrl('https://www.qq.com/')).toBe(false);
    expect(isAllowedWeReadUrl('https://weixin.qq.com/')).toBe(false);
    expect(isAllowedWeReadUrl('http://weread.qq.com/')).toBe(false);
    expect(isAllowedWeReadUrl('https://example.com/')).toBe(false);
  });

  it('将 Cookie Header 限制为微信读书域名', () => {
    const cookies = parseCookieImport({ format: 'header', value: 'wr_vid=123; wr_skey=abc=def' });
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({ domain: 'weread.qq.com', name: 'wr_vid', value: '123' });
    expect(cookies[1].value).toBe('abc=def');
  });

  it('拒绝跨站 Cookie JSON', () => {
    expect(() => parseCookieImport({
      format: 'json',
      value: JSON.stringify([{ name: 'session', value: 'secret', domain: 'example.com' }]),
    })).toThrow('只允许导入微信读书域名的 Cookie');
  });
});
