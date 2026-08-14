import NodeGeocoder from "node-geocoder";
import { DateTime } from "luxon";
import { find as findTimezone } from "geo-tz";
import { Solar } from "lunar-typescript";
import { astro } from "iztro";

const geocoder = NodeGeocoder({
  provider: "openstreetmap",
  email: process.env.I_CHING_GEOCODER_EMAIL || "ops@postfiat.org",
  headers: {
    "user-agent": process.env.I_CHING_GEOCODER_USER_AGENT || "TaskNode/1.0 (contact: ops@postfiat.org)",
    referer: process.env.I_CHING_GEOCODER_REFERRER || "https://tasknode.postfiat.org",
  },
  formatter: null,
});

function inputError(message) {
  const error = new Error(message);
  error.code = "I_CHING_INPUT";
  error.status = 400;
  return error;
}

function normalizedGender(value = "") {
  const gender = String(value || "").trim().toLowerCase();
  if (gender === "male") return { label: "male", bazi: 1 };
  if (gender === "female") return { label: "female", bazi: 0 };
  throw inputError("Gender must be male or female for the chart calculation.");
}

function parseCoordinates(value = "") {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw inputError("Birth coordinates are outside the valid latitude/longitude range.");
  }
  return { latitude, longitude };
}

async function geocodeBirthLocation(location = "", { geocode = (value) => geocoder.geocode(value) } = {}) {
  const direct = parseCoordinates(location);
  if (direct) return direct;
  let results;
  try {
    results = await geocode(location);
  } catch {
    throw inputError("Birth location could not be resolved. Enter city and country, or latitude,longitude.");
  }
  const first = Array.isArray(results) ? results[0] : null;
  if (!first || !Number.isFinite(Number(first.latitude)) || !Number.isFinite(Number(first.longitude))) {
    throw inputError("Birth location could not be resolved. Enter city and country, or latitude,longitude.");
  }
  return { latitude: Number(first.latitude), longitude: Number(first.longitude) };
}

function equationOfTimeMinutes(dateTime) {
  const gamma = (2 * Math.PI / 365) * (dateTime.ordinal - 1 + (dateTime.hour + dateTime.minute / 60 - 12) / 24);
  return 229.18 * (
    0.000075 +
    0.001868 * Math.cos(gamma) -
    0.032077 * Math.sin(gamma) -
    0.014615 * Math.cos(2 * gamma) -
    0.040849 * Math.sin(2 * gamma)
  );
}

function trueSolarTime(localDateTime, longitude) {
  const winterOffset = localDateTime.set({ month: 1 }).offset;
  const dstMinutes = localDateTime.isInDST ? Math.max(0, localDateTime.offset - winterOffset) || 60 : 0;
  const standardOffsetMinutes = localDateTime.offset - dstMinutes;
  const standardMeridian = (standardOffsetMinutes / 60) * 15;
  const longitudeCorrection = (longitude - standardMeridian) * 4;
  const equationOfTime = equationOfTimeMinutes(localDateTime);
  const offsetMinutes = longitudeCorrection + equationOfTime - dstMinutes;
  return {
    dateTime: localDateTime.plus({ minutes: offsetMinutes }),
    offsetMinutes,
    longitudeCorrection,
    equationOfTime,
    dstMinutes,
    standardMeridian,
  };
}

function safeCall(target, method, ...args) {
  try {
    return typeof target?.[method] === "function" ? target[method](...args) : null;
  } catch {
    return null;
  }
}

