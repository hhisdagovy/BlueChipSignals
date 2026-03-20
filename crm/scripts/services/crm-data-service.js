import { IMPORT_FIELDS } from '../import/csv-utils.js';
import { resolveTimeZoneFieldsForSave } from './crm-time-zone-resolver.js';
import {
    buildFullName,
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
export { CRM_TIME_ZONE_OPTIONS } from './crm-time-zone-resolver.js';

const STATUSES = CRM_STATUS_OPTIONS;

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
            activityLog: Array.isArray(existingClient?.activityLog) ? [...existingClient.activityLog] : [],
            emailHistory: Array.isArray(existingClient?.emailHistory) ? [...existingClient.emailHistory] : []
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

    async searchClientSuggestions() {
        return [];
    }

    async backfillLeadTimeZones() {
        throw new Error('Lead time zone backfill is not available for this CRM data service.');
    }

    async sendEmail() {
        throw new Error('CRM email sending is not available for this CRM data service.');
    }

    async sendLeadEmail(payload = {}) {
        return this.sendEmail(payload);
    }

    async listEmailMailboxes() {
        return [];
    }

    async listEmailThreads() {
        return [];
    }

    async getEmailThread() {
        return null;
    }

    async syncEmailMailbox() {
        throw new Error('Email sync is not available for this CRM data service.');
    }

    async markEmailThreadRead() {
        return null;
    }

    async toggleEmailThreadStar() {
        return null;
    }

    async saveCallPreference() {
        throw new Error('Call preference saving is not available for this CRM data service.');
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

function resolveTimeZoneFields(payload, existingClient, phoneKey) {
    return resolveTimeZoneFieldsForSave({
        requestedTimeZone: payload?.timeZone,
        hasExplicitTimeZone: Object.prototype.hasOwnProperty.call(payload, 'timeZone'),
        existingTimeZone: existingClient?.timeZone,
        existingOverridden: existingClient?.timezoneOverridden === true,
        phone: phoneKey
    });
}
