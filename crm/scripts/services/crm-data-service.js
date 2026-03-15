import { IMPORT_FIELDS } from '../import/csv-utils.js';
import {
    buildFullName,
    extractAreaCode,
    formatPhone,
    isLikelyEmail,
    normalizeEmail,
    normalizeNotes,
    normalizePhone,
    normalizeWhitespace,
    parseTags,
    toCsv,
    uid
} from '../utils/formatters.js';

export const CRM_STATUS_OPTIONS = ['new', 'contacted', 'qualified', 'won', 'inactive'];
export const CRM_TIME_ZONE_OPTIONS = ['Eastern', 'Central', 'Mountain', 'Pacific', 'Alaska', 'Hawaii', 'Unknown'];

const STATUSES = CRM_STATUS_OPTIONS;
const AREA_CODE_TIME_ZONES = {
    '206': 'Pacific',
    '212': 'Eastern',
    '213': 'Pacific',
    '214': 'Central',
    '303': 'Mountain',
    '305': 'Eastern',
    '310': 'Pacific',
    '312': 'Central',
    '323': 'Pacific',
    '404': 'Eastern',
    '415': 'Pacific',
    '503': 'Pacific',
    '516': 'Eastern',
    '551': 'Eastern',
    '602': 'Mountain',
    '617': 'Eastern',
    '646': 'Eastern',
    '713': 'Central',
    '718': 'Eastern',
    '732': 'Eastern',
    '808': 'Hawaii',
    '907': 'Alaska',
    '914': 'Eastern',
    '917': 'Eastern'
};

export class CrmDataService {
    exportClientsToCsv(clients) {
        return toCsv(clients.map((client) => ({
            id: client.id,
            externalContactId: client.externalContactId,
            firstName: client.firstName,
            lastName: client.lastName,
            fullName: client.fullName,
            email: client.email,
            phone: client.phone,
            businessName: client.businessName,
            tags: client.tags.join(', '),
            notes: client.notes,
            createdAt: client.createdAt,
            updatedAt: client.updatedAt,
            assignedTo: client.assignedTo,
            status: client.status,
            subscriptionType: client.subscriptionType,
            timeZone: client.timeZone,
            timezoneOverridden: client.timezoneOverridden,
            assignedRepId: client.assignedRepId,
            lifecycleType: client.lifecycleType,
            disposition: client.disposition,
            followUpAction: client.followUpAction,
            followUpAt: client.followUpAt,
            sourceCreatedRaw: client.sourceCreatedRaw,
            sourceLastActivityRaw: client.sourceLastActivityRaw
        })), [
            { key: 'id', label: 'ID' },
            { key: 'externalContactId', label: 'External Contact ID' },
            { key: 'firstName', label: 'First Name' },
            { key: 'lastName', label: 'Last Name' },
            { key: 'fullName', label: 'Full Name' },
            { key: 'email', label: 'Email' },
            { key: 'phone', label: 'Phone' },
            { key: 'businessName', label: 'Business Name' },
            { key: 'tags', label: 'Tags' },
            { key: 'notes', label: 'Notes' },
            { key: 'createdAt', label: 'Created At' },
            { key: 'updatedAt', label: 'Updated At' },
            { key: 'assignedTo', label: 'Assigned To' },
            { key: 'status', label: 'Status' },
            { key: 'subscriptionType', label: 'Subscription Type' },
            { key: 'timeZone', label: 'Time Zone' },
            { key: 'timezoneOverridden', label: 'Time Zone Overridden' },
            { key: 'assignedRepId', label: 'Assigned Rep ID' },
            { key: 'lifecycleType', label: 'Lifecycle Type' },
            { key: 'disposition', label: 'Disposition' },
            { key: 'followUpAction', label: 'Follow Up Action' },
            { key: 'followUpAt', label: 'Follow Up At' },
            { key: 'sourceCreatedRaw', label: 'Source Created Raw' },
            { key: 'sourceLastActivityRaw', label: 'Source Last Activity Raw' }
        ]);
    }

