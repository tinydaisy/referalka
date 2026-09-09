'use client'
import { useEffect, useState } from 'react'
import { Plus, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru'

export default function AdminPartnersPage() {
  const [partners, setPartners] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', partner_code: '', percent: '0', contact: '' })
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => { api.admin.partners().then(r => setPartners(r.partners || [])).catch(() => {}) }, [])

  async function addPartner(e: React.FormEvent) {
    e.preventDefault()
    const res = await api.admin.createPartner({ ...form, percent: parseFloat(form.percent) })
    setPartners(p => [...p, res.partner])
    setShowForm(false)
    setForm({ name: '', partner_code: '', percent: '0', contact: '' })
  }

  function copyLink(code: string) {
    navigator.clipboard.writeText(`${APP_URL}/register?utm_source=partner&utm_content=${code}`)
    setCopied(code)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Партнёры</h1>
        <button onClick={() => setShowForm(true)} className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
          <Plus size={14} /> Добавить партнёра
        </button>
      </div>

      {showForm && (
        <form onSubmit={addPartner} className="bg-white rounded-2xl border border-gray-200 p-6 mb-6 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4">Новый партнёр</h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Имя *</label>
              <input required type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Код (латиница) *</label>
              <input required type="text" value={form.partner_code} onChange={e => setForm(f => ({ ...f, partner_code: e.target.value.toUpperCase() }))}
                placeholder="VASYA"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm uppercase" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">% вознаграждения</label>
              <input type="number" min={0} max={100} step={0.5} value={form.percent} onChange={e => setForm(f => ({ ...f, percent: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Контакт (TG или email)</label>
              <input type="text" value={form.contact} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
            <button type="submit" className="btn-gold px-5 py-2 rounded-lg text-sm font-medium">Создать</button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-2xl border card-border shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              {['Партнёр', 'Код', '%', 'Клиентов', 'Реферальная ссылка'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {partners.length > 0 ? partners.map(p => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-5 py-4">
                  <p className="font-medium text-gray-900 text-sm">{p.name}</p>
                  {p.contact && <p className="text-xs text-gray-400">{p.contact}</p>}
                </td>
                <td className="px-5 py-4">
                  <code className="px-2 py-1 bg-gray-100 rounded text-sm font-mono">{p.partner_code}</code>
                </td>
                <td className="px-5 py-4 text-sm text-gray-600">{p.percent}%</td>
                <td className="px-5 py-4 text-sm font-semibold text-gray-900">{p.clients_count || 0}</td>
                <td className="px-5 py-4">
                  <button onClick={() => copyLink(p.partner_code)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200">
                    {copied === p.partner_code ? <><Check size={12} className="text-green-600" /> Скопировано</> : <><Copy size={12} /> Копировать ссылку</>}
                  </button>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-gray-400">Партнёров пока нет</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
