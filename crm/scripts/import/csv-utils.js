import { normalizeWhitespace } from '../utils/formatters.js';

export const IMPORT_FIELDS = [
    { key: 'fullName', label: 'Full name', hint: 'Maps a single name column when first and last names are combined.' },
    { key: 'firstName', label: 'First name', hint: 'Preferred when the CSV has dedicated first-name values.' },
    { key: 'lastName', label: 'Last name', hint: 'Preferred when the CSV has dedicated last-name values.' },
    { key: 'email', label: 'Email', hint: 'Used for contact display and duplicate checks.' },
    { key: 'phone', label: 'Phone', hint: 'Normalized for display and duplicate checks.' },
    { key: 'tags', label: 'Tags', hint: 'Comma, semicolon, pipe, or newline separated tags.' },
    { key: 'notes', label: 'Notes', hint: 'Imported as plain text notes.' },
    { key: 'subscriptionType', label: 'Subscription type', hint: 'Optional subscription or plan label.' },
    { key: 'timeZone', label: 'Time zone', hint: 'Optional time zone such as EST or America/New_York.' },
    { key: 'status', label: 'Status', hint: 'Optional lifecycle status such as new or qualified.' },
    { key: 'assignedTo', label: 'Assigned to', hint: 'Optional internal owner or rep.' },
    { key: 'assignedRepId', label: 'Assigned rep ID', hint: 'Optional local rep identifier for assignment imports.' },
    { key: 'lifecycleType', label: 'Lifecycle type', hint: 'Optional lead or member lifecycle label.' },
    { key: 'disposition', label: 'Disposition', hint: 'Optional sales disposition text.' },
    { key: 'followUpAction', label: 'Follow up action', hint: 'Optional next-step action for reps.' },
    { key: 'followUpAt', label: 'Follow up at', hint: 'Optional follow-up date/time value.' }
];

const HEADER_ALIASES = {
    fullName: ['fullname', 'full name', 'name', 'contactname', 'contact name'],
    firstName: ['firstname', 'first name', 'fname', 'givenname', 'given name'],
    lastName: ['lastname', 'last name', 'lname', 'surname', 'familyname', 'family name'],
    email: ['email', 'emailaddress', 'email address', 'e-mail', 'mail'],
    phone: ['phone', 'phonenumber', 'phone number', 'mobile', 'cell', 'cellphone', 'cell phone', 'telephone', 'tel'],
    tags: ['tags', 'tag', 'labels', 'segments', 'categories', 'category'],
    notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'remark', 'description'],
    subscriptionType: ['subscriptiontype', 'subscription type', 'subscription', 'plan', 'planname', 'plan name', 'membership', 'tier'],
    timeZone: ['timezone', 'time zone', 'tz', 'time_zone'],
    status: ['status', 'stage', 'pipeline', 'lifecycle', 'leadstatus', 'lead status'],
    assignedTo: ['assignedto', 'assigned to', 'owner', 'rep', 'salesrep', 'sales rep', 'accountowner', 'account owner'],
    assignedRepId: ['assignedrepid', 'assigned rep id', 'repid', 'rep id', 'ownerid', 'owner id'],
    lifecycleType: ['lifecycletype', 'lifecycle type', 'memberstatus', 'member status', 'recordtype', 'record type'],
    disposition: ['disposition', 'lead disposition', 'call outcome', 'outcome'],
    followUpAction: ['followupaction', 'follow up action', 'next action', 'follow up', 'follow-up action'],
    followUpAt: ['followupat', 'follow up at', 'follow-up at', 'follow up date', 'next contact at']
};

export function parseCsvText(text) {
    const delimiter = detectDelimiter(text);
    const rows = [];
    let currentRow = [];
    let currentValue = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                currentValue += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }

            continue;
        }

        if (!inQuotes && char === delimiter) {
            currentRow.push(currentValue);
            currentValue = '';
            continue;
        }

        if (!inQuotes && (char === '\n' || char === '\r')) {
            if (char === '\r' && next === '\n') {
                index += 1;
            }

            currentRow.push(currentValue);
            rows.push(currentRow);
            currentRow = [];
            currentValue = '';
            continue;
        }

        currentValue += char;
    }

    if (currentValue.length || currentRow.length) {
        currentRow.push(currentValue);
        rows.push(currentRow);
    }

    const normalizedRows = rows
        .map((row) => row.map((value) => normalizeWhitespace(value)))
        .filter((row) => row.some((value) => value.length));

    if (!normalizedRows.length) {
        return { delimiter, headers: [], rows: [] };
    }

    const headers = normalizedRows[0].map((header, index) => header || `Column ${index + 1}`);
    const records = normalizedRows.slice(1).map((row) => headers.reduce((record, header, index) => {
        record[header] = row[index] ?? '';
        return record;
    }, {}));

    return {
        delimiter,
        headers,
        rows: records
    };
}

export function buildAutoMapping(headers) {
    const headerRecords = headers.map((header) => ({
        original: header,
        normalized: normalizeHeader(header)
    }));

    const mapping = {};
    const ambiguousFields = [];

    IMPORT_FIELDS.forEach((field) => {
        const aliases = HEADER_ALIASES[field.key] ?? [];
        const matches = headerRecords.filter((header) => aliases.includes(header.normalized));

        if (matches.length > 1) {
            ambiguousFields.push(field.key);
        }

        mapping[field.key] = matches[0]?.original ?? '';
    });

    return {
        mapping,
        ambiguousFields
    };
}

export function normalizeHeader(value) {
    return normalizeWhitespace(value)
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function detectDelimiter(text) {
    const sampleLines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6);

    const delimiters = [',', ';', '\t'];
    const scores = new Map(delimiters.map((delimiter) => [delimiter, 0]));

    sampleLines.forEach((line) => {
        delimiters.forEach((delimiter) => {
            scores.set(delimiter, scores.get(delimiter) + countDelimitedFields(line, delimiter));
        });
    });

    return [...scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ',';
}

function countDelimitedFields(line, delimiter) {
    let inQuotes = false;
    let count = 1;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const next = line[index + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (!inQuotes && char === delimiter) {
            count += 1;
        }
    }

    return count;
}
