import { useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, Copy, FileText, Loader2, MapPin, ShoppingBag, Upload } from 'lucide-react'
import api from '../lib/api'
import { formatINR } from '../lib/format'
import { ImageGallery } from '../components/ui/ImageGallery'
import { EmptyState } from '../components/ui/EmptyState'
import { ImageUploader, type ImageUploaderHandle, type UploadedImage } from '../components/ui/ImageUploader'
import { BANK_ACCOUNTS } from '../lib/bankAccounts'
import type { Me, MyOrder, OrderStatus, PresignRes, Product } from '../types/api'
import KycRequiredBanner from '../components/ui/KycRequiredBanner'

export default function ProductDetail() {
  const { t } = useTranslation()
  const { id: pid } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const uploaderRef = useRef<ImageUploaderHandle>(null)

  const [terms, setTerms] = useState(false)
  // orderId is set when the member creates a new order via the Buy button.
  const [orderId, setOrderId] = useState<string | null>(null)
  const [kycBlocked, setKycBlocked] = useState(false)
  const [addressBlocked, setAddressBlocked] = useState(false)
  const [proofImages, setProofImages] = useState<UploadedImage[]>([])
  const [copied, setCopied] = useState<string | null>(null)

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
    refetchInterval: (query) =>
      query.state.data?.kycStatus === 'pending' ? 30_000 : false,
  })

  // Detect any existing in-progress order for this product so the member
  // resumes the upload flow rather than accidentally creating a duplicate.
  const { data: myOrders } = useQuery<MyOrder[]>({
    queryKey: ['my-orders'],
    queryFn: () => api.get('/me/orders').then((r) => r.data),
  })
  const existingOrder = myOrders?.find(
    (o) => String(o.productId) === pid &&
           ['created', 'paid', 'rejected'].includes(o.status),
  )
  // Use the just-created orderId first (immediate after Buy click), then fall
  // back to any existing open order detected from the member's order history.
  const activeOrderId = orderId ?? existingOrder?.orderId ?? null

  const { data: product, isPending, isError } = useQuery<Product>({
    queryKey: ['products', pid],
    queryFn: () => api.get(`/products/${pid}`).then((r) => r.data),
    placeholderData: () => {
      const cached = qc.getQueryData<Product[]>(['products'])
      return cached?.find((p) => String(p.id) === pid)
    },
    retry: false,
  })

  // Poll the order status — flips to confirmed once admin confirms payment.
  const { data: orderStatus } = useQuery<OrderStatus>({
    queryKey: ['order-status', activeOrderId],
    queryFn: () => api.get(`/orders/${activeOrderId}`).then((r) => r.data),
    enabled: !!activeOrderId,
    refetchInterval: 10_000,
  })

  // kycMandatory defaults to true so old API responses still enforce the gate
  const kycRequired = kycBlocked || (me != null && (me.kycMandatory ?? true) && me.kycStatus !== 'verified')
  // Address is required when the member has not set one yet (null = not set).
  // addressBlocked is also set when the server returns ADDRESS_REQUIRED as a safety net.
  const hasAddress = me != null && me.deliveryAddress != null
  const addressRequired = addressBlocked || (me != null && !hasAddress)

  const createOrder = useMutation({
    mutationFn: () => api.post('/orders', { productId: Number(pid) }),
    onSuccess: (res) => {
      setOrderId(res.data.orderId)
    },
    onError: (err) => {
      if (isAxiosError(err) && err.response?.data?.error?.code === 'KYC_REQUIRED')
        setKycBlocked(true)
      if (isAxiosError(err) && err.response?.data?.error?.code === 'ADDRESS_REQUIRED')
        setAddressBlocked(true)
    },
  })

  const submitProof = useMutation({
    mutationFn: async () => {
      const keys = await uploaderRef.current!.upload()
      for (const key of keys) {
        await api.post(`/me/orders/${activeOrderId}/payment-proof`, { key })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['order-status', activeOrderId] })
      qc.invalidateQueries({ queryKey: ['my-orders'] })
    },
  })

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    })
  }

  const getPaymentProofPresign = (file: File): Promise<PresignRes> =>
    api
      .post(`/me/orders/${activeOrderId}/payment-proof/presign`, {
        contentType: file.type,
        sizeBytes: file.size,
      })
      .then((r) => r.data)

  // ── Success screen (admin confirmed payment) ─────────────────────────────
  if (activeOrderId && orderStatus?.status === 'confirmed') {
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

  // ── Awaiting payment screen (order placed or existing active order detected) ──
  if (activeOrderId) {
    const proofUploaded = orderStatus?.status === 'paid'
    const isRejected = orderStatus?.status === 'rejected'

    return (
      <div className="max-w-xl mx-auto py-10 animate-fade-in space-y-4">
        {/* Rejection banner */}
        {isRejected && (
          <div className="flex items-start gap-3 bg-danger/10 border border-danger/30 rounded-xl p-4">
            <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-danger">{t('buy.proofRejectedTitle')}</p>
              {orderStatus?.rejectionReason && (
                <p className="text-xs text-ink-muted mt-0.5">{orderStatus.rejectionReason}</p>
              )}
              <p className="text-xs text-ink-muted mt-1">{t('buy.proofRejectedHint')}</p>
            </div>
          </div>
        )}
        {/* Order summary */}
        <div className="avg-card p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center shrink-0">
              <ShoppingBag size={20} className="text-primary" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">{t('buy.awaitingPaymentTitle')}</h2>
              <p className="text-xs text-ink-muted">{t('buy.awaitingPaymentInstructions')}</p>
            </div>
          </div>
          <div className="bg-white/5 rounded-xl p-3 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-muted">{t('buy.orderIdLabel')}</span>
              <span className="font-mono font-semibold text-ink">{orderId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">{t('buy.amount')}</span>
              <span className="font-bold text-primary">{product && formatINR(product.totalPaise)}</span>
            </div>
          </div>
        </div>

        {/* Bank accounts */}
        <div className="avg-card p-5 space-y-3">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{t('buy.bankTransferTitle')}</h3>
          {BANK_ACCOUNTS.map((acc) => (
            <div key={acc.bank} className="bg-white/5 rounded-xl p-4 space-y-2">
              <p className="text-xs font-bold text-primary uppercase tracking-wide">{acc.bank}</p>
              {[
                { label: t('buy.bankAccountName'), value: acc.accountName, id: `${acc.bank}-name` },
                { label: t('buy.bankAccountNo'), value: acc.accountNo, id: `${acc.bank}-no` },
                { label: t('buy.bankIfsc'), value: acc.ifsc, id: `${acc.bank}-ifsc` },
              ].map(({ label, value, id }) => (
                <div key={id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] text-ink-muted uppercase tracking-wide">{label}</p>
                    <p className="text-sm font-mono font-semibold text-ink truncate">{value}</p>
                  </div>
                  <button
                    onClick={() => copyToClipboard(value, id)}
                    className="shrink-0 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
                    title={t('buy.copyBtn')}
                  >
                    {copied === id
                      ? <CheckCircle2 size={13} className="text-success" />
                      : <Copy size={13} />}
                  </button>
                </div>
              ))}
            </div>
          ))}
          <p className="text-xs text-ink-muted bg-warning/10 border border-warning/20 rounded-lg p-3">
            {t('buy.awaitingPaymentContact')}
          </p>
        </div>

        {/* Payment proof upload */}
        <div className="avg-card p-5 space-y-3">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-1.5">
            <Upload size={12} /> {t('buy.uploadProofTitle')}
          </h3>
          {proofUploaded ? (
            <div className="flex items-center gap-2 text-sm text-success bg-success/10 rounded-lg p-3">
              <CheckCircle2 size={16} />
              {t('buy.proofUploaded')}
            </div>
          ) : (
            <>
              <p className="text-xs text-ink-muted">{t('buy.uploadProofHint')}</p>
              <ImageUploader
                deferUpload
                ref={uploaderRef}
                maxFiles={5}
                value={proofImages}
                onChange={setProofImages}
                getPresign={getPaymentProofPresign}
              />
              <button
                onClick={() => submitProof.mutate()}
                disabled={proofImages.length === 0 || submitProof.isPending}
                className="avg-btn-primary w-full py-3 mt-1"
              >
                {submitProof.isPending
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Upload size={15} />}
                {t('buy.submitProof')}
              </button>
              {submitProof.isError && (
                <p className="text-xs text-danger mt-1">{t('buy.submitProofError')}</p>
              )}
            </>
          )}
          {/* Status indicator */}
          <div className="flex items-center gap-2 text-xs text-ink-muted justify-center pt-1">
            <Clock size={13} className="animate-pulse" />
            {proofUploaded ? t('buy.awaitingApproval') : t('buy.awaitingPaymentPending')}
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
  // Desktop: two columns — image/info left, purchase card right (sticky).
  // Mobile: the grid collapses to one column, so the reading order becomes
  // Image → Name → Buy Now → Documents → Description (description sits below).
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <Link to="/buy" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors">
        <ArrowLeft size={14} />
        {t('buy.backToCatalog')}
      </Link>

      {kycRequired && <KycRequiredBanner />}

      {addressRequired && (
        <div className="flex items-start gap-3 bg-warning/8 border border-warning/25 rounded-2xl p-4">
          <MapPin size={16} className="text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-ink">{t('buy.addressRequired')}</p>
            <p className="text-xs text-ink-muted mt-0.5">{t('buy.addressRequiredHint')}</p>
            <Link
              to="/profile/address"
              className="inline-block mt-2 text-xs font-semibold text-primary underline underline-offset-2"
            >
              {t('buy.addressRequiredCta')}
            </Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 lg:items-start">
        {/* Left: gallery + name */}
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
        </div>

        {/* Right: purchase card + documents */}
        <div className="avg-card p-5 space-y-5 lg:sticky lg:top-4">
          {/* Pricing */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.basePrice')}</span>
              <span className="text-ink">{formatINR(product.basePricePaise)}</span>
            </div>
            <div className="flex justify-between text-base font-bold border-t border-surface-line pt-2">
              <span className="text-ink">{t('buy.total')}</span>
              <span className="text-primary">{formatINR(product.totalPaise)}</span>
            </div>
          </div>

          {/* Delivery address (read-only) */}
          {hasAddress && me?.deliveryAddress && (
            <div className="rounded-xl bg-white/5 border border-surface-line p-3 space-y-0.5">
              <div className="flex items-center gap-1.5 mb-1">
                <MapPin size={12} className="text-ink-muted" />
                <span className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">{t('buy.deliverTo')}</span>
              </div>
              <p className="text-xs font-semibold text-ink">{me.deliveryAddress.recipientName}</p>
              <p className="text-xs text-ink-muted">{me.deliveryAddress.line1}{me.deliveryAddress.line2 ? `, ${me.deliveryAddress.line2}` : ''}</p>
              <p className="text-xs text-ink-muted">{me.deliveryAddress.city}, {me.deliveryAddress.state} — {me.deliveryAddress.pincode}</p>
            </div>
          )}

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
            disabled={!terms || kycRequired || addressRequired || createOrder.isPending}
            className="avg-btn-primary w-full py-3"
          >
            {createOrder.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ShoppingBag size={16} />
            )}
            {t('buy.buyNow')} — {formatINR(product.totalPaise)}
          </button>

          {/* Downloadable PDF documents (datasheets/brochures). Opens in a new tab. */}
          {product.documents && product.documents.length > 0 && (
            <div className="space-y-2 border-t border-surface-line pt-4">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                {t('buy.documents')}
              </h3>
              <ul className="space-y-1.5">
                {product.documents.map((doc) => (
                  <li key={doc.id}>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 text-sm text-primary hover:underline"
                    >
                      <FileText size={14} className="shrink-0" />
                      <span className="truncate">{doc.name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Description: full-width below both columns (and last on mobile) */}
      {product.description && (
        <div className="avg-card p-5">
          <p className="text-sm text-ink-muted whitespace-pre-line">{product.description}</p>
        </div>
      )}
    </div>
  )
}
