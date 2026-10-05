'use strict';

const { getPool, sql } = require('../config/db');
const deviceManager = require('./adamDeviceManager');
const logger      = require('../utils/logger');

const DEFAULT_STATION = 'STN-01';

// Lights are assigned per pick GROUP — Customer + Sales Order + Ship-To, i.e. (CardCode, DocEntry)
// since DocEntry implies ShipToCode. The same customer with several deliveries in one picklist
// gets one channel per delivery, matching the per-group cards on the picking board.
// (Keying by CardCode alone meant every delivery of a party shared a single light.)
const groupKey = (cardCode, docEntry) => `${cardCode}|${docEntry}`;

// In-memory session→group mapping cache
// Map<sessionId, { [cardCode|docEntry]: { channel, partyNum } }>
const _cache = new Map();

// ─── Idempotent schema evolution: per-group light rows ─────────────────────────
// Adds DocEntry and widens the uniqueness from (SessionID, CardCode) to
// (SessionID, CardCode, DocEntry). Separate batches so the new column is
// visible to the CREATE INDEX that references it.
let _schemaEnsured = false;
async function _ensureSchema(pool) {
  if (_schemaEnsured) return;
  await pool.request().query(`
    IF OBJECT_ID('GTP_StationLightStatus') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_StationLightStatus') AND name = 'DocEntry')
        ALTER TABLE GTP_StationLightStatus ADD DocEntry INT NULL;
  `);
  await pool.request().query(`
    IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_StationLight' AND parent_object_id = OBJECT_ID('GTP_StationLightStatus'))
        ALTER TABLE GTP_StationLightStatus DROP CONSTRAINT UQ_StationLight;
  `);
  await pool.request().query(`
    IF OBJECT_ID('GTP_StationLightStatus') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_StationLight_Group' AND object_id = OBJECT_ID('GTP_StationLightStatus'))
        CREATE UNIQUE INDEX UQ_StationLight_Group ON GTP_StationLightStatus (SessionID, CardCode, DocEntry);
  `);
  _schemaEnsured = true;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function _loadMapping(sessionId) {
  if (_cache.has(sessionId)) return _cache.get(sessionId);

  const pool = await getPool();
  await _ensureSchema(pool);
  const res  = await pool.request()
    .input('sid', sql.Int, sessionId)
    .query(`SELECT CardCode, DocEntry, Channel, PartyId FROM GTP_StationLightStatus
            WHERE SessionID=@sid AND DocEntry IS NOT NULL`);

  const m = {};
  for (const r of res.recordset) m[groupKey(r.CardCode, r.DocEntry)] = { channel: r.Channel, partyNum: r.PartyId };
  _cache.set(sessionId, m);
  return m;
}

async function _upsertMappingRow(pool, { sessionId, stationId, headerId, cardCode, docEntry, partyNum, channel }) {
  await pool.request()
    .input('sid', sql.Int,          sessionId)
    .input('sta', sql.NVarChar(50), stationId)
    .input('hid', sql.NVarChar(50), headerId)
    .input('cc',  sql.NVarChar(50), cardCode)
    .input('de',  sql.Int,          docEntry)
    .input('pn',  sql.Int,          partyNum)
    .input('ch',  sql.Int,          channel)
    .input('cn',  sql.NVarChar(10), `D${channel}`)
    .query(`
      MERGE GTP_StationLightStatus AS T
      USING (SELECT @sid AS SessionID, @cc AS CardCode, @de AS DocEntry) AS S
        ON  T.SessionID = S.SessionID AND T.CardCode = S.CardCode AND T.DocEntry = S.DocEntry
      WHEN MATCHED THEN
        UPDATE SET PartyId=@pn, Channel=@ch, ChannelName=@cn, Status='OFF', UpdatedTime=GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (SessionID, StationId, PicklistId, CardCode, DocEntry, PartyId, Channel, ChannelName, Status)
        VALUES (@sid, @sta, @hid, @cc, @de, @pn, @ch, @cn, 'OFF');
    `);
}

/**
 * Rebuild mapping for sessions that predate per-group light tracking (or light tracking at all).
 * Reads distinct (CardCode, DocEntry) groups from GTP_PickProgress in the same order the
 * picking board lists them (customer arrival order, then DocEntry), replaces any legacy
 * per-party rows, and updates the cache.
 */
async function _rebuildMapping(sessionId) {
  try {
    const pool = await getPool();
    await _ensureSchema(pool);

    const sesRes = await pool.request()
      .input('sid', sql.Int, sessionId)
      .query(`SELECT TOP 1 HeaderId, StationId FROM GTP_PicklistSessions WHERE SessionID=@sid`);
    const headerId  = sesRes.recordset[0]?.HeaderId || '';
    const stationId = sesRes.recordset[0]?.StationId || DEFAULT_STATION;
    const channels  = deviceManager.getChannels(stationId);
    if (!channels) {
      logger.error(`[LIGHTS] _rebuildMapping: no active ADAM device configured for station=${stationId} — cannot rebuild mapping`);
      return;
    }

    // ProgressID is an IDENTITY seeded in picklist row order, so MIN(ProgressID) per
    // CardCode reproduces the customer arrival order; DocEntry then orders that
    // customer's groups the same way getSession() sorts party.orders.
    const groupRes = await pool.request()
      .input('sid', sql.Int, sessionId)
      .query(`SELECT P.CardCode, P.DocEntry
              FROM GTP_PickProgress P
              INNER JOIN (SELECT CardCode, MIN(ProgressID) AS FirstSeq
                          FROM GTP_PickProgress WHERE SessionID=@sid GROUP BY CardCode) F
                      ON F.CardCode = P.CardCode
              WHERE P.SessionID=@sid
              GROUP BY P.CardCode, P.DocEntry, F.FirstSeq
              ORDER BY F.FirstSeq, P.DocEntry`);
    const groups = groupRes.recordset;

    // Drop legacy per-party rows (no DocEntry) — they'd otherwise hold stale channel state.
    await pool.request()
      .input('sid', sql.Int, sessionId)
      .query(`DELETE FROM GTP_StationLightStatus WHERE SessionID=@sid AND DocEntry IS NULL`);

    const mapping = {};
    for (let i = 0; i < Math.min(groups.length, channels.length); i++) {
      const { CardCode: cardCode, DocEntry: docEntry } = groups[i];
      const channel  = channels[i];
      const partyNum = i + 1;
      mapping[groupKey(cardCode, docEntry)] = { channel, partyNum };
      await _upsertMappingRow(pool, { sessionId, stationId, headerId, cardCode, docEntry, partyNum, channel });
    }
    _cache.set(sessionId, mapping);
    logger.info(`[LIGHTS] Rebuilt mapping for session=${sessionId}: ${Object.entries(mapping).map(([k, v]) => `${k}→D${v.channel}`).join(', ')}`);
  } catch (err) {
    logger.error(`[LIGHTS] _rebuildMapping error: ${err.message}`);
  }
}

async function _getStationId(sessionId) {
  const pool = await getPool();
  const res  = await pool.request()
    .input('sid', sql.Int, sessionId)
    .query(`SELECT TOP 1 StationId FROM GTP_StationLightStatus WHERE SessionID=@sid`);
  return res.recordset[0]?.StationId || DEFAULT_STATION;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * activatePicklistLights(sessionId, stationId, headerId, groups)
 *
 * Called at session start. `groups` = [{ cardCode, docEntry }] in picking-board order.
 * - Resets ALL station channels to OFF
 * - Stores group→channel mapping in DB (all Status='OFF')
 * - Does NOT turn any light ON — lights activate on first scan via setActiveGroupLight()
 */
async function activatePicklistLights(sessionId, stationId, headerId, groups) {
  // Throws ADAM_CONFIG_MISSING / ADAM_DEVICE_INACTIVE / ADAM_MAC_MISMATCH / ADAM_DEVICE_INIT_FAILED —
  // caller (gtpPickingService.startSession) lets these fail the session start outright;
  // every other error is logged and swallowed.
  const { device, channels } = await deviceManager.assertUsable(stationId);

  const pool    = await getPool();
  await _ensureSchema(pool);
  const mapping = {};

  logger.info(`[LIGHTS] Init session=${sessionId} station=${stationId} groups=${groups.length} — using ip=${device.ip}:${device.port} outputSeries=D${channels[0]}-D${channels[channels.length - 1]} — all OFF`);
  if (groups.length > channels.length) {
    logger.warn(`[LIGHTS] session=${sessionId} has ${groups.length} groups but only ${channels.length} channels — the extra groups get no light`);
  }

  // Reset all station channels to OFF — one atomic FC15 write
  device.writeAllOutputs(0)
    .then(()  => logger.info('[LIGHTS] All outputs reset to OFF (session start)'))
    .catch(e  => logger.error(`[LIGHTS] Reset all-OFF failed: ${e.message}`));

  // Store group→channel mapping in DB (Status='OFF' — lights activate on first scan)
  for (let i = 0; i < Math.min(groups.length, channels.length); i++) {
    const { cardCode, docEntry } = groups[i];
    const channel  = channels[i];
    const partyNum = i + 1;
    mapping[groupKey(cardCode, docEntry)] = { channel, partyNum };
    await _upsertMappingRow(pool, { sessionId, stationId, headerId, cardCode, docEntry, partyNum, channel });
  }

  _cache.set(sessionId, mapping);
}

/**
 * setActiveGroupLight(sessionId, cardCode, docEntry)
 *
 * Called on every item scan (when the group is still active) and when the operator
 * switches group on the picking board.
 * Spotlight model — at most 2 sequential FC05 writes per call:
 *   1. Turn OFF the previously-active channel (if different from new)
 *   2. Turn ON the new group's channel
 * Does NOT blast all channels every scan.
 */
async function setActiveGroupLight(sessionId, cardCode, docEntry, _retried = false) {
  const pool    = await getPool();
  const mapping = await _loadMapping(sessionId);
  const key     = groupKey(cardCode, docEntry);
  const info    = mapping[key];

  if (!info) {
    if (_retried) {
      logger.error(`[LIGHTS] No channel for group=${key} session=${sessionId} — more groups than configured channels?`);
      return;
    }
    // Mapping missing — this session may have started before per-group light tracking.
    // Rebuild from GTP_PickProgress so the first scan always works.
    logger.warn(`[LIGHTS] No mapping for group=${key} session=${sessionId} — rebuilding`);
    _cache.delete(sessionId);
    await _rebuildMapping(sessionId);
    return setActiveGroupLight(sessionId, cardCode, docEntry, true);   // retry once
  }

  const stationId = await _getStationId(sessionId);
  const entry      = deviceManager.getDevice(stationId);

  if (!entry || entry.macStatus === 'mismatch') {
    logger.error(`[LIGHTS] Skipping hardware write — station=${stationId} ${entry ? 'MAC mismatch' : 'no device configured'}`);
  } else {
    const device = entry.device;

    // Find the channel currently recorded as ON in DB for this session
    const curRes = await pool.request()
      .input('sid', sql.Int, sessionId)
      .query(`SELECT TOP 1 CardCode, DocEntry, Channel FROM GTP_StationLightStatus
              WHERE SessionID=@sid AND Status='ON'`);
    const currentOn = curRes.recordset[0] || null;

    logger.info(`[LIGHTS] Spotlight: prevDB=D${currentOn?.Channel ?? 'none'} → target=D${info.channel} (${key})`);

    // ── Step 1: Turn OFF the previously active channel if it differs ─────────
    if (currentOn !== null && currentOn.Channel !== info.channel) {
      try {
        await device.writeSingleOutput(currentOn.Channel, false);
        logger.info(`[LIGHTS] D${currentOn.Channel} (prev ${currentOn.CardCode}|${currentOn.DocEntry}) → OFF`);
      } catch (e) {
        logger.error(`[LIGHTS] D${currentOn.Channel} OFF failed: ${e.message}`);
      }
    }

    // ── Step 2: Always write the target channel ON regardless of DB state ─────
    // Hardware may be out of sync with DB (server restart resets ADAM to all-OFF)
    try {
      await device.writeSingleOutput(info.channel, true);
      logger.info(`[LIGHTS] D${info.channel} Group${info.partyNum} (${key}) → ON ✓`);
    } catch (e) {
      logger.error(`[LIGHTS] D${info.channel} ON FAILED: ${e.message}`);
    }
  }

  // ── Update DB ─────────────────────────────────────────────────────────────
  await pool.request()
    .input('sid', sql.Int, sessionId)
    .query(`UPDATE GTP_StationLightStatus SET Status='OFF', UpdatedTime=GETDATE()
            WHERE SessionID=@sid`);
  await pool.request()
    .input('sid', sql.Int,          sessionId)
    .input('cc',  sql.NVarChar(50), cardCode)
    .input('de',  sql.Int,          docEntry)
    .query(`UPDATE GTP_StationLightStatus SET Status='ON', UpdatedTime=GETDATE()
            WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de`);
}

/**
 * handleGroupComplete(sessionId, cardCode, docEntry)
 *
 * Called when ALL items in a group (Customer + Sales Order + Ship-To) are done.
 * Turns OFF that group's channel. Other channels already OFF (spotlight model).
 */
async function handleGroupComplete(sessionId, cardCode, docEntry) {
  const pool    = await getPool();
  const mapping = await _loadMapping(sessionId);
  const key     = groupKey(cardCode, docEntry);
  const info    = mapping[key];

  if (!info) {
    logger.warn(`[LIGHTS] No mapping group=${key} session=${sessionId}`);
    return;
  }

  const stationId = await _getStationId(sessionId);
  const entry      = deviceManager.getDevice(stationId);

  if (!entry || entry.macStatus === 'mismatch') {
    logger.error(`[LIGHTS] Skipping hardware write — station=${stationId} ${entry ? 'MAC mismatch' : 'no device configured'}`);
  } else {
    entry.device.writeSingleOutput(info.channel, false)
      .then(()  => logger.info(`[LIGHTS] D${info.channel} Group${info.partyNum} (${key}) → OFF (done)`))
      .catch(e  => logger.error(`[LIGHTS] D${info.channel} OFF failed: ${e.message}`));
  }

  await pool.request()
    .input('sid', sql.Int,          sessionId)
    .input('cc',  sql.NVarChar(50), cardCode)
    .input('de',  sql.Int,          docEntry)
    .query(`UPDATE GTP_StationLightStatus
            SET Status='OFF', UpdatedTime=GETDATE()
            WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de`);
}

/**
 * resetStationLights(sessionId)
 * Called when the entire picklist is completed — all channels OFF.
 */
async function resetStationLights(sessionId) {
  const pool      = await getPool();
  const stationId = await _getStationId(sessionId);
  const entry      = deviceManager.getDevice(stationId);

  // One atomic FC15 write — all channels OFF
  if (!entry || entry.macStatus === 'mismatch') {
    logger.error(`[LIGHTS] Skipping hardware reset — station=${stationId} ${entry ? 'MAC mismatch' : 'no device configured'}`);
  } else {
    entry.device.writeAllOutputs(0)
      .then(()  => logger.info(`[LIGHTS] All outputs OFF (picklist done, station=${stationId})`))
      .catch(e  => logger.error(`[LIGHTS] Reset all-OFF failed: ${e.message}`));
  }

  await pool.request()
    .input('sid', sql.Int, sessionId)
    .query(`UPDATE GTP_StationLightStatus
            SET Status='OFF', UpdatedTime=GETDATE()
            WHERE SessionID=@sid`);

  _cache.delete(sessionId);
}

/**
 * resetAllLightStates()
 *
 * Call on server startup to sync DB with hardware.
 * ADAM-6052 always starts with all outputs OFF after a power cycle or TCP reconnect.
 * Any stale 'ON' rows in the DB would cause setActiveGroupLight to short-circuit
 * and never write to ADAM (thinking the channel is already ON).
 */
async function resetAllLightStates() {
  try {
    const pool = await getPool();
    await _ensureSchema(pool);
    const res = await pool.request()
      .query(`UPDATE GTP_StationLightStatus SET Status='OFF', UpdatedTime=GETDATE()
              WHERE Status='ON'`);
    if (res.rowsAffected[0] > 0) {
      logger.info(`[LIGHTS] Startup reset: ${res.rowsAffected[0]} stale ON row(s) → OFF (DB synced with ADAM hardware)`);
    }
    _cache.clear();
  } catch (err) {
    logger.error(`[LIGHTS] resetAllLightStates error: ${err.message}`);
  }
}

module.exports = {
  activatePicklistLights,
  setActiveGroupLight,
  handleGroupComplete,
  resetStationLights,
  resetAllLightStates,
};
