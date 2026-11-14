/**
 * Sahab EPG Sync — Daily update
 *
 * What it does:
 *   1. Downloads EPG sources listed in config/epg_sources
 *   2. For each channel with epgId, checks if that channel still exists in its source
 *   3. Updates per-channel: epgAvailable, lastEpgSyncAt
 *   4. NEW: Parses <programme> for our 249 channels → writes global_epg/{epgId}
 *   5. Updates config/epg_sources.lastFetchedAt + __lastRun
 */

const axios = require('axios');
const zlib = require('zlib');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function loadCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
  let json = raw.trim();
  if (!json.startsWith('{')) json = Buffer.from(json, 'base64').toString('utf8');
  return JSON.parse(json);
}

const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(loadCredential()) });
const db = getFirestore(app);

async function fetchXml(url) {
  const r = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 300000,
    maxContentLength: 500 * 1024 * 1024,
    headers: { 'User-Agent': 'Sahab-EPG-Sync/2.0' },
  });
  const buf = Buffer.from(r.data);
  try { return zlib.gunzipSync(buf).toString('utf8'); }
  catch { return buf.toString('utf8'); }
}

function parseXmltvDate(s) {
  // "20261115050000 +0000" or "20261115050000"
  const clean = String(s).trim();
  const datePart = clean.slice(0, 14);
  const tzPart = clean.slice(14).trim();
  const year = +datePart.slice(0, 4);
  const month = +datePart.slice(4, 6) - 1;
  const day = +datePart.slice(6, 8);
  const hour = +datePart.slice(8, 10);
  const min = +datePart.slice(10, 12);
  const sec = +datePart.slice(12, 14);
  let offsetMs = 0;
  if (tzPart && tzPart.length >= 5) {
    const sign = tzPart[0] === '-' ? -1 : 1;
    const h = parseInt(tzPart.slice(1, 3), 10);
    const m = parseInt(tzPart.slice(3, 5), 10);
    offsetMs = sign * (h * 60 + m) * 60 * 1000;
  }
  return Math.floor((Date.UTC(year, month, day, hour, min, sec) - offsetMs) / 1000);
}

function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