function baziPayload(dateTime, gender) {
  const solar = Solar.fromYmdHms(dateTime.year, dateTime.month, dateTime.day, dateTime.hour, dateTime.minute, dateTime.second);
  const eightChar = solar.getLunar().getEightChar();
  const yun = safeCall(eightChar, "getYun", gender.bazi);
  const luckCycles = safeCall(yun, "getDaYun") || [];
  return {
    four_pillars: {
      year: safeCall(eightChar, "getYear"),
      month: safeCall(eightChar, "getMonth"),
      day: safeCall(eightChar, "getDay"),
      hour: safeCall(eightChar, "getTime"),
    },
    wuxing: {
      year: safeCall(eightChar, "getYearWuXing"),
      month: safeCall(eightChar, "getMonthWuXing"),
      day: safeCall(eightChar, "getDayWuXing"),
      hour: safeCall(eightChar, "getTimeWuXing"),
    },
    shishen_gan: {
      year: safeCall(eightChar, "getYearShiShenGan"),
      month: safeCall(eightChar, "getMonthShiShenGan"),
      day: safeCall(eightChar, "getDayShiShenGan"),
      hour: safeCall(eightChar, "getTimeShiShenGan"),
    },
    shishen_zhi: {
      year: safeCall(eightChar, "getYearShiShenZhi"),
      month: safeCall(eightChar, "getMonthShiShenZhi"),
      day: safeCall(eightChar, "getDayShiShenZhi"),
      hour: safeCall(eightChar, "getTimeShiShenZhi"),
    },
    day_master: safeCall(eightChar, "getDayGan"),
    raw: safeCall(eightChar, "toString"),
    luck_cycles: Array.isArray(luckCycles)
      ? luckCycles.map((cycle) => ({
          start_age: safeCall(cycle, "getStartAge"),
          end_age: safeCall(cycle, "getEndAge"),
          gan_zhi: safeCall(cycle, "getGanZhi"),
          raw: safeCall(cycle, "toString"),
        }))
      : [],
  };
}

function ziweiPayload(dateTime, gender) {
  const hourIndex = Math.floor(((dateTime.hour * 60 + dateTime.minute + 60) % 1440) / 120);
  const date = dateTime.toFormat("yyyy-MM-dd");
  return {
    input: { date, hour_index: hourIndex, gender: gender.label, language: "zh-CN" },
    chart: astro.bySolar(date, hourIndex, gender.label, true, "zh-CN"),
  };
}

export async function generateIChingProfile(
  { birthDate = "", birthTime = "", birthLocation = "", gender = "" } = {},
  { geocode } = {}
) {
  const normalizedDate = String(birthDate || "").trim();
  const normalizedTime = String(birthTime || "").trim();
  const normalizedLocation = String(birthLocation || "").trim().slice(0, 240);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) throw inputError("Birth date must use YYYY-MM-DD.");
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(normalizedTime)) throw inputError("Birth time must use 24-hour HH:MM.");
  if (!normalizedLocation) throw inputError("Birth location is required.");
  const genderValue = normalizedGender(gender);
  const coordinates = await geocodeBirthLocation(normalizedLocation, geocode ? { geocode } : undefined);
  const timezone = findTimezone(coordinates.latitude, coordinates.longitude)?.[0];
  if (!timezone) throw inputError("The timezone for that birth location could not be resolved.");
  const localDateTime = DateTime.fromISO(`${normalizedDate}T${normalizedTime}`, { zone: timezone });
  if (!localDateTime.isValid || localDateTime > DateTime.now()) throw inputError("Birth date or time is invalid.");

  const solar = trueSolarTime(localDateTime, coordinates.longitude);
  const bazi = baziPayload(solar.dateTime, genderValue);
  const ziwei = ziweiPayload(solar.dateTime, genderValue);
  const boundaryMinutes = Math.min((solar.dateTime.hour * 60 + solar.dateTime.minute) % 120, 120 - ((solar.dateTime.hour * 60 + solar.dateTime.minute) % 120));
  const input = {
    birth_date: normalizedDate,
    birth_time: normalizedTime,
    birth_location: normalizedLocation,
    gender: genderValue.label,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timezone,
    true_solar_time: solar.dateTime.toFormat("HH:mm:ss"),
    true_solar_offset_minutes: Math.round(solar.offsetMinutes),
    equation_of_time_minutes: Number(solar.equationOfTime.toFixed(2)),
    longitude_correction_minutes: Number(solar.longitudeCorrection.toFixed(2)),
    dst_minutes: solar.dstMinutes,
    standard_meridian: Number(solar.standardMeridian.toFixed(2)),
  };
  const warnings = boundaryMinutes <= 10
    ? ["True solar time is within 10 minutes of a two-hour boundary; the hour pillar may change if the recorded birth time is imprecise."]
    : [];
  return { input, bazi, ziwei, combined: { input, bazi, ziwei, warnings } };
}
