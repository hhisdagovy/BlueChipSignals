# Blue Chip Signals

## Local CRM Prototype

The local-first CRM prototype lives at `crm/index.html` and is intentionally isolated from the public marketing site so it can be tested safely before any wider integration.

### Run locally

Start a static server from the repo root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/crm/
```

### What it uses

- Browser-local session storage for the mock CRM login
- IndexedDB for client records and import history
- A repository/service layer so the UI does not call IndexedDB directly

### Future backend swap

The CRM UI talks to `crm/scripts/services/crm-data-service.js`, which depends on repository implementations rather than browser storage APIs directly. To move this prototype to a real backend later:

1. Replace the IndexedDB repository classes with API-backed repositories that keep the same method signatures.
2. Keep the UI and `CrmDataService` orchestration layer in place.
3. Swap the local auth service for the production auth provider once `/crm` access rules are ready.

### Notes

- Public website pages are unchanged by the CRM prototype work.
- The CRM route is structured so it can later live at `/crm` in the main site.
