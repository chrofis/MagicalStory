import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { storyService } from '@/services';
import type { AdminVoucher } from '@/services/storyService';
import { localizedApiError } from '@/utils/apiErrors';
import { useLanguage } from '@/context/LanguageContext';

type Created = Array<{ id: string | number; code: string; url: string; expiresAt: string | null }>;

// Admin-only screen: German like the owner's other working views, not translated.
const STATUS_LABEL: Record<string, string> = { active: 'Aktiv', redeemed: 'Eingelöst', void: 'Ungültig', expired: 'Abgelaufen' };
const KIND_LABEL: Record<string, string> = { purchase: 'Gekauft', campaign: 'Kampagne' };

export default function AdminVouchers() {
  const { language } = useLanguage();
  const [count, setCount] = useState('10');
  const [label, setLabel] = useState('');
  const [months, setMonths] = useState('12');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [vouchers, setVouchers] = useState<AdminVoucher[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmVoidId, setConfirmVoidId] = useState<string | number | null>(null);
  const [resendEmail, setResendEmail] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await storyService.adminListVouchers({ status: statusFilter || undefined, kind: kindFilter || undefined });
      setVouchers(r.vouchers);
    } catch (err) {
      setMessage({ type: 'error', text: localizedApiError(err, language) });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, kindFilter, language]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    const n = parseInt(count, 10);
    const m = parseInt(months, 10);
    if (!(n >= 1) || !label.trim() || !(m >= 1)) {
      setMessage({ type: 'error', text: 'Anzahl, Bezeichnung und Monate ausfüllen.' });
      return;
    }
    setCreating(true);
    setMessage(null);
    try {
      const r = await storyService.adminCreateVoucherBatch({ count: n, label: label.trim(), expiresInMonths: m });
      setCreated(r.vouchers);
      setMessage({ type: 'success', text: `${r.vouchers.length} Gutscheine erstellt.` });
      load();
    } catch (err) {
      setMessage({ type: 'error', text: localizedApiError(err, language) });
    } finally {
      setCreating(false);
    }
  };

  const run = async (action: () => Promise<unknown>, okText: string) => {
    setMessage(null);
    try {
      await action();
      setMessage({ type: 'success', text: okText });
      load();
    } catch (err) {
      setMessage({ type: 'error', text: localizedApiError(err, language) });
    }
  };

  const pdf = (id: string | number) => run(() => storyService.adminDownloadVoucherPdf(id), 'PDF heruntergeladen.');
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('de-CH') : '–');

  const input = 'px-3 py-2 border border-gray-300 rounded-lg text-sm';
  const primary = 'bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50';
  const secondary = 'bg-gray-100 text-gray-700 px-3 py-2 rounded-lg text-sm font-semibold hover:bg-gray-200';

  return (
    <div className="space-y-6">
      {message && (
        <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-lg p-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Neue Gutscheine erstellen</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-xs text-gray-500">Anzahl
            <input type="number" min="1" value={count} onChange={e => setCount(e.target.value)} className={`${input} block w-24 mt-1`} />
          </label>
          <label className="text-xs text-gray-500 flex-1 min-w-[12rem]">Bezeichnung
            <input type="text" value={label} onChange={e => setLabel(e.target.value)} className={`${input} block w-full mt-1`} />
          </label>
          <label className="text-xs text-gray-500">Gültig (Monate)
            <input type="number" min="1" value={months} onChange={e => setMonths(e.target.value)} className={`${input} block w-28 mt-1`} />
          </label>
          <button onClick={handleCreate} disabled={creating} className={primary}>{creating ? 'Wird erstellt…' : 'Erstellen'}</button>
        </div>

        {created.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 border-b"><th className="py-2 pr-3">Code</th><th className="pr-3">Link</th><th className="pr-3">Gültig bis</th><th /></tr></thead>
              <tbody>
                {created.map(c => (
                  <tr key={c.id} className="border-b border-gray-100">
                    <td className="py-2 pr-3 font-mono select-all">{c.code}</td>
                    <td className="pr-3 break-all"><a href={c.url} className="text-indigo-600 hover:underline">{c.url}</a></td>
                    <td className="pr-3">{fmt(c.expiresAt)}</td>
                    <td><button onClick={() => pdf(c.id)} className={secondary}>PDF</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-lg p-6">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h3 className="text-lg font-semibold text-gray-800 mr-auto">Alle Gutscheine</h3>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={input}>
            <option value="">Alle Status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={kindFilter} onChange={e => setKindFilter(e.target.value)} className={input}>
            <option value="">Alle Arten</option>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={load} disabled={loading} className={secondary} aria-label="Aktualisieren">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-3">Code</th><th className="pr-3">Art</th><th className="pr-3">Status</th>
                <th className="pr-3">Bezeichnung</th><th className="pr-3">Gültig bis</th><th className="pr-3">Käufer</th>
                <th className="pr-3">Eingelöst von</th><th className="pr-3">Buch</th><th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {vouchers.map(v => {
                const key = String(v.id);
                return (
                  <tr key={key} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-3 font-mono">{v.codePrefix}…</td>
                    <td className="pr-3">{KIND_LABEL[v.kind] || v.kind}</td>
                    <td className="pr-3">{STATUS_LABEL[v.status] || v.status}</td>
                    <td className="pr-3">{v.batchLabel || '–'}</td>
                    <td className="pr-3">{v.expiresAt ? fmt(v.expiresAt) : 'unbefristet'}</td>
                    <td className="pr-3 break-all">{v.purchaserEmail || '–'}</td>
                    <td className="pr-3 break-all">{v.redeemedByEmail ? `${v.redeemedByEmail} (${fmt(v.redeemedAt)})` : '–'}</td>
                    <td className="pr-3">{v.bookUsed ? 'bestellt' : 'offen'}</td>
                    <td>
                      <div className="flex flex-wrap gap-2 items-center">
                        <button onClick={() => pdf(v.id)} className={secondary}>PDF</button>
                        {v.status === 'active' && (confirmVoidId === v.id ? (
                          <>
                            <span className="text-xs text-red-700">Wirklich ungültig machen?</span>
                            <button
                              onClick={() => { setConfirmVoidId(null); run(() => storyService.adminVoidVoucher(v.id), 'Gutschein ungültig gemacht.'); }}
                              className="bg-red-500 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-red-600"
                            >Ja</button>
                            <button onClick={() => setConfirmVoidId(null)} className={secondary}>Nein</button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmVoidId(v.id)} className={secondary}>Ungültig machen</button>
                        ))}
                        <input
                          type="email"
                          placeholder="E-Mail"
                          value={resendEmail[key] || ''}
                          onChange={e => setResendEmail(prev => ({ ...prev, [key]: e.target.value }))}
                          className={`${input} w-44`}
                        />
                        <button
                          disabled={!(resendEmail[key] || '').trim()}
                          onClick={() => run(() => storyService.adminResendVoucher(v.id, (resendEmail[key] || '').trim()), 'E-Mail gesendet.')}
                          className={`${secondary} disabled:opacity-50`}
                        >Senden</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {vouchers.length === 0 && !loading && (
                <tr><td colSpan={9} className="py-6 text-center text-gray-500">Keine Gutscheine.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
