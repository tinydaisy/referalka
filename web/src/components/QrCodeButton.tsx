'use client'
/**
 * QR-код для любой ссылки: кнопка-иконка + окно с настройкой цвета и фона.
 *
 * Вынесено из страницы лид-магнитов, где это появилось первым. Там компонент был
 * завязан на её типы (площадка, slug, вид «магнит или пакет») и использовать его
 * в другом месте было нельзя. Здесь он принимает просто ссылку и подпись.
 *
 * ⚠️ Картинка генерится внешним сервисом quickchart.io — без npm-зависимостей.
 * Значит, работает только при живом интернете у того, кто открыл страницу.
 */
import { useState } from 'react'
import { QrCode, Download, Check, X } from 'lucide-react'

/** Адрес картинки QR. color — цвет модулей, bg — прозрачный или контрастный фон. */
export function qrPngUrl(
  data: string,
  opts: { color?: 'black' | 'white'; bg?: 'transparent' | 'contrast'; size?: number } = {}
): string {
  const { color = 'black', bg = 'contrast', size = 600 } = opts
  const dark = color === 'white' ? 'ffffff' : '000000'
  const light = bg === 'transparent'
    ? '00000000'
    : (color === 'white' ? '000000' : 'ffffff')
  return `https://quickchart.io/qr?text=${encodeURIComponent(data)}&size=${size}&margin=2&dark=${dark}&light=${light}&ecLevel=M&format=png`
}

export default function QrCodeButton({ url, title, fileBase, className }: {
  url: string
  /** Что именно кодируем — показывается в шапке окна */
  title?: string
  /** Основа имени файла при скачивании */
  fileBase?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="QR-код"
        className={className || 'p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition'}
      >
        <QrCode size={16} />
      </button>
      {open && (
        <QrModal url={url} title={title} fileBase={fileBase} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function QrModal({ url, title, fileBase, onClose }: {
  url: string; title?: string; fileBase?: string; onClose: () => void
}) {
  const [color, setColor] = useState<'black' | 'white'>('black')
  const [bg, setBg] = useState<'transparent' | 'contrast'>('contrast')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const previewUrl = qrPngUrl(url, { color, bg, size: 360 })
  const safeName = (fileBase || title || 'link').replace(/[^a-zа-я0-9]+/gi, '_').slice(0, 40)
  const fileName = `qr-${safeName}-${color}-${bg}.png`

  // Шахматка под превью — чтобы прозрачность была видна.
  const checker = 'repeating-conic-gradient(#e5e7eb 0% 25%, #fff 0% 50%) 50% / 16px 16px'

  async function downloadQr() {
    setBusy(true)
    try {
      const resp = await fetch(qrPngUrl(url, { color, bg }))
      const blob = await resp.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href; a.download = fileName
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(href)
    } catch {
      window.open(qrPngUrl(url, { color, bg }), '_blank')
    } finally { setBusy(false) }
  }

  async function copyQr() {
    setBusy(true)
    try {
      const resp = await fetch(qrPngUrl(url, { color, bg }))
      const blob = await resp.blob()
      let pngBlob = blob
      if (blob.type !== 'image/png') {
        pngBlob = await new Promise<Blob>((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            const cv = document.createElement('canvas')
            cv.width = img.width; cv.height = img.height
            cv.getContext('2d')!.drawImage(img, 0, 0)
            cv.toBlob(b => b ? resolve(b) : reject(new Error('no blob')), 'image/png')
          }
          img.onerror = reject
          img.src = URL.createObjectURL(blob)
        })
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch {
      alert('Не удалось скопировать картинку в этом браузере. Используйте «Скачать».')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-[#25455D] text-sm">QR-код</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {title && (
            <div className="rounded-xl bg-[#FFF6EE] border border-[#FFCFA4] px-3 py-2">
              <p className="text-sm font-semibold text-[#25455D] break-words">{title}</p>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-gray-700 mb-1.5">Цвет кода</p>
            <div className="flex gap-2">
              {(['black', 'white'] as const).map(c => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                    color === c ? 'border-transparent text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                  style={color === c ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}>
                  {c === 'black' ? 'Чёрный' : 'Белый'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-700 mb-1.5">Фон</p>
            <div className="flex flex-col gap-1.5">
              {([['transparent', 'Прозрачный'],
                 ['contrast', color === 'white' ? 'Контрастный (чёрный)' : 'Контрастный (белый)']] as const).map(([v, lbl]) => (
                <label key={v} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="qrbg" checked={bg === v} onChange={() => setBg(v as any)} />
                  {lbl}
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-center">
            <div className="p-3 rounded-xl border border-gray-200" style={{ background: checker }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="QR" width={180} height={180} className="block" />
            </div>
          </div>

          {color === 'white' && bg === 'transparent' && (
            <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
              Белый QR на прозрачном фоне читается только на тёмном фоне (афиша, баннер).
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={copyQr} disabled={busy}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5">
              {copied ? <><Check size={14} className="text-green-600" /> Скопировано</> : <><QrCode size={14} /> Скопировать</>}
            </button>
            <button type="button" onClick={downloadQr} disabled={busy}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              <Download size={14} /> Скачать
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
