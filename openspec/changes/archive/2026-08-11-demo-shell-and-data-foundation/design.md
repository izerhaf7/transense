## Context

See `proposal.md` for the motivation and user-facing scope. The implementation is a solo, deadline-driven monorepo with a React + Vite PWA frontend and FastAPI + WebSocket backend. The demo is served from two cloud services — the PWA on Vercel and the FastAPI/WebSocket backend on Google Cloud Run — and must be usable from an Android browser. Transit integrations are not available yet, so the foundation keeps simulated data behind a replaceable boundary.

The supplied Beranda wireframe is a portrait mobile screen with a white standard base, greeting, halte/rute search, a nearest-route delay status card, four feature tiles, and bottom navigation for Beranda, Keterlambatan, and Profil. It does not show a map on Beranda; map/routing belongs to the journey change.

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

### One monorepo with a split cloud deployment

Keep frontend and backend as separate concerns in one repository, but deploy them as two cloud services: the built React + Vite PWA on Vercel, and the FastAPI + WebSocket backend on Google Cloud Run. Cloud Run supports the HTTP/WebSocket runtime needed by the backend while Vercel remains the PWA host. The frontend must use a documented backend URL and CORS/WebSocket origin handling because the two services live on different origins.

**Why not Vercel-only:** Vercel now supports FastAPI WebSockets natively, but on the free Hobby plan every connection is hard-terminated at 300 seconds (5 minutes) and the feature is still Public Beta. For a demo that may run longer than 5 minutes, that is a reliability risk. Cloud Run keeps the backend as a dedicated service and supports WebSocket traffic while the instance is active.

**Alternative considered:** Vercel-only with reconnect logic. Rejected because 5-minute forced disconnects plus beta risk add failure modes to a recorded demo for no user-visible benefit. **Alternative considered:** a single Cloud Run service serving static PWA plus FastAPI. Rejected because the existing deployment choice favors Vercel for the PWA, and the split keeps frontend/backend concerns separate.

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

The raw palette is preserved as a reference scale; the application consumes
semantic tokens below rather than coupling components to raw step names.

| Raw scale | Steps |
|---|---|
| Neutral Black | `0:#949494`, `0.5:#858585`, `1:#767676`, `1.5:#686868`, `2:#595959`, `3:#3B3B3B`, `4:#1E1E1E`, `5:#000000`, `6-10:#000000` |
| Neutral White | `0-5:#FFFFFF`, `6:#E1E1E1`, `7:#C4C4C4`, `8:#A6A6A6`, `8.5:#979797`, `9:#898989`, `9.5:#7A7A7A`, `10:#6B6B6B` |
| Brand Blue `#0153A4` | `0:unassigned`, `0.5:#BAD8F6`, `1:#A5C9ED`, `1.5:#91BBE4`, `2:#7CACDB`, `3:#538EC8`, `4:#2A71B6`, `5:#0153A4`, `6:#014283`, `7:#013262`, `8:#002142`, `8.5:#001931`, `9:#001121`, `9.5:#000810`, `10:#000000` |
| Success Green `#00B055` | `0:#D9FFEB`, `0.5:#C3F7DC`, `1:#AEEFCD`, `1.5:#98E7BE`, `2:#82DFAF`, `3:#57D091`, `4:#2BC073`, `5:#00B055`, `6:#008D44`, `7:#006A33`, `8:#004622`, `8.5:#00351A`, `9:#002311`, `9.5:#001209`, `10:#000000` |
| Warning Orange `#FF7A1A` | `0:#FFFFFF`, `0.5:#FFF2E8`, `1:#FFE4D1`, `1.5:#FFD7BA`, `2:#FFCAA3`, `3:#FFAF76`, `4:#FF9548`, `5:#FF7A1A`, `6:#CC6215`, `7:#994910`, `8:#66310A`, `8.5:#4D2508`, `9:#331805`, `9.5:#1A0C03`, `10:#000000` |
| Danger Red `#B83630` | `0:#FFFFFF`, `0.5:#F8EBEA`, `1:#F1D7D6`, `1.5:#EAC3C1`, `2:#E3AFAC`, `3:#D48683`, `4:#C65E59`, `5:#B83630`, `6:#932B26`, `7:#6E201D`, `8:#4A1613`, `8.5:#37100E`, `9:#250B0A`, `9.5:#120505`, `10:#000000` |

