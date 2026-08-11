## Purpose

Menyediakan shell PWA Transense yang dapat dibuka di Android, dinavigasi secara linear, dan menjadi rumah bersama bagi fitur demo berikutnya.

## ADDED Requirements

### Requirement: Core demo navigation
The application SHALL provide accessible navigation for Onboarding, Beranda, Keterlambatan, and Profil, with a persistent bottom navigation for Beranda, Keterlambatan, and Profil after onboarding.

#### Scenario: User enters the application
- **WHEN** a user opens the application without a completed demo profile
- **THEN** the application shows the onboarding flow before the main bottom navigation

#### Scenario: User navigates from the main shell
- **WHEN** a user selects Beranda, Keterlambatan, or Profil from the bottom navigation
- **THEN** the application shows the selected screen and preserves the selected navigation state

### Requirement: Linear Beranda layout
The Beranda screen SHALL present the greeting, halte/rute search entry point, nearest-route delay status card, and four feature entry points in a vertically readable mobile layout: Antar Aku, Transcribe, Informasi Keterlambatan Jalur, and Jadwal TransJakarta.

#### Scenario: User opens Beranda
- **WHEN** the Beranda screen is displayed
- **THEN** the user can see the greeting, search entry point, delay status card, and all four feature entry points without needing to interpret an audio-only control

#### Scenario: User selects a feature entry point
- **WHEN** the user selects one of the four feature entry points
- **THEN** the application navigates to the corresponding feature route or an explicitly labeled placeholder when that feature has not yet been implemented

### Requirement: Audio-blind visual baseline
The shell SHALL use a high-contrast visual baseline with readable large text and SHALL NOT make audio the sole way to understand navigation state, status, or primary actions.

#### Scenario: User views navigation and status
- **WHEN** a user views any shell screen on the Android demo device
- **THEN** the current screen, primary status, and primary action are represented visually with sufficient contrast

### Requirement: Demo profile onboarding
The onboarding flow SHALL allow the demo user to provide a display name and continue to the main shell without requiring production authentication.

#### Scenario: User completes onboarding
- **WHEN** the user enters a display name and submits onboarding
- **THEN** the application stores the demo profile locally and opens Beranda

#### Scenario: User submits an empty name
- **WHEN** the user attempts to continue without a display name
- **THEN** the application keeps the user on onboarding and displays a visible validation message
