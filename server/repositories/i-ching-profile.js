import { databaseEnabled, query } from "../db/pool.js";

const runtimeProfiles = new Map();

function normalizedAccountId(accountId = "") {
  return String(accountId || "").trim().slice(0, 160);
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function profileFromRow(row = null) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    birthDate: String(row.birth_date || "").slice(0, 10),
    birthTime: row.birth_time,
    birthLocation: row.birth_location,
    gender: row.gender,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezone: row.timezone,
    trueSolarTime: row.true_solar_time,
    trueSolarOffsetMinutes: Number(row.true_solar_offset_minutes),
    bazi: row.bazi_json || {},
    ziwei: row.ziwei_json || {},
    combined: row.combined_json || {},
    chartVersion: Number(row.chart_version || 1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function getIChingProfile({ accountId = "" } = {}) {
  const id = normalizedAccountId(accountId);
  if (!id) return null;
  if (!databaseEnabled()) return runtimeProfiles.get(id) || null;
  const result = await query(
    `SELECT account_id, birth_date, birth_time, birth_location, gender,
            latitude, longitude, timezone, true_solar_time,
            true_solar_offset_minutes, bazi_json, ziwei_json, combined_json,
            chart_version, created_at, updated_at
       FROM i_ching_profiles
      WHERE account_id = $1`,
    [id]
  );
  return profileFromRow(result.rows[0] || null);
}

export async function upsertIChingProfile({ accountId = "", chart = null } = {}) {
  const id = normalizedAccountId(accountId);
  if (!id) throw new Error("i_ching_account_required");
  if (!chart?.input || !chart?.bazi || !chart?.ziwei || !chart?.combined) {
    throw new Error("i_ching_chart_invalid");
  }

  if (!databaseEnabled()) {
    const now = new Date().toISOString();
    const profile = {
      accountId: id,
      birthDate: chart.input.birth_date,
      birthTime: chart.input.birth_time,
      birthLocation: chart.input.birth_location,
      gender: chart.input.gender,
      latitude: chart.input.latitude,
      longitude: chart.input.longitude,
      timezone: chart.input.timezone,
      trueSolarTime: chart.input.true_solar_time,
      trueSolarOffsetMinutes: chart.input.true_solar_offset_minutes,
      bazi: chart.bazi,
      ziwei: chart.ziwei,
      combined: chart.combined,
      chartVersion: 1,
      createdAt: runtimeProfiles.get(id)?.createdAt || now,
      updatedAt: now,
    };
    runtimeProfiles.set(id, profile);
    return profile;
  }

  const input = chart.input;
  const result = await query(
    `INSERT INTO i_ching_profiles (
       account_id, birth_date, birth_time, birth_location, gender,
       latitude, longitude, timezone, true_solar_time,
       true_solar_offset_minutes, bazi_json, ziwei_json, combined_json,
       chart_version, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,now())
     ON CONFLICT (account_id) DO UPDATE SET
       birth_date = EXCLUDED.birth_date,
       birth_time = EXCLUDED.birth_time,
       birth_location = EXCLUDED.birth_location,
       gender = EXCLUDED.gender,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       timezone = EXCLUDED.timezone,
       true_solar_time = EXCLUDED.true_solar_time,
       true_solar_offset_minutes = EXCLUDED.true_solar_offset_minutes,
       bazi_json = EXCLUDED.bazi_json,
       ziwei_json = EXCLUDED.ziwei_json,
       combined_json = EXCLUDED.combined_json,
       chart_version = i_ching_profiles.chart_version + 1,
       updated_at = now()
     RETURNING account_id, birth_date, birth_time, birth_location, gender,
               latitude, longitude, timezone, true_solar_time,
               true_solar_offset_minutes, bazi_json, ziwei_json, combined_json,
               chart_version, created_at, updated_at`,
    [
      id,
      input.birth_date,
      input.birth_time,
      input.birth_location,
      input.gender,
      input.latitude,
      input.longitude,
      input.timezone,
      input.true_solar_time,
      input.true_solar_offset_minutes,
      chart.bazi,
      chart.ziwei,
      chart.combined,
    ]
  );
  return profileFromRow(result.rows[0]);
}

export function iChingProfilePromptPayload(profile = null) {
  if (!profile?.combined) return null;
  return {
    ...profile.combined,
    chart_metadata: {
      version: profile.chartVersion,
      updated_at: profile.updatedAt,
    },
  };
}
