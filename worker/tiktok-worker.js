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

// Tried in order until one has free-tier quota (some models return limit:0/404).
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.0-flash'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const urlOf = (v) => (typeof v === 'string' ? v : (v && v.urlList && v.urlList[0]) || '');

// Base64-encode an ArrayBuffer in chunks (btoa + full spread overflows on big images).
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Fetch the cover image and return it as a Gemini inline_data part, so the model
// can read a brand/product name off the packaging when the caption doesn't say it.
async function imagePart(thumbnail) {
  if (!thumbnail) return null;
  try {
    const r = await fetch(thumbnail);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 4000000) return null;
    return { inline_data: { mime_type: r.headers.get('content-type') || 'image/jpeg', data: toBase64(buf) } };
  } catch (e) {
    return null;
  }
}

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

// Prompt for the product lookup. Deliberately does NOT say "search the web" —
// the google_search tool handles that. That phrasing made the ungrounded
// fallback answer in prose instead of clean JSON.
function productPrompt(hint) {
  return 'Identify the real supplement product shown in the attached image and/or described here: "' + hint + '". ' +
    'Read any visible brand or product name off the packaging in the image. ' +
    'Respond with ONLY a JSON object, no markdown and no commentary, in this exact shape: ' +
    '{"company": brand or null, "product": product name or null, "ingredients": [real listed ingredients only], ' +
    '"mainIngredient": the single dominant active ingredient or null, ' +
    '"summary": one factual sentence on what it is and its marketed purpose}. ' +
    'Use only real, verifiable information and never invent ingredients. If a field is unknown, use null (or [] for ingredients).';
}

// Real product summary via Gemini (with Google Search grounding when available).
// Returns null if no GEMINI_API_KEY is set or nothing parses. Never invents
// ingredients — unknown fields come back null.
async function productSummary(caption, thumbnail, env) {
  const key = env && env.GEMINI_API_KEY;
  if (!key || !caption) return null;
  const hint = caption.replace(/#\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (hint.length < 3) return null;

  const prompt = productPrompt(hint);
  const img = await imagePart(thumbnail); // lets the model read the product off the cover

  function parseProduct(data) {
    const cand = (data.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).map((p) => p.text || '').join('');
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return null;
    let obj;
    try { obj = JSON.parse(jm[0]); } catch (e) { return null; }
    if (!obj || (!obj.company && !obj.product && !obj.summary && !(Array.isArray(obj.ingredients) && obj.ingredients.length))) return null;
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

  async function ask(model, grounded) {
    const parts = img ? [{ text: prompt }, img] : [{ text: prompt }];
    const body = { contents: [{ parts }] };
    if (grounded) body.tools = [{ google_search: {} }];
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // For each model, try web-grounded first (adds sources) then ungrounded; the
  // first response that yields VALID product JSON wins. Grounded replies often
  // wrap prose around the JSON, so the ungrounded pass is the clean fallback.
  for (const model of GEMINI_MODELS) {
    for (const grounded of [true, false]) {
      const data = await ask(model, grounded);
      const out = data && parseProduct(data);
      if (out) return out;
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Temporary diagnostic: /?debug=gemini reports which models have quota
    // (200 = works, 429 = no free quota, 404 = model unavailable). Never the key.
    if (new URL(request.url).searchParams.get('debug') === 'gemini') {
      const key = env && env.GEMINI_API_KEY;
      if (!key) return json({ keyPresent: false, note: 'GEMINI_API_KEY secret is not set on this Worker.' });
      const models = {};
      let sample = null;
      const testPrompt = productPrompt('Bloom Creatine Gummies by Bloom Nutrition');
      for (const m of GEMINI_MODELS) {
        try {
          const r = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + key,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: testPrompt }] }] }) }
          );
          models[m] = r.status;
          if (r.ok && !sample) {
            const d = await r.json();
            const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
            sample = { model: m, text: parts.map((p) => p.text || '').join('').slice(0, 500) };
          }
        } catch (e) { models[m] = 'error'; }
      }
      return json({ v: 4, keyPresent: true, models, sample });
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
      out.product = await productSummary(out.caption, out.thumbnail, env); // real product data (from caption + cover image), or null
      return json(out);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
