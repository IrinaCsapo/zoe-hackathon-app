// Vera — TikTok post proxy (Cloudflare Worker)
// ---------------------------------------------------------------------------
// The browser can't read a TikTok video page directly (CORS + bot protection),
// but a Worker can. This fetches the page server-side, parses the JSON TikTok
// itself embeds, and returns the surface data Vera needs — WITH open CORS so the
// app can call it. It deliberately does NOT return likes (heartCount), which
// would be misread as product endorsement.
//
// Deploy (free): https://dash.cloudflare.com → Workers & Pages → Create Worker →
// paste this file → Deploy. Copy the *.workers.dev URL and set WORKER_URL in
// index.html. Test: <your-worker-url>/?url=https://www.tiktok.com/@bloom/video/7544092143711751437
//
// OPTIONAL — real product summary: add a Worker secret named GEMINI_API_KEY
// (Cloudflare → your Worker → Settings → Variables and Secrets → Add → Secret).
// Get a free key at https://aistudio.google.com/apikey. With it set, the Worker
// uses Gemini + Google Search grounding to return the real product's company,
// ingredients and a one-line summary (with source links). It NEVER invents
// ingredients — unverifiable fields come back null. Without the key, it's skipped.
//
// Not affiliated with TikTok; reads only public page data for the pasted post.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const urlOf = (v) => (typeof v === 'string' ? v : (v && v.urlList && v.urlList[0]) || '');

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function oembedThumb(link) {
  try {
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(link));
    if (!r.ok) return '';
    const d = await r.json();
    return d.thumbnail_url || '';
  } catch (e) {
    return '';
  }
}

// Real product summary via Gemini + Google Search grounding. Returns null if no
// GEMINI_API_KEY is set or anything fails. Strictly instructed to use only
// web-verified data and never invent ingredients (unknown fields => null).
async function productSummary(caption, env) {
  const key = env && env.GEMINI_API_KEY;
  if (!key || !caption) return null;
  const hint = caption.replace(/#\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (hint.length < 3) return null;

  const prompt =
    'Identify the real supplement product described here: "' + hint + '". ' +
    'Use Google Search to get accurate, real information — do NOT invent anything. ' +
    'Respond with ONLY a JSON object (no markdown, no commentary) in this shape: ' +
    '{"company": brand or null, "product": product name or null, "ingredients": [real listed ingredients], ' +
    '"mainIngredient": the single dominant active ingredient or null, ' +
    '"summary": one factual sentence on what it is, its form and its marketed purpose}. ' +
    'If a field cannot be verified from real sources, set it to null (or [] for ingredients). Never guess ingredients.';

  async function ask(grounded) {
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    if (grounded) body.tools = [{ google_search: {} }];
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Web-grounded first (best, with citations); fall back to the model's own
  // knowledge if grounding is unavailable for this key/project, so we still
  // return real product data rather than nothing.
  const data = (await ask(true)) || (await ask(false));
  if (!data) return null;

  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map((p) => p.text || '').join('');
  const jm = text.match(/\{[\s\S]*\}/);
  if (!jm) return null;
  let obj;
  try { obj = JSON.parse(jm[0]); } catch (e) { return null; }
  const chunks = ((cand.groundingMetadata || {}).groundingChunks) || [];
  const sources = chunks
    .map((c) => (c.web ? { title: c.web.title || '', uri: c.web.uri || '' } : null))
    .filter((s) => s && s.uri)
    .slice(0, 3);
  return {
    company: obj.company || null,
    product: obj.product || null,
    ingredients: Array.isArray(obj.ingredients) ? obj.ingredients.filter(Boolean).slice(0, 12) : [],
    mainIngredient: obj.mainIngredient || null,
    summary: obj.summary || null,
    sources,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Temporary diagnostic: /?debug=gemini reports why the product lookup fails.
    // Returns the Gemini call status + response body (never the key itself).
    if (new URL(request.url).searchParams.get('debug') === 'gemini') {
      const key = env && env.GEMINI_API_KEY;
      if (!key) return json({ keyPresent: false, note: 'GEMINI_API_KEY secret is not set on this Worker.' });
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with JSON {"ok":true}' }] }], tools: [{ google_search: {} }] }),
        }
      );
      const body = await r.text();
      return json({ keyPresent: true, status: r.status, body: body.slice(0, 900) });
    }

    const link = new URL(request.url).searchParams.get('url');
    if (!link || !/tiktok\.com/i.test(link)) {
      return json({ error: 'Pass a TikTok link as ?url=' }, 400);
    }

    try {
      const res = await fetch(link, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
      const html = await res.text();
      const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
      if (!m) return json({ error: 'Could not read the post (TikTok may have blocked the request)' }, 502);

      const data = JSON.parse(m[1]);
      const item =
        (((data.__DEFAULT_SCOPE__ || {})['webapp.video-detail'] || {}).itemInfo || {}).itemStruct || {};
      const author = item.author || {};
      const stats = item.authorStats || {};
      const video = item.video || {};

      let thumbnail = urlOf(video.cover) || urlOf(video.originCover) || urlOf(video.dynamicCover);
      if (!thumbnail) thumbnail = await oembedThumb(link);

      // Note: heartCount (likes) is intentionally omitted.
      const out = {
        platform: 'TikTok',
        handle: author.uniqueId ? '@' + author.uniqueId : '',
        authorName: author.nickname || '',
        bio: (author.signature || '').replace(/\s+/g, ' ').trim(),
        avatar: urlOf(author.avatarThumb) || urlOf(author.avatarMedium),
        caption: (item.desc || '').replace(/\s+/g, ' ').trim(),
        thumbnail,
        followerCount: typeof stats.followerCount === 'number' ? stats.followerCount : null,
        postDate: item.createTime ? Number(item.createTime) : null,
        paidPartnership: item.isAd === true,
      };
      out.product = await productSummary(out.caption, env); // real web-grounded product data, or null
      return json(out);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
