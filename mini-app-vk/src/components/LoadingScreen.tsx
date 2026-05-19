import { useEffect, useState } from 'react'

export default function LoadingScreen() {
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setProgress(p => Math.min(p + 15, 95)), 100)
    return () => clearInterval(t)
  }, [])
  return (
    <div style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', boxSizing: 'border-box', textAlign: 'center' }}>
      <img src="/logo.png" alt="" style={{ width: 72, height: 'auto', marginBottom: 16, opacity: 0.95 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 1, color: '#FFCFA4', fontFamily: 'Roboto, sans-serif', textTransform: 'uppercase' }}>
          iViSiON: ПЛЮСОН
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.45, color: 'rgba(255,255,255,0.85)', marginTop: 8, fontFamily: 'Roboto', maxWidth: 320, marginLeft: 'auto', marginRight: 'auto' }}>
          Платформа для организаторов и экспертов: управляйте событием от А до Я — спикеры, рассылки, рефералы в одном месте
        </div>
      </div>
      <div style={{ width: 200 }}>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 16, fontFamily: 'Roboto' }}>
        Загружаем ваш кабинет...
      </p>
    </div>
  )
}
