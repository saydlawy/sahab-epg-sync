/**
 * Sahab EPG Sync — Daily update
 *
 * What it does:
 *   1. Downloads EPG sources listed in config/epg_sources
 *   2. For each channel with epgId, checks if that channel still exists in its source
 *   3. Updates per-channel: epgAvailable, lastEpgSyncAt
 *   4. Updates config/epg_sources.lastFetchedAt
 *
 * Auth: reads FIREBASE_SERVICE_ACCOUNT env var (JSON or Base64-encoded JSON).
 */

const axios = require('axios');
const zlib = require('zlib');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function loadCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
  let json = raw.trim();
  if (!json.startsWith('{')) {
    json = Buffer.from(json, 'base64').toString('utf8');
  }
  return JSON.parse(json);
}

const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(loadCredential()) });
const db = getFirestore(app);

async function fetchXml(url) {
  const r = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 300000,
    maxContentLength: 500 * 1024 * 1024,
    headers: { 'User-Agent': 'Sahab-EPG-Sync/1.0' },
  });
  const buf = Buffer.from(r.data);
  try {
    return zlib.gunzipSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}

(async () => {
  console.log('=== Sahab EPG Sync ===');
  console.log('Started:', new Date().toISOString());

  // 1) Read epg_sources config
  const cfgRef = db.collection('config').doc('epg_sources');
  const cfgSnap = await cfgRef.get();
  if (!cfgSnap.exists) throw new Error('config/epg_sources not found in Firestore');
  const cfg = cfgSnap.data();
  console.log('Sources configured:', Object.keys(cfg).join(', '));

  // 2) Fetch each source and build set of available channel ids
  const available = {}; // { AE1: Set<epgId>, EG1: Set<epgId>, ... }
  const sourceStats = {};
  for (const [name, meta] of Object.entries(cfg)) {
    if (!meta.url) { console.log(`[${name}] no url, skip`); continue; }
    process.stdout.write(`[${name}] downloading... `);
    try {
      const raw = await fetchXml(meta.url);
      const ids = new Set();
      const re = /<channel\s+id="([^"]+)"/g;
      let m;
      while ((m = re.exec(raw))) ids.add(m[1]);
      available[name] = ids;
      sourceStats[name] = { channels: ids.size, sizeMB: +(raw.length / 1024 / 1024).toFixed(2) };
      console.log(`OK (${ids.size} channels, ${sourceStats[name].sizeMB}MB)`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      sourceStats[name] = { error: e.message };
    }
  }

  // 3) Read all channels with epgId
  console.log('\nFetching channels with epgId...');
  const channelsSnap = await db.collection('global_channels')
    .where('epgId', '!=', null).get();
  console.log(`Channels with epgId: ${channelsSnap.size}`);

  // 4) Update each channel
  const now = Date.now();
  let availableCount = 0;
  let unavailableCount = 0;
  const updates = [];

  for (const doc of channelsSnap.docs) {
    const c = doc.data();
    const srcSet = available[c.epgSource];
    const isAvail = !!(srcSet && srcSet.has(c.epgId));
    updates.push({
      ref: doc.ref,
      data: {
        epgAvailable: isAvail,
        lastEpgSyncAt: now,
        epgUpdatedAt: now,
      },
    });
    if (isAvail) availableCount++; else unavailableCount++;
  }

  // Batch write (400 per batch)
  console.log(`Writing ${updates.length} channel updates...`);
  const BATCH = 400;
  for (let i = 0; i < updates.length; i += BATCH) {
    const b = db.batch();
    for (const u of updates.slice(i, i + BATCH)) b.update(u.ref, u.data);
    await b.commit();
    console.log(`  committed ${Math.min(i + BATCH, updates.length)}/${updates.length}`);
  }

  // 5) Update config/epg_sources
  const newCfg = { ...cfg };
  for (const [name, stats] of Object.entries(sourceStats)) {
    if (!newCfg[name]) continue;
    newCfg[name].lastFetchedAt = now;
    if (stats.channels) newCfg[name].totalChannels = stats.channels;
    newCfg[name].lastError = stats.error || null;
  }
  newCfg.__lastRun = {
    at: now,
    channelsScanned: channelsSnap.size,
    available: availableCount,
    unavailable: unavailableCount,
  };
  await cfgRef.set(newCfg, { merge: true });

  // 6) Report
  console.log('\n=== SUMMARY ===');
  console.log(`Channels scanned:  ${channelsSnap.size}`);
  console.log(`  with EPG:        ${availableCount}`);
  console.log(`  missing in src:  ${unavailableCount}`);
  for (const [name, s] of Object.entries(sourceStats)) {
    console.log(`  [${name}] ${s.error ? 'FAILED' : s.channels + ' channels'}`);
  }
  console.log('\nDone:', new Date().toISOString());
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
