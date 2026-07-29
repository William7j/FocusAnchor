const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_COOKIE_INPUT = 64 * 1024;
const MAX_COOKIE_COUNT = 128;

function isWeReadContentHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'weread.qq.com' || host.endsWith('.weread.qq.com');
}

function isAllowedWeReadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (isWeReadContentHost(url.hostname)) return true;
    return url.hostname === 'open.weixin.qq.com' && url.pathname.startsWith('/connect/qrconnect');
  } catch {
    return false;
  }
}

function assertCookieName(name) {
  if (!COOKIE_NAME.test(name)) throw new Error('Cookie 名称格式无效。');
}

function normalizeSameSite(value) {
  const sameSite = String(value || '').toLowerCase();
  if (sameSite === 'lax' || sameSite === 'strict' || sameSite === 'no_restriction') return sameSite;
  if (sameSite === 'none') return 'no_restriction';
  return 'lax';
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') throw new Error('Cookie 数据格式无效。');
  const name = String(cookie.name || '').trim();
  const value = String(cookie.value ?? '');
  assertCookieName(name);
  if (!name || value.length > MAX_COOKIE_INPUT) throw new Error('Cookie 内容无效或过长。');

  const sourceDomain = String(cookie.domain || 'weread.qq.com').trim().toLowerCase();
  const hostname = sourceDomain.replace(/^\./, '');
  if (!isWeReadContentHost(hostname)) throw new Error('只允许导入微信读书域名的 Cookie。');

  const path = String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/') : '/';
  const result = {
    url: `https://${hostname}${path}`,
    name,
    value,
    domain: sourceDomain,
    path,
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normalizeSameSite(cookie.sameSite),
  };

  const expirationDate = Number(cookie.expirationDate ?? cookie.expires);
  if (Number.isFinite(expirationDate) && expirationDate > 0) result.expirationDate = expirationDate;
  return result;
}

function parseCookieHeader(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请粘贴有效的 Cookie Header。');
  if (value.length > MAX_COOKIE_INPUT) throw new Error('Cookie Header 过长。');
  const header = value.trim().replace(/^cookie\s*:\s*/i, '');
  const ignoredAttributes = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
  const cookies = new Map();

  for (const segment of header.split(';')) {
    const item = segment.trim();
    if (!item) continue;
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const cookieValue = item.slice(separator + 1).trim();
    if (ignoredAttributes.has(name.toLowerCase())) continue;
    assertCookieName(name);
    cookies.set(name, normalizeCookie({ name, value: cookieValue }));
    if (cookies.size > MAX_COOKIE_COUNT) throw new Error('Cookie 数量超过限制。');
  }

  if (!cookies.size) throw new Error('未识别到可导入的 Cookie。');
  return [...cookies.values()];
}

function parseCookieJson(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请粘贴 Cookie JSON。');
  if (value.length > MAX_COOKIE_INPUT) throw new Error('Cookie JSON 过长。');
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Cookie JSON 格式无效。');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(list) || !list.length) throw new Error('Cookie JSON 中没有可导入的数据。');
  if (list.length > MAX_COOKIE_COUNT) throw new Error('Cookie 数量超过限制。');
  return list.map(normalizeCookie);
}

function parseCookieImport(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Cookie 导入请求无效。');
  if (payload.format === 'header') return parseCookieHeader(payload.value);
  if (payload.format === 'json') return parseCookieJson(payload.value);
  throw new Error('不支持的 Cookie 导入格式。');
}

module.exports = {
  isAllowedWeReadHost: isWeReadContentHost,
  isAllowedWeReadUrl,
  parseCookieHeader,
  parseCookieImport,
};
