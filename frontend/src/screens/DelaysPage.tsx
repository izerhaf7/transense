// Delays screen: incident history with pin/unpin.

import type { IncidentRecord } from '../types'

export function DelaysPage({ incidentRecords, onPinIncident }: { incidentRecords: IncidentRecord[]; onPinIncident: (incidentId: string) => void }) {
  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">FEED STATUS / 7 HARI</p>
        <h2>Keterlambatan</h2>
        <p>Riwayat insiden terstruktur yang dapat dibaca ulang. Semua entri adalah simulasi demo, bukan feed resmi live.</p>
      </section>
      {incidentRecords.map((incident) => (
        <article className="incident-card incident-card--warning" key={incident.id}>
          <div className="incident-card__header"><span className="state-badge state-badge--warning">SIMULASI</span><time dateTime={incident.updatedAt}>{new Date(incident.updatedAt).toLocaleString('id-ID')}</time></div>
          <h3>{incident.status}</h3>
          <dl className="incident-details">
            <div><dt>Penyebab</dt><dd>{incident.cause}</dd></div>
            <div><dt>Tindakan</dt><dd>{incident.action}</dd></div>
            <div><dt>Instruksi</dt><dd>{incident.instruction}</dd></div>
          </dl>
          <div className="incident-card__footer">
            <span>{incident.pinned ? 'Tersimpan di sesi demo · marker pin aktif' : 'Retensi demo: 7 hari'}</span>
            <button className="secondary-button" type="button" onClick={() => onPinIncident(incident.id)}>{incident.pinned ? 'Lepas simpan' : 'Simpan / pin'}</button>
          </div>
        </article>
      ))}
    </main>
  )
}
