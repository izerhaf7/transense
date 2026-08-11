# demo-persistence Specification

## Purpose
Menyediakan penyimpanan demo yang persisten untuk histori lintas sesi serta lifecycle cleanup bersama yang dapat dipakai transkrip dan feed notifikasi.
## Requirements
### Requirement: Persistent demo records
The system SHALL persist supported demo records with a creation timestamp and a stable record identifier so that records remain readable after the application or browser session is reopened.

#### Scenario: User reopens the application
- **WHEN** a user opens a new session after a supported record was created
- **THEN** the record remains available until its retention rule removes it

#### Scenario: Record lacks retention metadata
- **WHEN** the system receives a persistable record without a valid creation timestamp
- **THEN** the system rejects the record rather than applying an ambiguous cleanup policy

### Requirement: Seven-day cleanup
The system SHALL automatically remove non-exempt supported records older than 7 days according to the configured application time basis.

#### Scenario: Record exceeds retention
- **WHEN** cleanup runs and a non-exempt record is older than 7 days
- **THEN** the record is no longer returned by history queries

#### Scenario: Record is within retention
- **WHEN** cleanup runs and a record is no older than 7 days
- **THEN** the record remains available to history queries

### Requirement: Explicit retention exemption
The system SHALL support an explicit save/pinned marker for record types that permit retention exemption, and SHALL not delete an exempt record during ordinary 7-day cleanup.

#### Scenario: User saves a supported record
- **WHEN** the user marks a supported record as saved
- **THEN** cleanup preserves that record beyond 7 days

#### Scenario: User removes the save marker
- **WHEN** the user removes the saved marker from a supported record older than 7 days
- **THEN** the next cleanup makes the record eligible for deletion

