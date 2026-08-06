import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { fieldValues, tagsFor, validEmail } from '../api/subscribe.js';

/**
 * The ActiveCampaign call sequence in §9, checked against a stubbed API. A live
 * test list is still the last word — this pins the request shapes, the ordering
 * and the failure behaviour so that verification is a confirmation rather than
 * a debugging session.
 */

const ENV = {
  AC_ACCOUNT: 'testaccount',
  AC_API_TOKEN: 'secret-token-value',
  AC_LIST_ID: '7',
  AC_FIELD_MOON_SIGN: '1', AC_FIELD_MOON_ALT_SIGN: '2', AC_FIELD_MOON_CUSP: '3',
  AC_FIELD_SUN_SIGN: '4', AC_FIELD_BIRTH_YEAR: '5', AC_FIELD_BIRTH_TZ: '6',
  AC_FIELD_TIME_KNOWN: '7',
};

const CUSP_BODY = {
  email: 'reader@example.com', company: '',
  moonSign: 'Capricorn', moonAltSign: 'Aquarius', moonCusp: 'yes',
  sunSign: 'Cancer', birthYear: 1988, birthTz: 'America/New_York', timeKnown: 'no',
};

interface Call { url: string; method: string; headers: Record<string, string>; body: any }

function stubFetch(overrides: Record<string, { status?: number; json?: unknown }> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    calls.push({
      url, method: init.method ?? 'GET', headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const path = url.split('/api/3/')[1]!.split('?')[0]!;
    const override = overrides[path];
    const defaults: Record<string, unknown> = {
      'contact/sync': { contact: { id: '42' } },
      contactLists: { contactList: { id: '9' } },
      tags: { tags: [{ id: '100' }] },
      contactTags: { contactTag: { id: '5' } },
    };
    return {
      ok: (override?.status ?? 200) < 400,
      status: override?.status ?? 200,
      json: async () => override?.json ?? defaults[path] ?? {},
    };
  });
  return calls;
}

