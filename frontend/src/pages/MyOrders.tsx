import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Clock, Package, Upload } from 'lucide-react'
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
            const isPending = order.status === 'created' || order.status === 'rejected'

            return (
              <div key={order.orderId} className="avg-card p-5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{order.productName}</p>
                    <p className="text-xs text-ink-muted mt-0.5">{formatDate(order.createdAt)}</p>
                    {order.rejectionReason && (
                      <p className="text-xs text-danger mt-1.5 bg-danger/5 border border-danger/20 rounded-lg px-2.5 py-1.5">
                        {t('myOrders.rejectedReason')}: {order.rejectionReason}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <span className="text-sm font-bold text-primary">{formatINR(order.totalPaise)}</span>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cfg.className}`}>
                      {cfg.icon}
                      {cfg.label}
                    </span>
                  </div>
                </div>

                {isPending && (
                  <div className="mt-3 pt-3 border-t border-surface-line">
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
