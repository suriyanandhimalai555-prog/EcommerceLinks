import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CheckCircle2, Loader2, ShieldAlert, ShoppingBag } from 'lucide-react'
import api from '../lib/api'
import { formatINR } from '../lib/format'
import { ImageGallery } from '../components/ui/ImageGallery'
import { EmptyState } from '../components/ui/EmptyState'
import type { Me, Product } from '../types/api'

const PAYMENT_METHODS = [
  { id: 'upi', label: 'UPI' },
  { id: 'phonepe', label: 'PhonePe' },
  { id: 'gpay', label: 'GPay' },
  { id: 'card', label: 'Card' },
  { id: 'netbanking', label: 'NetBanking' },
]

export default function ProductDetail() {
  const { t } = useTranslation()
  const { id: pid } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [paymentMethod, setPaymentMethod] = useState('upi')
  const [terms, setTerms] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderStatus, setOrderStatus] = useState<string | null>(null)
  const [kycBlocked, setKycBlocked] = useState(false)

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
    refetchInterval: (query) =>
      query.state.data?.kycStatus === 'pending' ? 30_000 : false,
  })

  const { data: product, isPending, isError } = useQuery<Product>({
    queryKey: ['products', pid],
    queryFn: () => api.get(`/products/${pid}`).then((r) => r.data),
    placeholderData: () => {
      const cached = qc.getQueryData<Product[]>(['products'])
      return cached?.find((p) => String(p.id) === pid)
    },
    retry: false,
  })

  const kycRequired = kycBlocked || (me != null && me.kycStatus !== 'verified')

  const createOrder = useMutation({
    mutationFn: () => api.post('/orders', { productId: Number(pid) }),
    onSuccess: (res) => {
      setOrderId(res.data.orderId)
      setOrderStatus('created')
    },
    onError: (err) => {
      if (isAxiosError(err) && err.response?.data?.error?.code === 'KYC_REQUIRED')
        setKycBlocked(true)
    },
  })

  const simulatePay = useMutation({
    mutationFn: () => api.post('/dev/simulate-payment', { orderId }),
    onSuccess: () => {
      setOrderStatus('confirmed')
      qc.invalidateQueries()
    },
  })

  if (orderStatus === 'confirmed') {
    return (
      <div className="max-w-lg mx-auto py-16 text-center animate-fade-in">
        <div className="w-20 h-20 bg-success-50 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 size={40} className="text-success" />
        </div>
        <h1 className="text-2xl font-bold text-ink mb-2">{t('buy.successTitle')}</h1>
        <p className="text-ink-muted mb-6">{t('buy.successBody')}</p>
        <button onClick={() => navigate('/')} className="avg-btn-primary px-8 py-3 mx-auto">
          {t('buy.goToDashboard')}
        </button>
      </div>
    )
  }

  if (orderId) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center animate-fade-in">
        <div className="avg-card p-8">
          <div className="w-16 h-16 bg-primary-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <ShoppingBag size={28} className="text-primary" />
          </div>
          <h2 className="text-xl font-bold text-ink mb-2">{t('buy.orderCreated')}</h2>
          <p className="text-sm text-ink-muted mb-2">
            {t('buy.orderIdLabel')}: <span className="font-mono font-semibold">{orderId}</span>
          </p>
          <p className="text-sm text-ink-muted mb-6">
            {t('buy.amount')}: <strong>{product && formatINR(product.totalPaise)}</strong>
          </p>
          <button
            onClick={() => simulatePay.mutate()}
            disabled={simulatePay.isPending}
            className="avg-btn-primary w-full py-3"
          >
            {simulatePay.isPending ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
            {t('buy.simulatePay')}
          </button>
        </div>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="max-w-5xl mx-auto space-y-6 animate-pulse">
        <div className="h-4 bg-white/10 rounded w-32" />
        <div className="grid lg:grid-cols-[1fr_380px] gap-6">
          <div className="avg-card p-5 space-y-4">
            <div className="aspect-video bg-white/10 rounded-xl" />
            <div className="h-6 bg-white/10 rounded w-1/2" />
            <div className="h-3 bg-white/5 rounded" />
            <div className="h-3 bg-white/5 rounded w-3/4" />
          </div>
          <div className="avg-card p-5 space-y-4">
            <div className="h-4 bg-white/10 rounded w-1/2" />
            <div className="h-10 bg-white/5 rounded" />
            <div className="h-10 bg-white/5 rounded" />
            <div className="h-12 bg-white/10 rounded" />
          </div>
        </div>
      </div>
    )
  }

  if (isError || !product) {
    return (
      <div className="max-w-lg mx-auto py-16">
        <EmptyState
          title={t('buy.notFoundTitle')}
          description={t('buy.notFoundDesc')}
        />
        <div className="text-center mt-6">
          <Link to="/buy" className="avg-btn-secondary py-2 px-4 text-sm">
            <ArrowLeft size={14} className="inline mr-1" />
            {t('buy.backToCatalog')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <Link to="/buy" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors">
        <ArrowLeft size={14} />
        {t('buy.backToCatalog')}
      </Link>

      {kycRequired && (
        <div className="flex flex-wrap items-center gap-3 bg-warning-50 border border-warning/30 text-warning text-sm p-3 rounded-xl">
          <ShieldAlert size={16} className="shrink-0" />
          <span className="flex-1 min-w-48">{t('buy.kycRequired')}</span>
          <button onClick={() => navigate('/profile')} className="avg-btn-primary py-1.5 px-3 text-xs">
            {t('buy.kycRequiredCta')}
          </button>
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_380px] gap-6 items-start">
        {/* Left: gallery + info */}
        <div className="avg-card p-5 space-y-4">
          <ImageGallery images={product.images} alt={product.name} />
          {product.badges.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {product.badges.map((b) => (
                <span key={b} className="text-[10px] font-bold text-primary bg-primary-50 px-2 py-0.5 rounded">
                  {b}
                </span>
              ))}
            </div>
          )}
          <h1 className="text-xl font-bold text-ink">{product.name}</h1>
          {product.description && (
            <p className="text-sm text-ink-muted whitespace-pre-line">{product.description}</p>
          )}
        </div>

        {/* Right: purchase card */}
        <div className="avg-card p-5 space-y-5 lg:sticky lg:top-4">
          {/* Pricing */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.basePrice')}</span>
              <span className="text-ink">{formatINR(product.basePricePaise)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.gst')}</span>
              <span className="text-ink">{formatINR(product.gstPaise)}</span>
            </div>
            <div className="flex justify-between text-base font-bold border-t border-surface-line pt-2">
              <span className="text-ink">{t('buy.total')}</span>
              <span className="text-primary">{formatINR(product.totalPaise)}</span>
            </div>
          </div>

          {/* Payment method */}
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">{t('buy.paymentMethod')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-5 gap-2">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setPaymentMethod(m.id)}
                  className={`border rounded-lg px-2 py-2 text-xs font-medium transition-all cursor-pointer ${
                    paymentMethod === m.id
                      ? 'border-primary bg-primary-50 text-primary'
                      : 'border-surface-line hover:border-[#39415E] text-ink-muted'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Terms */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              className="mt-0.5 accent-primary w-4 h-4"
            />
            <span className="text-sm text-ink-muted">{t('buy.termsLabel')}</span>
          </label>

          {/* Buy button */}
          <button
            onClick={() => createOrder.mutate()}
            disabled={!terms || kycRequired || createOrder.isPending}
            className="avg-btn-primary w-full py-3"
          >
            {createOrder.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ShoppingBag size={16} />
            )}
            {t('buy.buyNow')} — {formatINR(product.totalPaise)}
          </button>
        </div>
      </div>
    </div>
  )
}
