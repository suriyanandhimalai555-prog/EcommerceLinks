import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ImageOff, ShieldAlert } from 'lucide-react'
import api from '../lib/api'
import { formatINR } from '../lib/format'
import type { Me, Product } from '../types/api'

export default function BuyProduct() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
    refetchInterval: (query) =>
      query.state.data?.kycStatus === 'pending' ? 30_000 : false,
  })
  const { data: products, isPending: productsPending } = useQuery<Product[]>({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then((r) => r.data),
  })

  const kycRequired = me != null && me.kycStatus !== 'verified'

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Buy Product</h1>
        <p className="text-sm text-ink-muted">Choose a plan to activate your membership</p>
      </div>

      {kycRequired && (
        <div className="flex flex-wrap items-center gap-3 bg-warning-50 border border-warning/30 text-warning text-sm p-3 rounded-xl">
          <ShieldAlert size={16} className="shrink-0" />
          <span className="flex-1 min-w-48">{t('buy.kycRequired')}</span>
          <button onClick={() => navigate('/profile')} className="avg-btn-primary py-1.5 px-3 text-xs">
            {t('buy.kycRequiredCta')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 bg-primary-50 border border-primary/20 text-primary text-sm p-3 rounded-xl">
        <AlertCircle size={15} />
        {t('buy.alreadyActive')}
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {productsPending &&
          [1, 2, 3].map((i) => (
            <div key={i} className="avg-card p-5 space-y-4 animate-pulse">
              <div className="h-4 bg-white/10 rounded w-1/2" />
              <div className="h-6 bg-white/10 rounded w-3/4" />
              <div className="h-3 bg-white/5 rounded" />
              <div className="h-3 bg-white/5 rounded" />
            </div>
          ))}
        {(products ?? []).map((p) => {
          const isPopular = p.badges.includes('POPULAR')
          return (
            <div
              key={p.id}
              onClick={() => navigate(`/buy/${p.id}`)}
              className="relative avg-card p-5 cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5"
            >
              {isPopular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <div className="bg-gradient-to-r from-primary to-violet text-white text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1">
                    ★ POPULAR
                  </div>
                </div>
              )}
              <div className="mb-4 mt-2">
                <div className="mb-3 aspect-[4/3] rounded-lg overflow-hidden border border-surface-line bg-[#10141F]">
                  {p.images[0] ? (
                    <img src={p.images[0].url} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-ink-muted">
                      <ImageOff size={22} />
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {p.badges.map((b) => (
                    <span key={b} className="text-[10px] font-bold text-primary bg-primary-50 px-2 py-0.5 rounded">
                      {b}
                    </span>
                  ))}
                </div>
                <h3 className="text-lg font-bold text-ink">{p.name}</h3>
                {p.description && (
                  <p className="text-xs text-ink-muted mt-1 line-clamp-2">{p.description}</p>
                )}
              </div>
              <div className="space-y-2 border-t border-surface-line pt-4">
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">Base Price</span>
                  <span className="font-medium text-ink">{formatINR(p.basePricePaise)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">GST (18%)</span>
                  <span className="font-medium text-ink">{formatINR(p.gstPaise)}</span>
                </div>
                <div className="flex justify-between text-base font-bold pt-1 border-t border-surface-line">
                  <span className="text-ink">Total</span>
                  <span className="text-primary">{formatINR(p.totalPaise)}</span>
                </div>
              </div>
              <p className="text-xs text-primary mt-3 text-right">{t('buy.viewDetails')}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
