## Context

See `proposal.md` for the motivation and user-facing scope. The repository is currently a planning-only workspace. The implementation will be a solo, deadline-driven monorepo with a React + Vite PWA frontend and FastAPI + WebSocket backend. The demo will be served from two free platforms — the PWA on Vercel and the FastAPI/WebSocket backend on Render — and must be usable from an Android browser. Transit integrations are not available yet, so the foundation must keep simulated data behind a replaceable boundary.

The supplied Beranda wireframe is a portrait mobile screen with a dark background, greeting, halte/rute search, a nearest-route delay status card, four feature tiles, and bottom navigation for Beranda, Keterlambatan, and Profil. It does not show a map on Beranda; map/routing belongs to the journey change.

## Goals / Non-Goals

**Goals:**

- Provide a documented two-origin demo access path (PWA on Vercel, backend on Render) that works from an Android browser without requiring a separate local service.
- Keep the transit data contract independent from the simulated source.
- Provide a small persistence boundary with a reusable 7-day cleanup policy.
- Make the Beranda wireframe and navigation usable before downstream features are implemented.
- Leave clear seams for the transcription and journey changes without prematurely implementing them.

**Non-Goals:**

- No real TransJakarta API, production authentication, or production-grade multi-user tenancy.
- No real user geolocation for the Beranda nearest-route card; use a deterministic demo context until a later change explicitly introduces geolocation.
- No interactive map on Beranda and no real route geometry in this foundation change.
- No production observability, autoscaling, or CI pipeline in this iteration.

## Decisions

### One monorepo with a split free deployment

Keep frontend and backend as separate concerns in one repository, but deploy them as two free services: the built React + Vite PWA on Vercel, and the FastAPI + WebSocket backend on Render's free tier. This gives native long-lived WebSocket support (Render) while keeping the PWA hosting that Vercel provides best. The frontend must use a documented backend URL and CORS/WebSocket origin handling because the two services live on different origins.

**Why not Vercel-only:** Vercel now supports FastAPI WebSockets natively, but on the free Hobby plan every connection is hard-terminated at 300 seconds (5 minutes) and the feature is still Public Beta. For a demo that may run longer than 5 minutes, that is a reliability risk. Render's free tier keeps WebSocket connections alive while traffic flows and has no per-connection duration cap.

**Alternative considered:** Vercel-only with reconnect logic. Rejected because 5-minute forced disconnects plus beta risk add failure modes to a recorded demo for no user-visible benefit. **Alternative considered:** Render all-in-one (static PWA + FastAPI). Rejected because the user's prior deployment choice favors Vercel for the PWA, and the split adds only CORS configuration.

### Shared source boundary for transit data

Define transit entities and update events at the boundary consumed by the application. The initial implementation uses deterministic seed/simulation data; a future official source can adapt to the same contract. Stable IDs and timestamps are required so tracking, notifications, and Antar Aku do not invent incompatible records.

**Alternative considered:** feature-specific JSON fixtures. Rejected because three downstream features would duplicate route, vehicle, and incident semantics.

### SQLite persistence with centralized cleanup

Use SQLite as the local persistent store for demo records. Retain a common creation timestamp and explicit exemption marker where supported. Cleanup runs from one application lifecycle path rather than from individual features, so transcript and incident history share the same seven-day rule.

**Alternative considered:** in-memory state. Rejected because it cannot demonstrate history across sessions or satisfy the seven-day retention behavior.

### Deterministic mock context for nearest-route status

The Beranda status card SHALL use a documented seeded user context and nearest route, not browser geolocation. This keeps the first demo deterministic and avoids permission prompts. Real geolocation is a later upgrade, not part of this change.

**Alternative considered:** use Geolocation API immediately. Rejected because it introduces Android permission, GPS variability, and a new privacy surface into the foundation.

### Visual-first mobile baseline

Use the supplied wireframe as the structural source of truth: portrait layout, vertical reading order, large readable text, high contrast, and visible status/action states. Placeholder destinations must be visibly labeled rather than pretending incomplete features are functional.

