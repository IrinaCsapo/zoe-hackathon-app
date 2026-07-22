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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

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
      return json({
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
      });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
