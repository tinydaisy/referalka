// Полупрозрачный оверлей с крутящимся колесом — показывается на короткое
// время (200-500ms) пока летит fetch /landing-redirect, чтобы пользователь
// видел что клик принят, и не подумал «ничего не происходит».
export default function SpinnerOverlay() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10, 21, 32, 0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        width: 44, height: 44,
        border: '4px solid rgba(255, 207, 164, 0.25)',
        borderTopColor: 'var(--peach)',
        borderRadius: '50%',
        animation: 'spinner-rot 0.8s linear infinite',
      }} />
      <style>{`
        @keyframes spinner-rot {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