function mockRes() {
  const out: { code: number; body: any } = { code: 0, body: undefined };
  const res = {
    status(code: number) { out.code = code; return res; },
    json(body: unknown) { out.body = body; },
  };
  return { res, out };
}

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('server-side validation', () => {
  it('accepts ordinary addresses and rejects malformed ones', () => {
    expect(validEmail('reader@example.com')).toBe(true);
    expect(validEmail('a.b+tag@sub.example.co.uk')).toBe(true);
    expect(validEmail('no-at-sign')).toBe(false);
    expect(validEmail('trailing@dot.')).toBe(false);
    expect(validEmail('spaces in@example.com')).toBe(false);
    expect(validEmail('nodot@localhost')).toBe(false);
    expect(validEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
    expect(validEmail(undefined)).toBe(false);
    expect(validEmail(12345)).toBe(false);
  });

  it('rejects a bad address before calling ActiveCampaign at all', async () => {
    const calls = stubFetch();
    const { res, out } = mockRes();
    await handler({ method: 'POST', body: { email: 'nope' } }, res);
    expect(out.code).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses anything but POST', async () => {
    const calls = stubFetch();
    const { res, out } = mockRes();
    await handler({ method: 'GET' }, res);
    expect(out.code).toBe(405);
    expect(calls).toHaveLength(0);
  });
});

describe('honeypot', () => {
  it('returns 200 and does nothing when filled', async () => {
    const calls = stubFetch();
    const { res, out } = mockRes();
    await handler({ method: 'POST', body: { ...CUSP_BODY, company: 'Acme Inc' } }, res);
    expect(out.code).toBe(200);
    expect(out.body).toEqual({ ok: true });
    // Indistinguishable from success to the caller, and no contact created.
    expect(calls).toHaveLength(0);
  });
});

describe('field mapping', () => {
  it('sends all seven custom fields by their configured ids', () => {
    expect(fieldValues(CUSP_BODY)).toEqual([
      { field: '1', value: 'Capricorn' }, { field: '2', value: 'Aquarius' },
      { field: '3', value: 'yes' }, { field: '4', value: 'Cancer' },
      { field: '5', value: '1988' }, { field: '6', value: 'America/New_York' },
      { field: '7', value: 'no' },
    ]);
  });

  it('drops a field whose id is not configured rather than guessing one', () => {
    vi.stubEnv('AC_FIELD_MOON_ALT_SIGN', '');
    const ids = fieldValues(CUSP_BODY).map((f) => f.field);
    expect(ids).not.toContain('2');
    expect(ids).toHaveLength(6);
  });

  it('sends an empty alt sign for a definite reading, not the word undefined', () => {
    const definite = { ...CUSP_BODY, moonAltSign: '', moonCusp: 'no' };
    expect(fieldValues(definite)).toContainEqual({ field: '2', value: '' });
    expect(fieldValues({ email: 'a@b.com' })).toContainEqual({ field: '1', value: '' });
  });
});

describe('tags', () => {
  it('tags the source, the sign, and the unresolved cusp', () => {
    expect(tagsFor(CUSP_BODY)).toEqual(['source-moon-app', 'moon-capricorn', 'cusp-unresolved']);
  });

  it('leaves off cusp-unresolved when the sign is definite', () => {
    expect(tagsFor({ ...CUSP_BODY, moonCusp: 'no' })).toEqual(['source-moon-app', 'moon-capricorn']);
  });
});

describe('the §9 call sequence', () => {
  it('syncs the contact, subscribes it, then applies every tag', async () => {
    const calls = stubFetch();
    const { res, out } = mockRes();
    await handler({ method: 'POST', body: CUSP_BODY }, res);
    expect(out.code).toBe(200);

    const paths = calls.map((c) => `${c.method} ${c.url.split('/api/3/')[1]}`);
    expect(paths[0]).toBe('POST contact/sync');
    expect(paths[1]).toBe('POST contactLists');
    // Three tags, each looked up then applied.
    expect(paths.filter((p) => p.startsWith('POST contactTags'))).toHaveLength(3);
    expect(paths.filter((p) => p.startsWith('GET tags?'))).toHaveLength(3);

    expect(calls[0]!.body).toEqual({
      contact: { email: 'reader@example.com', fieldValues: fieldValues(CUSP_BODY) },
    });
    expect(calls[1]!.body).toEqual({ contactList: { list: '7', contact: '42', status: 1 } });
    expect(calls.find((c) => c.url.includes('contactTags'))!.body)
      .toEqual({ contactTag: { contact: '42', tag: '100' } });
  });

  it('authenticates with the Api-Token header on every call', async () => {
    const calls = stubFetch();
    const { res } = mockRes();
    await handler({ method: 'POST', body: CUSP_BODY }, res);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers['Api-Token']).toBe('secret-token-value');
    expect(calls[0]!.url).toBe('https://testaccount.api-us1.com/api/3/contact/sync');
  });

  it('creates a tag that does not exist yet', async () => {
    const calls = stubFetch({ tags: { json: { tags: [] } } });
    const { res } = mockRes();
    await handler({ method: 'POST', body: CUSP_BODY }, res);
    const created = calls.filter((c) => c.method === 'POST' && c.url.includes('/tags'));
    expect(created).toHaveLength(3);
    expect(created[0]!.body).toEqual({
      tag: { tag: 'source-moon-app', tagType: 'contact', description: '' },
    });
  });
});

describe('failure never leaks anything', () => {
  it('returns a generic message when ActiveCampaign rejects the sync', async () => {
    stubFetch({ 'contact/sync': { status: 422, json: { errors: [{ title: 'Email already taken' }] } } });
    const { res, out } = mockRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler({ method: 'POST', body: CUSP_BODY }, res);

    expect(out.code).toBe(502);
    const serialised = JSON.stringify(out.body);
    expect(serialised).not.toContain('secret-token-value');
    expect(serialised).not.toContain('Email already taken');
    expect(out.body.error).toMatch(/try again/i);
    // The detail belongs in the server log, not the response.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not report success when the list subscription fails', async () => {
    stubFetch({ contactLists: { status: 500 } });
    const { res, out } = mockRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler({ method: 'POST', body: CUSP_BODY }, res);
    expect(out.code).toBe(502);
    spy.mockRestore();
  });
});
