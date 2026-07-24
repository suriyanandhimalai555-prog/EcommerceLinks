import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Package, Upload } from 'lucide-react'
import api from '../lib/api'
import { formatINR, formatDate } from '../lib/format'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState } from '../components/ui/EmptyState'
import type { MyOrder } from '../types/api'

const STATUS_CONFIG: Record<
  MyOrder['status'],
  { label: string; className: string; icon: React.ReactNode }
> = {
  confirmed: {
    label: 'Active',
    className: 'text-success bg-success/10 border-success/20',
    icon: <CheckCircle2 size={13} />,
  },
  paid: {
    label: 'Awaiting Review',
    className: 'text-warning bg-warning/10 border-warning/20',
    icon: <Clock size={13} />,
  },
  created: {
    label: 'Awaiting Payment',
    className: 'text-ink-muted bg-white/5 border-surface-line',
    icon: <Clock size={13} />,
  },
  rejected: {
    label: 'Proof Rejected',
    className: 'text-danger bg-danger/10 border-danger/20',
    icon: <AlertTriangle size={13} />,
  },
  failed: {
    label: 'Failed',
    className: 'text-danger bg-danger/10 border-danger/20',
    icon: <AlertTriangle size={13} />,
  },
  refunded: {
    label: 'Refunded',
    className: 'text-ink-muted bg-white/5 border-surface-line',
    icon: <CheckCircle2 size={13} />,
  },
}

export default function MyOrders() {
  const { t } = useTranslation()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: orders, isPending } = useQuery<MyOrder[]>({
    queryKey: ['my-orders'],
    queryFn: () => api.get('/me/orders').then((r) => r.data),
  })

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('myOrders.title')}</h1>
        <p className="text-sm text-ink-muted mt-0.5">{t('myOrders.subtitle')}</p>
      </div>

      {isPending ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="avg-card p-5">
              <Skeleton className="h-4 w-1/3 mb-3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : !orders?.length ? (
        <div className="avg-card p-8">
          <EmptyState
            title={t('myOrders.emptyTitle')}
            description={t('myOrders.emptyDesc')}
          />
          <div className="text-center mt-4">
            <Link to="/buy" className="avg-btn-primary px-6 py-2 text-sm mx-auto">
              <Package size={14} />
              {t('myOrders.browseProducts')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const cfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.created
            const needsUpload = order.status === 'created' || order.status === 'rejected'
            const isExpanded = expandedId === order.orderId
            const hasDetails =
              order.paymentRef || order.confirmedAt || order.paymentProofUrls?.length

            return (
              <div key={order.orderId} className="avg-card overflow-hidden">
                {/* Summary row — clickable to expand */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : order.orderId)}
                  className="w-full text-left p-5 flex items-start justify-between gap-3 flex-wrap"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{order.productName}</p>
                    <p className="text-xs text-ink-muted mt-0.5">{formatDate(order.createdAt)}</p>
                    {order.rejectionReason && (
                      <p className="text-xs text-danger mt-1.5 bg-danger/5 border border-danger/20 rounded-lg px-2.5 py-1.5">
                        {t('myOrders.rejectedReason')}: {order.rejectionReason}
                      </p>
                    )}
                  </div>

                  <div className="flex items-start gap-3 shrink-0">
                    <div className="flex flex-col items-end gap-2">
                      <span className="text-sm font-bold text-primary">{formatINR(order.totalPaise)}</span>
                      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cfg.className}`}>
                        {cfg.icon}
                        {cfg.label}
                      </span>
                    </div>
                    {hasDetails && (
                      <ChevronDown
                        size={16}
                        className={`mt-0.5 text-ink-muted transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    )}
                  </div>
                </button>

                {/* Expanded payment details */}
                {isExpanded && hasDetails && (
                  <div className="px-5 pb-5 border-t border-surface-line pt-4 space-y-4">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="text-ink-muted shrink-0">{t('myOrders.orderId')}</span>
                        <span className="font-mono text-xs text-ink text-right break-all">{order.orderId}</span>
                      </div>
                      {order.paymentRef && (
                        <div className="flex justify-between gap-3">
                          <span className="text-ink-muted shrink-0">{t('myOrders.paymentRef')}</span>
                          <span className="font-mono text-xs text-ink text-right break-all">{order.paymentRef}</span>
                        </div>
                      )}
                      {order.confirmedAt && (
                        <div className="flex justify-between gap-3">
                          <span className="text-ink-muted shrink-0">{t('myOrders.confirmedAt')}</span>
                          <span className="text-xs text-ink text-right">{formatDate(order.confirmedAt)}</span>
                        </div>
                      )}
                    </div>

                    {order.paymentProofUrls && order.paymentProofUrls.length > 0 && (
                      <div>
                        <p className="text-xs text-ink-muted mb-2">{t('myOrders.proofImages')}</p>
                        <div className="flex gap-2 flex-wrap">
                          {order.paymentProofUrls.map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noreferrer" className="block group shrink-0">
                              <img
                                src={url}
                                alt={`Payment proof ${i + 1}`}
                                className="w-20 h-20 rounded-lg object-cover border border-surface-line group-hover:border-primary transition-colors"
                              />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Upload link for pending orders */}
                {needsUpload && (
                  <div className="px-5 pb-4 pt-0 border-t border-surface-line">
                    <Link
                      to={`/buy/${order.productId}`}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                    >
                      <Upload size={12} />
                      {order.status === 'rejected'
                        ? t('myOrders.reUploadProof')
                        : t('myOrders.uploadProof')}
                    </Link>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