The removed `color-bg-true-black`, `color-text-high-vis`, and
`size-touch-target-massive` tokens were Low Vision/Tunanetra-only source
tokens and are not part of the Tuli-focused standard theme.

| Token | Decision | Rationale |
|---|---|---|
| `color-status-safe` | `#00B055` | Use the confirmed Success/Green scale for safe state; reserve blue for brand/action surfaces. |
| `color-status-safe-foreground` | `#006A33` (Success step 7) | Darker semantic foreground for readable safe-state text, borders, and focus-adjacent UI on the white base; raw green remains available for fills. |
| `color-status-warning-foreground` | `#994910` (Warning step 7) | Darker semantic foreground for readable warning text, borders, and focus UI on the white base; raw orange remains available for fills. |
| `color-text-primary` | `#000000` | Primary readable text on the white standard base. |
| `color-text-on-brand` | `#FFFFFF` | Text for the blue brand surface used by primary controls and brand marks. |
| `text-size-body-standard` | `1.125rem` / 18px | Standard readable body size for the Tuli-focused demo. |
| `text-size-body-oversized` | `1.5rem` / 24px | Chunky readable Tuli UI scale, not a Low Vision mode. |
| `font-weight-readable` | `600` | Semi-bold improves scanning; Light/Thin weights are excluded. |
| `size-touch-target-standard` | `48px` | Use the source value for ordinary controls. |
| `size-feature-tile-min-height` | `96px` | Component sizing for feature tiles, not an accessibility-profile token. |
| `size-profile-avatar` | `64px` | Component sizing for the profile avatar, not an accessibility-profile token. |
| Base spacing | 8px rhythm with 16px screen padding and 16px component gap | Provides separation without making the portrait Beranda too sparse. |
| Blue scale step 0 | Unassigned | The source provides no value; do not invent one or use it in the first demo. |

The foundation SHALL use `#FFFFFF` for the standard background, `#000000` for primary text, `#FFFFFF` for text on brand surfaces, `#0153A4` for brand/action emphasis, `#00B055` for safe status, `#FF7A1A` for warning, and `#B83630` for danger/incident status. The 18px standard and 24px chunky readable sizes use weight 600, with an 8px spacing rhythm, 16px screen padding, and 16px component spacing. Feature tiles use a 96px minimum height and profile avatars use 64px; neither is an accessibility-profile token.

## Risks / Trade-offs

- [Risk] Cloud Run may scale an idle instance to zero and local SQLite storage is ephemeral → Mitigate by opening the demo before recording, keeping the WebSocket active, and using deterministic reseeding/local replay as the fallback.
- [Risk] The Vercel/Render split introduces cross-origin CORS and WebSocket origin handling that can fail silently → Mitigate with an early deployment spike that verifies REST and WebSocket connectivity end-to-end before downstream changes rely on it.
- [Risk] Serving the built PWA and backend through two runtimes constrains frontend deployment flexibility → Accept for the deadline; preserve a clean API boundary so a combined deployment can be added later.
- [Risk] SQLite file persistence is ephemeral on Cloud Run instances → Treat persistence as demo-scoped, document platform storage behavior, and keep deterministic seed data for every recording.
- [Risk] A broad shared data contract can delay feature work → Define only entities/events required by the three proposals and keep optional fields out until a consumer needs them.
- [Risk] White-base surfaces can expose weak text, border, or placeholder contrast → Validate text/status contrast and readability on the actual demo device, not only on desktop.

## Migration Plan

1. Create the monorepo runtime and validate the health endpoint locally.
2. Seed the deterministic demo transit context and verify the shared data contract.
3. Deploy the PWA to Vercel and the FastAPI backend to Render; verify REST, WebSocket, and CORS/origin behavior end-to-end from the deployed URLs.
4. Open the deployed PWA on Android and verify navigation, status card, and WebSocket health before downstream changes consume the foundation.
5. If a free-tier limitation blocks the demo path, keep the same runtime contract and use the local replay path for feature development; do not redesign downstream capabilities around a provider-specific API.

## Open Questions

- The 18px standard and 24px chunky readable scales, 96px feature-tile minimum, and 64px profile avatar are fixed source decisions; visual QA may tune composition without creating an accessibility-profile mode.
- Whether Render's ephemeral disk is acceptable for demo persistence or the demo should rely on deterministic reseeding per recording; this does not change the user-facing retention contract and can be settled during the deployment spike.
