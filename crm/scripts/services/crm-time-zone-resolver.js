import { US_AREA_CODE_TIME_ZONE_GROUPS } from '../data/us-area-code-time-zones.js';
import { extractAreaCode, normalizeWhitespace } from '../utils/formatters.js';

export const CRM_TIME_ZONE_OPTIONS = ['Eastern', 'Central', 'Mountain', 'Pacific', 'Alaska', 'Hawaii', 'Unknown'];

const AREA_CODE_TO_TIME_ZONE = buildAreaCodeTimeZoneMap(US_AREA_CODE_TIME_ZONE_GROUPS);
const TIME_ZONE_ALIASES = Object.freeze({
    est: 'Eastern',
    edt: 'Eastern',
    eastern: 'Eastern',
    et: 'Eastern',
    'america/new_york': 'Eastern',
    'america/detroit': 'Eastern',
    'america/indiana/indianapolis': 'Eastern',
    'america/kentucky/louisville': 'Eastern',
    'america/toronto': 'Eastern',
    'us/eastern': 'Eastern',
    cst: 'Central',
    cdt: 'Central',
    central: 'Central',
    ct: 'Central',
    'america/chicago': 'Central',
    'america/indiana/knox': 'Central',
    'america/menominee': 'Central',
    'america/north_dakota/beulah': 'Central',
    'america/north_dakota/center': 'Central',
    'america/north_dakota/new_salem': 'Central',
    'america/regina': 'Central',
    'america/winnipeg': 'Central',
    'us/central': 'Central',
    mst: 'Mountain',
    mdt: 'Mountain',
    mountain: 'Mountain',
    mt: 'Mountain',
    'america/boise': 'Mountain',
    'america/denver': 'Mountain',
    'america/edmonton': 'Mountain',
    'america/phoenix': 'Mountain',
    'us/mountain': 'Mountain',
    pst: 'Pacific',
    pdt: 'Pacific',
    pacific: 'Pacific',
    pt: 'Pacific',
    'america/los_angeles': 'Pacific',
    'america/vancouver': 'Pacific',
    'us/pacific': 'Pacific',
    alaska: 'Alaska',
    akst: 'Alaska',
    akdt: 'Alaska',
    'america/anchorage': 'Alaska',
    'america/juneau': 'Alaska',
    'america/nome': 'Alaska',
    'america/sitka': 'Alaska',
    'america/yakutat': 'Alaska',
    'us/alaska': 'Alaska',
    hawaii: 'Hawaii',
    hst: 'Hawaii',
    'pacific/honolulu': 'Hawaii',
    'us/hawaii': 'Hawaii',
    unknown: 'Unknown',
    ast: 'Unknown',
    adt: 'Unknown',
    atlantic: 'Unknown',
    'america/halifax': 'Unknown',
    'america/puerto_rico': 'Unknown'
});

export function normalizeTimeZoneLabel(value) {
    const normalized = normalizeWhitespace(value);

    if (!normalized) {
        return '';
    }

    const canonical = CRM_TIME_ZONE_OPTIONS.find((option) => option.toLowerCase() === normalized.toLowerCase());

    if (canonical) {
        return canonical;
    }

    return TIME_ZONE_ALIASES[normalized.toLowerCase()] || '';
}

export function normalizeTimeZoneDisplayLabel(value) {
    return normalizeTimeZoneLabel(value) || normalizeWhitespace(value);
}

export function inferTimeZoneFromPhone(phoneValue) {
    const areaCode = extractAreaCode(phoneValue);

    if (!areaCode) {
        return 'Unknown';
    }

    return AREA_CODE_TO_TIME_ZONE.get(areaCode) || 'Unknown';
}

export function resolveLeadTimeZone({ phone, storedTimeZone, timezoneOverridden = false } = {}) {
    const normalizedStoredTimeZone = normalizeTimeZoneLabel(storedTimeZone);
    const displayStoredTimeZone = normalizedStoredTimeZone || normalizeWhitespace(storedTimeZone);
    const autoTimeZone = inferTimeZoneFromPhone(phone);
    const resolvedTimeZone = timezoneOverridden === true
        ? (displayStoredTimeZone || autoTimeZone)
        : (autoTimeZone !== 'Unknown' ? autoTimeZone : (displayStoredTimeZone || autoTimeZone));

    return {
        timeZone: resolvedTimeZone,
        autoTimeZone,
        normalizedStoredTimeZone,
        timezoneOverridden: timezoneOverridden === true
    };
}

export function resolveTimeZoneFieldsForSave({
    requestedTimeZone,
    hasExplicitTimeZone = false,
    existingTimeZone = '',
    existingOverridden = false,
    phone
} = {}) {
    const autoTimeZone = inferTimeZoneFromPhone(phone);

    if (hasExplicitTimeZone) {
        const normalizedRequestedTimeZone = normalizeTimeZoneLabel(requestedTimeZone);

        return {
            timeZone: normalizedRequestedTimeZone || autoTimeZone,
            autoTimeZone,
            timezoneOverridden: Boolean(normalizedRequestedTimeZone)
        };
    }

    if (existingOverridden) {
        return {
            timeZone: normalizeTimeZoneDisplayLabel(existingTimeZone) || autoTimeZone,
            autoTimeZone,
            timezoneOverridden: true
        };
    }

    return {
        timeZone: autoTimeZone,
        autoTimeZone,
        timezoneOverridden: false
    };
}

function buildAreaCodeTimeZoneMap(groups) {
    return Object.entries(groups).reduce((map, [timeZone, areaCodes]) => {
        areaCodes.forEach((areaCode) => {
            map.set(areaCode, timeZone);
        });
        return map;
    }, new Map());
}
