// Generate premium-looking product photos for Vera with Replicate's
// black-forest-labs/flux-schnell model (~$0.003 per image — very cheap).
//
// Usage (from the repo root):
//   REPLICATE_API_TOKEN=r8_your_token_here node scripts/generate-images.mjs
//
// It writes one square JPG per product into ./images/<id>.jpg. The app loads
// these on top of the built-in SVG art and falls back to the art if an image
// is missing, so you can run this whenever and re-run to regenerate.
//
// Requires Node 18+ (uses the built-in fetch). No npm install needed.

import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) {
  console.error('Missing REPLICATE_API_TOKEN. Run:\n  REPLICATE_API_TOKEN=r8_xxx node scripts/generate-images.mjs');
  process.exit(1);
}

const OUT_DIR = path.join(process.cwd(), 'images');

// One shared look so every product feels like the same premium brand shelf.
const STYLE =
  'premium supplement product photography, one product centred in frame, ' +
  'clean matte label, soft diffused studio lighting, gentle shadow, ' +
  'pastel lilac and warm cream background, minimalist high-end wellness brand, ' +
  'editorial, sharp focus, 4k, no text on label, no hands, no people';

// id must match the product keys in index.html so the app can find images/<id>.jpg
const PRODUCTS = [
  { id: 'collagen',        subject: 'a frosted glass jar of marine collagen peptide powder with a soft rose-gold lid' },
  { id: 'creatine',        subject: 'a matte white tub of creatine monohydrate powder with a minimalist label' },
  { id: 'magnesium',       subject: 'an amber glass supplement bottle of magnesium glycinate capsules' },
  { id: 'greens',          subject: 'a kraft stand-up pouch of green superfood powder with a subtle leaf motif' },
  { id: 'zoe',             subject: 'a modern matte pouch of prebiotic daily fibre blend, science-forward wellness brand' },
  { id: 'ashwagandha',     subject: 'a dark apothecary glass bottle of ashwagandha capsules, calm earthy branding' },
  { id: 'skinnytea',       subject: 'a pretty pastel pouch of loose-leaf herbal detox tea, delicate wellness branding' },
  { id: 'creatinegummies', subject: 'a clear jar of colourful creatine gummy bears with a pastel label' },
];

async function generate(p) {
  const input = {
    prompt: p.subject + ', ' + STYLE,
    aspect_ratio: '1:1',
    output_format: 'jpg',
    output_quality: 90,
    num_outputs: 1,
  };

  const res = await fetch(
    'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
        // Wait for the prediction to finish and return the result inline.
        'Prefer': 'wait',
      },
      body: JSON.stringify({ input }),
    }
  );

  if (!res.ok) throw new Error(p.id + ': ' + res.status + ' ' + (await res.text()));
  const data = await res.json();
  const url = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!url) throw new Error(p.id + ': no image URL in response');

  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(p.id + ': download failed ' + imgRes.status);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  await fs.writeFile(path.join(OUT_DIR, p.id + '.jpg'), buf);
  console.log('  ✓ images/' + p.id + '.jpg');
}

await fs.mkdir(OUT_DIR, { recursive: true });
console.log('Generating ' + PRODUCTS.length + ' product photos with flux-schnell…');
for (const p of PRODUCTS) {
  try {
    await generate(p);
  } catch (e) {
    console.error('  ✗ ' + e.message);
  }
}
console.log('Done. Photos are in ./images — reload the app to see them.');