**Alternative considered:** implement the map-first layout from the brief directly on Beranda. Deferred because the wireframe and current demo priority favor the delay status card; map/routing remains in the journey change.

### Design tokens are semantic and accessibility-first

Use semantic tokens rather than literal color names so status meaning remains stable if the visual palette changes. For this iteration, resolve the supplied token gaps as follows:

| Token | Decision | Rationale |
|---|---|---|
| `color-status-safe` | `#00B055` | Use the confirmed Success/Green scale for safe state; reserve blue for brand/action surfaces. |
| `color-text-high-vis` | `#FFFFFF` | White is present in the supplied palette and avoids inventing an unvalidated yellow scale. |
| `text-size-body-standard` | `1.125rem` / 18px | Larger than browser body defaults while remaining practical for dense status and history content. |
| `text-size-body-oversized` | `1.5rem` / 24px | Gives the demo a visibly chunky, readable scale without introducing the excluded low-vision profile. |
| `font-weight-readable` | `600` | Semi-bold improves scanning; Light/Thin weights are excluded. |
| `size-touch-target-standard` | `48px` | Use the source value for ordinary controls. |
| `size-touch-target-massive` | `72px` | Use the lower source value for large feature tiles; no Tunanetra mode is implemented. |
| Base spacing | 8px rhythm with 16px screen padding and 16px component gap | Provides separation without making the portrait Beranda too sparse. |
| Blue scale step 0 | Unassigned | The source provides no value; do not invent one or use it in the first demo. |

The foundation SHALL use `#000000` for the true-black background, `#FFFFFF` for high-visibility text, `#0153A4` for brand/action emphasis, `#00B055` for safe status, `#FF7A1A` for warning, and `#B83630` for danger/incident status. These tokens are for the Tuli-focused demo; they do not introduce a Low Vision or Tunanetra product profile.

## Risks / Trade-offs

- [Risk] Render free tier spins down after 15 minutes without inbound traffic, including WebSocket messages, and cold-starts in about one minute → Mitigate by opening the demo at least one minute before recording and keeping transit updates flowing so the connection stays warm; the deterministic local replay path remains the fallback.
- [Risk] The Vercel/Render split introduces cross-origin CORS and WebSocket origin handling that can fail silently → Mitigate with an early deployment spike that verifies REST and WebSocket connectivity end-to-end before downstream changes rely on it.
- [Risk] Serving the built PWA and backend through two runtimes constrains frontend deployment flexibility → Accept for the deadline; preserve a clean API boundary so a combined deployment can be added later.
- [Risk] SQLite file persistence may be ephemeral on Render's free tier → Treat persistence as demo-scoped, document platform storage behavior, and keep deterministic seed data for every recording.
- [Risk] A broad shared data contract can delay feature work → Define only entities/events required by the three proposals and keep optional fields out until a consumer needs them.
- [Risk] Dark wireframe contrast may not be sufficient on every Android display → Validate text/status contrast and readability on the actual demo device, not only on desktop.

## Migration Plan

1. Create the monorepo runtime and validate the health endpoint locally.
2. Seed the deterministic demo transit context and verify the shared data contract.
3. Deploy the PWA to Vercel and the FastAPI backend to Render; verify REST, WebSocket, and CORS/origin behavior end-to-end from the deployed URLs.
4. Open the deployed PWA on Android and verify navigation, status card, and WebSocket health before downstream changes consume the foundation.
5. If a free-tier limitation blocks the demo path, keep the same runtime contract and use the local replay path for feature development; do not redesign downstream capabilities around a provider-specific API.

## Open Questions

- Whether the 24px oversized text scale and 72px feature-tile target feel appropriate on the physical Android demo device can be tuned during visual QA without changing the semantic token names.
- Whether Render's ephemeral disk is acceptable for demo persistence or the demo should rely on deterministic reseeding per recording; this does not change the user-facing retention contract and can be settled during the deployment spike.
