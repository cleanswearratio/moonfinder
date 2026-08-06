/**
 * POST /api/subscribe — the only server code in the project (CLAUDE.md §1.3).
 *
 * Its whole job is to talk to ActiveCampaign with a token the browser never
 * sees. It recomputes nothing: the client sends its own result, and someone
 * forging their moon sign harms no one (§9).
 *
 * Framework-free and dependency-free on purpose, so it stays portable if this
 * ever moves off Vercel. The request and response types are declared
 * structurally rather than imported for the same reason.
 *
 * Rate limiting: §9 offers a choice, and this takes the zero-infra option —
 * honeypot plus ActiveCampaign's own abuse limits, no persistent counter. A
 * per-instance counter was considered and rejected: serverless invocations do
 * not share memory, so it would read as protection while providing close to
 * none. Adding Vercel KV or Upstash is the upgrade path, and it contradicts
 * §1.4 for v1. Flagged rather than silently dropped.
 */

interface Body { [key: string]: unknown }
interface Req { method?: string; body?: Body }
interface Res { status(code: number): Res; json(body: unknown): void }

/** One call shape for the whole API: GET when there is no body, POST otherwise. */
const ac = async <T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> => {
  const response = await fetch(`https://${process.env.AC_ACCOUNT}.api-us1.com/api/3/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Api-Token': process.env.AC_API_TOKEN ?? '', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, data: (await response.json()) as T };
};

/** Env var holding the numeric field id -> key on the request body. §9 forbids
 *  hardcoding the ids, so an unset var simply drops that field. */
const FIELDS: readonly (readonly [string, string])[] = [
  ['AC_FIELD_MOON_SIGN', 'moonSign'], ['AC_FIELD_MOON_ALT_SIGN', 'moonAltSign'], ['AC_FIELD_MOON_CUSP', 'moonCusp'],
  ['AC_FIELD_SUN_SIGN', 'sunSign'], ['AC_FIELD_BIRTH_YEAR', 'birthYear'], ['AC_FIELD_BIRTH_TZ', 'birthTz'],
  ['AC_FIELD_TIME_KNOWN', 'timeKnown'],
];

/** Never trust the client's check (§9). */
export const validEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);

export const fieldValues = (body: Body): { field: string; value: string }[] =>
  FIELDS.flatMap(([env, key]) => process.env[env]
    ? [{ field: process.env[env]!, value: String(body[key] ?? '') }] : []);

/** `cusp-unresolved` is the segment to build the first offer against (§9). */
export const tagsFor = (body: Body): string[] => [
  'source-moon-app', `moon-${String(body.moonSign ?? '').toLowerCase()}`,
  ...(body.moonCusp === 'yes' ? ['cusp-unresolved'] : []),
];

/** contactTags takes a numeric id, so names are resolved and created on demand. */
async function tagId(name: string): Promise<string | undefined> {
  const found = await ac<{ tags?: { id: string }[] }>(`tags?filters[tag]=${encodeURIComponent(name)}`);
  if (found.data.tags?.[0]?.id) return found.data.tags[0].id;
  const made = await ac<{ tag?: { id: string } }>('tags', { tag: { tag: name, tagType: 'contact', description: '' } });
  return made.data.tag?.id;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const body: Body = req.body ?? {};

  // Honeypot filled means a bot. Say nothing useful and do nothing (§9).
  if (typeof body.company === 'string' && body.company !== '') return res.status(200).json({ ok: true });
  if (!validEmail(body.email)) return res.status(400).json({ error: 'That email address does not look right.' });

  try {
    // contact/sync upserts by email — repeat visitors are common with a
    // shareable lead magnet, and `contacts` would fail on a duplicate (§9).
    const sync = await ac<{ contact?: { id: string } }>('contact/sync',
      { contact: { email: body.email, fieldValues: fieldValues(body) } });
    const contact = sync.data.contact?.id;
    if (!sync.ok || !contact) throw new Error(`contact/sync returned ${sync.status}`);

    const listed = await ac('contactLists', { contactList: { list: process.env.AC_LIST_ID, contact, status: 1 } });
    if (!listed.ok) throw new Error(`contactLists returned ${listed.status}`);

    for (const name of tagsFor(body)) {
      const tag = await tagId(name);
      if (tag) await ac('contactTags', { contactTag: { contact, tag } });
    }
    return res.status(200).json({ ok: true });
  } catch (cause) {
    // Log server side; never hand the client a token or a raw AC error body (§9).
    console.error('[subscribe]', cause instanceof Error ? cause.message : cause);
    return res.status(502).json({ error: 'We could not save that just now. Try again shortly.' });
  }
}
