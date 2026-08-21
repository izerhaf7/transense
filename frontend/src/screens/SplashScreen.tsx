// Splash screen.

export function SplashScreen({ leaving }: { leaving: boolean }) {
  return (
    <main className={`splash-screen${leaving ? ' splash-screen--leaving' : ''}`} aria-label="Memuat Transense">
      <div className="splash-screen__stage">
        <img className="splash-screen__logo" src="/logos/Logo-Transense.png" alt="Logo Transense" />
      </div>
      <p className="splash-screen__tagline">Mobilitas Sepatutnya Mudah untuk Semua</p>
    </main>
  )
}
