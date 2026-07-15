import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CheckCircle2, Clock, Loader2, ShieldAlert, ShoppingBag } from 'lucide-react'
import api from '../lib/api'
import { formatINR } from '../lib/format'
import { ImageGallery } from '../components/ui/ImageGallery'
import { EmptyState } from '../components/ui/EmptyState'
import type { Me, OrderStatus, Product } from '../types/api'

export default function ProductDetail() {
  const { t } = useTranslation()
  const { id: pid } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [terms, setTerms] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
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

  // Poll the order status after creation — flips to confirmed once admin confirms payment.
  const { data: orderStatus } = useQuery<OrderStatus>({
    queryKey: ['order-status', orderId],
    queryFn: () => api.get(`/orders/${orderId}`).then((r) => r.data),
    enabled: !!orderId,
    refetchInterval: 10_000, // check every 10 seconds
  })

  // kycMandatory defaults to true so old API responses still enforce the gate
  const kycRequired = kycBlocked || (me != null && (me.kycMandatory ?? true) && me.kycStatus !== 'verified')

  const createOrder = useMutation({
    mutationFn: () => api.post('/orders', { productId: Number(pid) }),
    onSuccess: (res) => {
      setOrderId(res.data.orderId)
    },
    onError: (err) => {
      if (isAxiosError(err) && err.response?.data?.error?.code === 'KYC_REQUIRED')
        setKycBlocked(true)
    },
  })

  // ── Success screen (admin confirmed payment) ─────────────────────────────
  if (orderStatus?.status === 'confirmed') {
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

  // ── Awaiting payment screen (order placed, pending admin confirmation) ────
  if (orderId) {
    return (
      <div className="max-w-lg mx-auto py-16 animate-fade-in">
        <div className="avg-card p-8 space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <ShoppingBag size={28} className="text-primary" />
            </div>
            <h2 className="text-xl font-bold text-ink">{t('buy.awaitingPaymentTitle')}</h2>
          </div>

          {/* Order summary */}
          <div className="bg-white/5 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.orderIdLabel')}</span>
              <span className="font-mono font-semibold text-ink">{orderId}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.amount')}</span>
              <span className="font-bold text-primary">{product && formatINR(product.totalPaise)}</span>
            </div>
          </div>

          {/* Instructions */}
          <p className="text-sm text-ink-muted leading-relaxed">
            {t('buy.awaitingPaymentInstructions')}
          </p>

          <p className="text-xs text-ink-muted bg-warning/10 border border-warning/20 rounded-lg p-3">
            {t('buy.awaitingPaymentContact')}
          </p>

          {/* Live polling indicator */}
          <div className="flex items-center gap-2 text-xs text-ink-muted justify-center">
            <Clock size={13} className="animate-pulse" />
            {t('buy.awaitingPaymentPending')}
          </div>
        </div>
      </div>
    )
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────
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
            <div className="h-12 bg-white/10 rounded" />
          </div>
        </div>
      </div>
    )
  }

  // ── Not found ─────────────────────────────────────────────────────────────
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

  // ── Product detail + buy form ─────────────────────────────────────────────
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
