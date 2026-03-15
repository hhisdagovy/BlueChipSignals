export function uid(prefix = 'crm') {
    return `${prefix}-${crypto.randomUUID()}`;
}

export function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeNotes(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .trim();
}

export function normalizeEmail(value) {
    return normalizeWhitespace(value).toLowerCase();
}

export function isLikelyEmail(value) {
    if (!value) {
        return true;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizePhone(value) {
    const digits = String(value ?? '').replace(/\D/g, '');

    if (digits.length === 11 && digits.startsWith('1')) {
        return digits.slice(1);
    }

    return digits;
}

export function formatPhone(value) {
    const digits = normalizePhone(value);

    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }

    if (digits.length === 11) {
        return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    }

    return normalizeWhitespace(value);
}

export function parseTags(value) {
    if (Array.isArray(value)) {
        return dedupeStrings(value);
    }

    return dedupeStrings(
        String(value ?? '')
            .split(/[,;|\n]+/)
            .map((item) => normalizeWhitespace(item))
            .filter(Boolean)
    );
}

export function parseMultiValueList(value) {
    if (Array.isArray(value)) {
        return dedupeStrings(value);
    }

    return dedupeStrings(
        String(value ?? '')
            .split(/[,\n]+/)
            .map((item) => normalizeWhitespace(item))
            .filter(Boolean)
    );
}

export function normalizeAreaCode(value) {
    const digits = String(value ?? '').replace(/\D/g, '');

    if (digits.length < 3) {
        return '';
    }

    return digits.slice(0, 3);
}

export function parseAreaCodes(value) {
    return dedupeStrings(
        String(value ?? '')
            .split(/[,\n]+/)
            .map((item) => normalizeAreaCode(item))
            .filter((item) => item.length === 3)
    );
}

export function dedupeStrings(values) {
    const seen = new Set();

    return values.reduce((result, value) => {
        const trimmed = normalizeWhitespace(value);
        const key = trimmed.toLowerCase();

        if (!trimmed || seen.has(key)) {
            return result;
        }

        seen.add(key);
        result.push(trimmed);
        return result;
    }, []);
}

export function buildFullName(firstName, lastName) {
    return [normalizeWhitespace(firstName), normalizeWhitespace(lastName)].filter(Boolean).join(' ').trim();
}

export function extractAreaCode(phoneValue) {
    const digits = normalizePhone(phoneValue);

    if (digits.length < 10) {
        return '';
    }

    return digits.slice(0, 3);
}

export function deriveNameParts(fullName) {
    const normalized = normalizeWhitespace(fullName);

    if (!normalized) {
        return { firstName: '', lastName: '' };
    }

    const parts = normalized.split(' ');
    return {
        firstName: parts[0] ?? '',
        lastName: parts.slice(1).join(' ')
    };
}

export function truncate(value, maxLength = 110) {
    const normalized = normalizeWhitespace(value);

    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatDateTime(value) {
    if (!value) {
        return 'Not available';
    }

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(value));
}

export function formatDate(value) {
    if (!value) {
        return 'Not available';
    }

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    }).format(new Date(value));
}

export function isToday(value) {
    if (!value) {
        return false;
    }

    const today = new Date();
    const target = new Date(value);

    return today.getFullYear() === target.getFullYear()
        && today.getMonth() === target.getMonth()
        && today.getDate() === target.getDate();
}

export function titleCase(value) {
    return String(value ?? '')
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function mergeNotes(existingNotes, incomingNotes) {
    const first = normalizeNotes(existingNotes);
    const second = normalizeNotes(incomingNotes);

    if (!first) {
        return second;
    }

    if (!second || first.toLowerCase() === second.toLowerCase()) {
        return first;
    }

    return `${first}\n\n${second}`;
}

export function downloadTextFile(filename, contents, mimeType = 'text/plain;charset=utf-8') {
    const blob = new Blob([contents], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

export function toCsv(rows, columns) {
    const headers = columns.map((column) => column.label);
    const keys = columns.map((column) => column.key);
    const lines = [headers.map(escapeCsvValue).join(',')];

    rows.forEach((row) => {
        lines.push(keys.map((key) => escapeCsvValue(row[key])).join(','));
    });

    return lines.join('\n');
}

function escapeCsvValue(value) {
    const normalized = Array.isArray(value) ? value.join(', ') : String(value ?? '');

    if (/[",\n]/.test(normalized)) {
        return `"${normalized.replace(/"/g, '""')}"`;
    }

    return normalized;
}
