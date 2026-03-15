export const PERMISSIONS = {
    CREATE_LEADS: 'create_leads',
    VIEW_ADMIN: 'view_admin',
    VIEW_ALL_RECORDS: 'view_all_records',
    IMPORT_LEADS: 'import_leads',
    EXPORT_LEADS: 'export_leads',
    MANAGE_SETTINGS: 'manage_settings',
    MANAGE_USERS: 'manage_users',
    MANAGE_TAGS: 'manage_tags',
    MANAGE_DISPOSITIONS: 'manage_dispositions',
    ASSIGN_LEADS: 'assign_leads',
    MOVE_TO_MEMBERS: 'move_to_members',
    DELETE_ANY_LEAD: 'delete_any_lead',
    MANAGE_SAVED_FILTERS_ANY: 'manage_saved_filters_any',
    EDIT_ADMIN_FIELDS: 'edit_admin_fields',
    EDIT_MEMBERS: 'edit_members',
    EDIT_ANY_NOTE: 'edit_any_note'
};

const ROLE_PERMISSIONS = {
    admin: new Set([
        PERMISSIONS.CREATE_LEADS,
        PERMISSIONS.VIEW_ADMIN,
        PERMISSIONS.VIEW_ALL_RECORDS,
        PERMISSIONS.IMPORT_LEADS,
        PERMISSIONS.EXPORT_LEADS,
        PERMISSIONS.MANAGE_SETTINGS,
        PERMISSIONS.MANAGE_USERS,
        PERMISSIONS.MANAGE_TAGS,
        PERMISSIONS.MANAGE_DISPOSITIONS,
        PERMISSIONS.ASSIGN_LEADS,
        PERMISSIONS.MOVE_TO_MEMBERS,
        PERMISSIONS.DELETE_ANY_LEAD,
        PERMISSIONS.MANAGE_SAVED_FILTERS_ANY,
        PERMISSIONS.EDIT_ADMIN_FIELDS,
        PERMISSIONS.EDIT_MEMBERS,
        PERMISSIONS.EDIT_ANY_NOTE
    ]),
    sales: new Set([
        PERMISSIONS.CREATE_LEADS
    ]),
    senior: new Set([
        PERMISSIONS.CREATE_LEADS
    ])
};

const DEFAULT_WORKFLOW_FIELDS = new Set([
    'status',
    'disposition',
    'followUpAction',
    'followUpAt',
    'tags'
]);

const SALES_EDIT_FIELDS = new Set([
    'firstName',
    'lastName',
    'email',
    'phone',
    'tags',
    'timeZone',
    'status',
    'disposition',
    'followUpAction',
    'followUpAt'
]);

export function isAdminSession(session) {
    return session?.role === 'admin';
}

export function isSeniorRepSession(session) {
    return session?.role === 'senior';
}

export function isSalesWorkspaceSession(session) {
    return session?.role === 'sales' || session?.role === 'senior';
}

export function hasPermission(session, permission) {
    if (!session) {
        return false;
    }

    return ROLE_PERMISSIONS[session.role]?.has(permission) ?? false;
}

export function canEditLeadField(session, fieldName, client = null, options = {}) {
    if (!session) {
        return false;
    }

    if (isAdminSession(session)) {
        return true;
    }

    if (!isSalesWorkspaceSession(session)) {
        return false;
    }

    if (client?.lifecycleType === 'member') {
        return false;
    }

    if (options.workflowOnly) {
        return DEFAULT_WORKFLOW_FIELDS.has(fieldName);
    }

    return SALES_EDIT_FIELDS.has(fieldName);
}

export function canEnterLeadEditMode(session, client) {
    if (!session || !client) {
        return false;
    }

    if (isAdminSession(session)) {
        return true;
    }

    return isSalesWorkspaceSession(session) && client.lifecycleType !== 'member';
}

export function canEditNoteEntry(session, client, noteEntry) {
    if (!session || !client || !noteEntry) {
        return false;
    }

    if (hasPermission(session, PERMISSIONS.EDIT_ANY_NOTE)) {
        return true;
    }

    if (!isSalesWorkspaceSession(session) || client.lifecycleType === 'member') {
        return false;
    }

    return noteEntry.createdByUserId === session.id;
}

export function canManageSavedFilter(session, filter) {
    if (!session || !filter) {
        return false;
    }

    return hasPermission(session, PERMISSIONS.MANAGE_SAVED_FILTERS_ANY) || filter.createdByUserId === session.id;
}

export function isLeadActionAllowed(session, actionName) {
    if (!session) {
        return false;
    }

    if (isAdminSession(session)) {
        return true;
    }

    const allowedSalesActions = new Set([
        'create',
        'view',
        'edit',
        'save',
        'save_filter',
        'load_filter'
    ]);

    return allowedSalesActions.has(actionName);
}