(async () => {
  console.log('=== Sahab EPG Sync v2 ===');
  console.log('Started:', new Date().toISOString());

  const cfgRef = db.collection('config').doc('epg_sources');
  const cfgSnap = await cfgRef.get();
  if (!cfgSnap.exists) throw new Error('config/epg_sources not found');
  const cfg = cfgSnap.data();
  console.log('Sources configured:', Object.keys(cfg).join(', '));

  // Read channels with epgId first (we need the set to filter programmes)
  console.log('\nFetching channels with epgId...');
  const channelsSnap = await db.collection('global_channels').where('epgId', '!=', null).get();
  console.log(`Channels with epgId: ${channelsSnap.size}`);
  const epgIdsToFetch = new Set();
  for (const doc of channelsSnap.docs) {
    const c = doc.data();
    if (c.epgId) epgIdsToFetch.add(c.epgId);
  }
  console.log(`Unique epgIds to fetch: ${epgIdsToFetch.size}`);

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const minEndSec = nowSec - 3600; // keep programmes ending ≥1h in the past

  // Download + parse each source
  const available = {};
  const sourceStats = {};
  const epgByChannel = {}; // { epgId: [{start,end,title,description}] }
  const epgChannelSource = {}; // { epgId: sourceName }

  // Sort sources by priority (lower = higher priority)
  const sourceEntries = Object.entries(cfg)
    .filter(([, m]) => m && m.url)
    .sort((a, b) => (a[1].priority || 99) - (b[1].priority || 99));

  for (const [name, meta] of sourceEntries) {
    process.stdout.write(`[${name}] downloading... `);
    let raw;
    try { raw = await fetchXml(meta.url); }
    catch (e) { console.log(`FAILED: ${e.message}`); sourceStats[name] = { error: e.message }; continue; }

    // 1) build available channel set (existing behavior)
    const ids = new Set();
    const chRe = /<channel\s+id="([^"]+)"/g;
    let m;
    while ((m = chRe.exec(raw))) ids.add(m[1]);
    available[name] = ids;

    // 2) parse programmes for our epgIds
    let parsed = 0;
    const progRe = /<programme\s+start="([^"]+)"\s+stop="([^"]+)"\s+channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/g;
    let pm;
    while ((pm = progRe.exec(raw))) {
      const [, startStr, stopStr, chId, body] = pm;
      if (!epgIdsToFetch.has(chId)) continue;
      if (epgChannelSource[chId] && epgChannelSource[chId] !== name) continue; // already covered by higher-priority source
      const start = parseXmltvDate(startStr);
      const end = parseXmltvDate(stopStr);
      if (end < minEndSec) continue;
      const tm = body.match(/<title[^>]*>([^<]*)<\/title>/);
      const dm = body.match(/<desc[^>]*>([^<]*)<\/desc>/);
      const title = tm ? decodeXml(tm[1]) : '';
      const description = dm ? decodeXml(dm[1]) : '';
      if (!epgByChannel[chId]) { epgByChannel[chId] = []; epgChannelSource[chId] = name; }
      epgByChannel[chId].push({ start, end, title, description });
      parsed++;
    }

    sourceStats[name] = { channels: ids.size, sizeMB: +(raw.length / 1024 / 1024).toFixed(2), parsedForOurs: parsed };
    console.log(`OK (${ids.size} ch, ${sourceStats[name].sizeMB}MB, parsed for ours: ${parsed})`);
  }

  // 3) Update channels: epgAvailable + lastEpgSyncAt
  console.log('\nUpdating channels: epgAvailable + lastEpgSyncAt...');
  let availableCount = 0, unavailableCount = 0;
  const channelUpdates = [];
  for (const doc of channelsSnap.docs) {
    const c = doc.data();
    const srcSet = available[c.epgSource];
    const isAvail = !!(srcSet && srcSet.has(c.epgId));
    channelUpdates.push({
      ref: doc.ref,
      data: { epgAvailable: isAvail, lastEpgSyncAt: now, epgUpdatedAt: now },
    });
    if (isAvail) availableCount++; else unavailableCount++;
  }
  const BATCH = 400;
  for (let i = 0; i < channelUpdates.length; i += BATCH) {
    const b = db.batch();
    for (const u of channelUpdates.slice(i, i + BATCH)) b.update(u.ref, u.data);
    await b.commit();
    console.log(`  committed ${Math.min(i + BATCH, channelUpdates.length)}/${channelUpdates.length}`);
  }

  // 4) Write global_epg/{epgId} docs
  console.log(`\nWriting global_epg docs...`);
  const epgWrites = [];
  for (const [epgId, programs] of Object.entries(epgByChannel)) {
    programs.sort((a, b) => a.start - b.start);
    // defensive truncation to keep docs < 1MB
    const capped = programs.length > 2000 ? programs.slice(0, 2000) : programs;
    epgWrites.push({
      ref: db.collection('global_epg').doc(epgId),
      data: {
        epgId,
        epgSource: epgChannelSource[epgId],
        programCount: capped.length,
        programs: capped,
        available: true,
        updatedAt: now,
      },
    });
  }
  for (let i = 0; i < epgWrites.length; i += BATCH) {
    const b = db.batch();
    for (const w of epgWrites.slice(i, i + BATCH)) b.set(w.ref, w.data);
    await b.commit();
    console.log(`  committed ${Math.min(i + BATCH, epgWrites.length)}/${epgWrites.length}`);
  }

  // 5) Update config
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
    epgDocsWritten: epgWrites.length,
  };
  await cfgRef.set(newCfg, { merge: true });

  // 6) Report
  console.log('\n=== SUMMARY ===');
  console.log(`Channels scanned:    ${channelsSnap.size}`);
  console.log(`  with EPG avail:    ${availableCount}`);
  console.log(`  missing in src:    ${unavailableCount}`);
  console.log(`EPG docs written:    ${epgWrites.length}`);
  const totalProgs = epgWrites.reduce((s, w) => s + w.data.programCount, 0);
  console.log(`Total programmes:    ${totalProgs}`);
  for (const [name, s] of Object.entries(sourceStats)) {
    console.log(`  [${name}] ${s.error ? 'FAILED' : s.channels + ' ch, ' + s.parsedForOurs + ' progs for ours'}`);
  }
  console.log('\nDone:', new Date().toISOString());
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
