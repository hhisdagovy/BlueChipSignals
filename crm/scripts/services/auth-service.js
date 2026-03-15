const SESSION_KEY = 'bluechip_crm_session_v1';
const USERS_KEY = 'bluechip_crm_users_v1';

export const CRM_TEST_USERS = [
    {
        id: 'crm-admin-1',
        name: 'Jordan Hale',
        email: 'admin@bluechipsignals.local',
        password: 'Admin!234',
        role: 'admin',
        title: 'Operations Admin',
        isActive: true
    },
    {
        id: 'crm-sales-1',
        name: 'Maya Brooks',
        email: 'sales@bluechipsignals.local',
        password: 'Sales!234',
        role: 'sales',
        title: 'Sales Lead',
        isSeniorRep: false,
        isActive: true
    },
    {
        id: 'crm-senior-1',
        name: 'Bill Carter',
        email: 'senior@bluechipsignals.local',
        password: 'Senior!234',
        role: 'senior',
        title: 'Senior Rep',
        isSeniorRep: true,
        isActive: true
    }
];

export class LocalAuthService {
    ensureUserStore() {
        try {
            const raw = localStorage.getItem(USERS_KEY);

            if (!raw) {
                localStorage.setItem(USERS_KEY, JSON.stringify(CRM_TEST_USERS));
                return CRM_TEST_USERS.map((user) => ({ ...user }));
            }

            const parsed = JSON.parse(raw);

            if (!Array.isArray(parsed) || !parsed.length) {
                localStorage.setItem(USERS_KEY, JSON.stringify(CRM_TEST_USERS));
                return CRM_TEST_USERS.map((user) => ({ ...user }));
            }

            const defaultsById = new Map(CRM_TEST_USERS.map((user) => [user.id, user]));
            const mergedUsers = parsed.map((user) => ({
                ...user,
                role: normalizeUserRole(user.role),
                isSeniorRep: user.role === 'senior' || user.isSeniorRep === true,
                isActive: user.isActive !== false
            }));

            CRM_TEST_USERS.forEach((defaultUser) => {
                if (!mergedUsers.some((user) => user.id === defaultUser.id)) {
                    mergedUsers.push({ ...defaultUser });
                }
            });

            const normalizedUsers = mergedUsers.map((user) => {
                const defaults = defaultsById.get(user.id);
                return {
                    ...defaults,
                    ...user,
                    role: normalizeUserRole(user.role ?? defaults?.role),
                    isSeniorRep: normalizeUserRole(user.role ?? defaults?.role) === 'senior' || user.isSeniorRep === true,
                    isActive: user.isActive !== false
                };
            });

            localStorage.setItem(USERS_KEY, JSON.stringify(normalizedUsers));
            return normalizedUsers;
        } catch (_error) {
            localStorage.setItem(USERS_KEY, JSON.stringify(CRM_TEST_USERS));
            return CRM_TEST_USERS.map((user) => ({ ...user }));
        }
    }

    listUsers() {
        return this.ensureUserStore()
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    getUserById(userId) {
        return this.listUsers().find((user) => user.id === userId) || null;
    }

    saveUser(payload) {
        const users = this.listUsers();
        const now = new Date().toISOString();
        const existing = payload.id ? users.find((user) => user.id === payload.id) : null;
        const nextUser = {
            id: existing?.id ?? `crm-user-${crypto.randomUUID()}`,
            name: String(payload.name ?? '').trim(),
            email: String(payload.email ?? '').trim().toLowerCase(),
            password: String(payload.password ?? existing?.password ?? '').trim(),
            role: normalizeUserRole(payload.role),
            title: String(payload.title ?? '').trim() || getDefaultTitle(payload.role),
            isSeniorRep: normalizeUserRole(payload.role) === 'senior',
            isActive: payload.isActive !== false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
        };

        if (!nextUser.name || !nextUser.email || !nextUser.password) {
            throw new Error('Name, email, and password are required for CRM users.');
        }

        const duplicate = users.find((user) => user.email === nextUser.email && user.id !== nextUser.id);

        if (duplicate) {
            throw new Error('A CRM user with that email already exists.');
        }

        const nextUsers = existing
            ? users.map((user) => (user.id === nextUser.id ? nextUser : user))
            : [...users, nextUser];

        localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
        return nextUser;
    }

    deleteUser(userId) {
        const users = this.listUsers();
        const nextUsers = users.filter((user) => user.id !== userId);
        localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    }

    updateSessionFromUser(userId) {
        const session = this.getSession();
        const user = this.getUserById(userId);

        if (!session || session.id !== userId) {
            return session;
        }

        if (!user || user.isActive === false) {
            localStorage.removeItem(SESSION_KEY);
            return null;
        }

        const nextSession = {
            ...session,
            name: user.name,
            email: user.email,
            role: user.role,
            title: user.title
        };

        localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
        return nextSession;
    }

    getSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_error) {
            return null;
        }
    }

    getTestUsers() {
        return this.listUsers().map((user) => ({ ...user }));
    }

    async login({ email, password }) {
        const match = this.listUsers().find((user) =>
            user.email.toLowerCase() === String(email ?? '').toLowerCase().trim()
            && user.password === String(password ?? '').trim()
        );

        if (!match) {
            throw new Error('Use one of the local CRM test accounts to continue.');
        }

        if (match.isActive === false) {
            throw new Error('That CRM account is currently inactive.');
        }

        const session = {
            id: match.id,
            email: match.email,
            name: match.name,
            role: match.role,
            title: match.title,
            loggedInAt: new Date().toISOString()
        };

        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        return session;
    }

    async quickLogin(userId) {
        const match = this.listUsers().find((user) => user.id === userId);

        if (!match) {
            throw new Error('That local test user is not available.');
        }

        return this.login({ email: match.email, password: match.password });
    }

    logout() {
        localStorage.removeItem(SESSION_KEY);
    }
}

function normalizeUserRole(role) {
    if (role === 'admin') {
        return 'admin';
    }

    if (role === 'senior') {
        return 'senior';
    }

    return 'sales';
}

function getDefaultTitle(role) {
    if (role === 'admin') {
        return 'Administrator';
    }

    if (role === 'senior') {
        return 'Senior Rep';
    }

    return 'Sales Rep';
}