    normalizeManualClient(payload, existingClient, actor) {
        const now = new Date().toISOString();
        const firstName = normalizeWhitespace(payload.firstName);
        const lastName = normalizeWhitespace(payload.lastName);
        const derivedFullName = normalizeWhitespace(payload.fullName) || buildFullName(firstName, lastName);
        const email = normalizeEmail(payload.email);
        const phoneKey = normalizePhone(payload.phone);
        const emailValue = isLikelyEmail(email) ? email : '';
        const { timeZone, timezoneOverridden } = resolveTimeZoneFields(payload, existingClient, phoneKey);
        const clientId = resolveClientId(existingClient?.id, payload.id);
        const assignedRepId = normalizeWhitespace(payload.assignedRepId)
            || existingClient?.assignedRepId
            || (!existingClient ? (actor?.id || '') : '');
        const assignedTo = normalizeWhitespace(payload.assignedTo)
            || existingClient?.assignedTo
            || (assignedRepId && assignedRepId === actor?.id ? (actor?.name || 'CRM user') : '');
        const normalizedClient = {
            id: clientId,
            externalContactId: normalizeWhitespace(resolvePayloadField(payload, 'externalContactId', existingClient?.externalContactId)),
            firstName,
            lastName,
            fullName: derivedFullName || emailValue || formatPhone(phoneKey) || 'Unnamed lead',
            email: emailValue,
            emailKey: emailValue,
            phone: formatPhone(phoneKey) || normalizeWhitespace(payload.phone),
            phoneKey,
            businessName: normalizeWhitespace(resolvePayloadField(payload, 'businessName', existingClient?.businessName)),
            tags: parseTags(payload.tags),
            notes: normalizeNotes(payload.notes ?? existingClient?.notes),
            createdAt: existingClient?.createdAt ?? now,
            updatedAt: now,
            sourceCreatedRaw: normalizeWhitespace(resolvePayloadField(payload, 'sourceCreatedRaw', existingClient?.sourceCreatedRaw)),
            sourceLastActivityRaw: normalizeWhitespace(resolvePayloadField(payload, 'sourceLastActivityRaw', existingClient?.sourceLastActivityRaw)),
            assignedTo,
            assignedRepId,
            status: normalizeStatus(resolvePayloadField(payload, 'status', existingClient?.status)),
            subscriptionType: normalizeSubscriptionType(payload.subscriptionType),
            timeZone,
            timezoneOverridden,
            lifecycleType: normalizeLifecycleType(payload.lifecycleType || existingClient?.lifecycleType),
            disposition: normalizeWhitespace(resolvePayloadField(payload, 'disposition', existingClient?.disposition)),
            dispositionId: normalizeWhitespace(resolvePayloadField(payload, 'dispositionId', existingClient?.dispositionId)),
            followUpAction: normalizeWhitespace(resolvePayloadField(payload, 'followUpAction', existingClient?.followUpAction)),
            followUpAt: normalizeLeadDateTime(resolvePayloadField(payload, 'followUpAt', existingClient?.followUpAt)),
            noteHistory: Array.isArray(existingClient?.noteHistory) ? [...existingClient.noteHistory] : [],
            activityLog: Array.isArray(existingClient?.activityLog) ? [...existingClient.activityLog] : []
        };

        if (!existingClient && normalizedClient.notes) {
            normalizedClient.noteHistory = [{
                id: uid('note'),
                leadId: normalizedClient.id,
                content: normalizedClient.notes,
                createdAt: now,
                createdByUserId: actor?.id || '',
                createdByName: actor?.name || 'CRM user',
                versions: []
            }];
        }

        return normalizedClient;
    }
}

export function getImportFieldDefinitions() {
    return IMPORT_FIELDS;
}

function normalizeStatus(value) {
    const normalized = normalizeWhitespace(value).toLowerCase();

    if (!normalized) {
        return 'new';
    }

    if (STATUSES.includes(normalized)) {
        return normalized;
    }

    if (normalized.includes('qual')) {
        return 'qualified';
    }

    if (normalized.includes('contact')) {
        return 'contacted';
    }

    if (normalized.includes('inactive') || normalized.includes('lost')) {
        return 'inactive';
    }

    if (normalized.includes('won') || normalized.includes('member')) {
        return 'won';
    }

    return 'new';
}

function resolveClientId(existingId, payloadId) {
    return normalizeWhitespace(existingId || payloadId);
}

function normalizeSubscriptionType(value) {
    return normalizeWhitespace(value);
}

function normalizeTimeZone(value) {
    const normalized = normalizeWhitespace(value);
    const key = normalized.toLowerCase();

    if (!normalized) {
        return '';
    }

    const aliases = {
        est: 'Eastern',
        edt: 'Eastern',
        eastern: 'Eastern',
        'america/new_york': 'Eastern',
        cst: 'Central',
        cdt: 'Central',
        central: 'Central',
        'america/chicago': 'Central',
        mst: 'Mountain',
        mdt: 'Mountain',
        mountain: 'Mountain',
        'america/denver': 'Mountain',
        pst: 'Pacific',
        pdt: 'Pacific',
        pacific: 'Pacific',
        'america/los_angeles': 'Pacific',
        alaska: 'Alaska',
        akst: 'Alaska',
        'america/anchorage': 'Alaska',
        hawaii: 'Hawaii',
        hst: 'Hawaii',
        'pacific/honolulu': 'Hawaii',
        unknown: 'Unknown'
    };

    return aliases[key] || normalized;
}

function normalizeLifecycleType(value) {
    const normalized = normalizeWhitespace(value).toLowerCase();
    return normalized === 'member' ? 'member' : 'lead';
}

function resolvePayloadField(payload, key, fallback = '') {
    if (payload && Object.prototype.hasOwnProperty.call(payload, key)) {
        return payload[key];
    }

    return fallback;
}

function normalizeLeadDateTime(value) {
    const normalized = normalizeWhitespace(value);

    if (!normalized) {
        return '';
    }

    const date = new Date(normalized);

    if (Number.isNaN(date.getTime())) {
        throw new Error('Choose a valid follow up date and time.');
    }

    return date.toISOString();
}

function inferTimeZone(phoneValue) {
    const areaCode = extractAreaCode(phoneValue);
    return AREA_CODE_TIME_ZONES[areaCode] ?? 'Unknown';
}

function resolveTimeZoneFields(payload, existingClient, phoneKey) {
    const autoTimeZone = inferTimeZone(phoneKey);
    const existingPhoneKey = normalizePhone(existingClient?.phoneKey || existingClient?.phone);
    const phoneChanged = Boolean(existingClient) && existingPhoneKey !== phoneKey;
    const explicitTimeZone = Object.prototype.hasOwnProperty.call(payload, 'timeZone')
        ? normalizeTimeZone(payload.timeZone)
        : null;
    const existingTimeZone = normalizeTimeZone(existingClient?.timeZone);
    const existingOverridden = existingClient?.timezoneOverridden === true;

    if (explicitTimeZone !== null) {
        return {
            timeZone: explicitTimeZone || autoTimeZone,
            timezoneOverridden: Boolean(explicitTimeZone)
        };
    }

    if (existingOverridden) {
        return {
            timeZone: existingTimeZone || autoTimeZone,
            timezoneOverridden: true
        };
    }

    return {
        timeZone: (!phoneChanged && existingTimeZone) ? existingTimeZone : autoTimeZone,
        timezoneOverridden: false
    };
}
