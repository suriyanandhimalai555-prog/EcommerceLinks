import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShoppingBag, Check, Loader2, Star, AlertCircle, CheckCircle2 } from 'lucide-react'
import api from '../lib/api'
import { formatINR } from '../lib/format'
import type { Product } from '../types/api'

export default function BuyProduct() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [paymentMethod, setPaymentMethod] = useState('upi')
  const [terms, setTerms] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderStatus, setOrderStatus] = useState<string | null>(null)

  const { data: products, isPending: productsPending } = useQuery<Product[]>({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then(r => r.data),
  })

  const selected = products?.find(p => p.id === selectedId)

  const createOrder = useMutation({
    mutationFn: () => api.post('/orders', { productId: selectedId }),
    onSuccess: (res) => {
      setOrderId(res.data.orderId)
      setOrderStatus('created')
    },
  })

  const simulatePay = useMutation({
    mutationFn: () => api.post('/dev/simulate-payment', { orderId }),
    onSuccess: () => setOrderStatus('confirmed'),
  })

if (orderStatus === 'confirmed') {
    return (
      <div className="max-w-lg mx-auto py-16 text-center animate-fade-in">
        <div className="w-20 h-20 bg-success-50 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 size={40} className="text-success" />
        </div>
        <h1 className="text-2xl font-bold text-ink mb-2">You are now an Active Member!</h1>
        <p className="text-ink-muted mb-6">Your product purchase has been confirmed. You can now start building your network.</p>
        <button onClick={() => navigate('/')} className="avg-btn-primary px-8 py-3">
          Go to Dashboard
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
          <h2 className="text-xl font-bold text-ink mb-2">Order Created</h2>
          <p className="text-sm text-ink-muted mb-2">Order ID: <span className="font-mono font-semibold">{orderId}</span></p>
          <p className="text-sm text-ink-muted mb-6">Amount: <strong>{selected && formatINR(selected.totalPaise)}</strong></p>

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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Buy Product</h1>
        <p className="text-sm text-ink-muted">Choose a plan to activate your membership</p>
      </div>

      {/* Already active banner */}
      <div className="flex items-center gap-2 bg-primary-50 border border-primary/20 text-primary text-sm p-3 rounded-xl">
        <AlertCircle size={15} />
        {t('buy.alreadyActive')}
      </div>

      {/* Product cards */}
      <div className="grid md:grid-cols-3 gap-4">
        {productsPending && [1,2,3].map(i => (
          <div key={i} className="avg-card p-5 space-y-4 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-1/2" />
            <div className="h-6 bg-gray-200 rounded w-3/4" />
            <div className="h-3 bg-gray-100 rounded" />
            <div className="h-3 bg-gray-100 rounded" />
          </div>
        ))}
        {(products ?? []).map((p) => {
          const isSelected = p.id === selectedId
          const isPopular = p.badges.includes('POPULAR')
          return (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`relative avg-card p-5 cursor-pointer transition-all duration-200 ${
                isSelected ? 'ring-2 ring-primary shadow-glow' : 'hover:shadow-md hover:-translate-y-0.5'
              }`}
            >
              {isPopular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <div className="bg-gradient-to-r from-primary to-violet text-white text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1">
                    <Star size={10} fill="white" /> POPULAR
                  </div>
                </div>
              )}
              {isSelected && (
                <div className="absolute top-3 right-3 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                  <Check size={12} className="text-white" />
                </div>
              )}
              <div className="mb-4 mt-2">
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {p.badges.map(b => <span key={b} className="text-[10px] font-bold text-primary bg-primary-50 px-2 py-0.5 rounded">{b}</span>)}
                </div>
                <h3 className="text-lg font-bold text-ink">{p.name}</h3>
              </div>
              <div className="space-y-2 border-t border-surface-line pt-4">
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">Base Price</span>
                  <span className="font-medium">{formatINR(p.basePricePaise)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">GST (18%)</span>
                  <span className="font-medium">{formatINR(p.gstPaise)}</span>
                </div>
                <div className="flex justify-between text-base font-bold pt-1 border-t border-surface-line">
                  <span>Total</span>
                  <span className="text-primary">{formatINR(p.totalPaise)}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Payment method */}
      {selected && (
        <div className="avg-card p-5 animate-fade-in">
          <h3 className="text-sm font-semibold text-ink mb-4">Payment Method</h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              { id: 'upi', label: 'UPI' },
              { id: 'phonepe', label: 'PhonePe' },
              { id: 'gpay', label: 'GPay' },
              { id: 'card', label: 'Card' },
              { id: 'netbanking', label: 'NetBanking' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setPaymentMethod(m.id)}
                className={`border rounded-lg px-3 py-2.5 text-sm font-medium transition-all cursor-pointer ${
                  paymentMethod === m.id ? 'border-primary bg-primary-50 text-primary' : 'border-surface-line hover:border-gray-300'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Purchase summary + buy */}
      {selected && (
        <div className="avg-card p-5 animate-fade-in">
          <h3 className="text-sm font-semibold text-ink mb-4">Purchase Summary</h3>
          <div className="space-y-2 mb-4">
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.basePrice')}</span>
              <span>{formatINR(selected.basePricePaise)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">{t('buy.gst')}</span>
              <span>{formatINR(selected.gstPaise)}</span>
            </div>
            <div className="flex justify-between text-base font-bold border-t border-surface-line pt-2">
              <span>{t('buy.total')}</span>
              <span className="text-primary">{formatINR(selected.totalPaise)}</span>
            </div>
          </div>

          <label className="flex items-start gap-3 mb-4 cursor-pointer">
            <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <span className="text-sm text-ink-muted">I agree to the Terms & Conditions and confirm this purchase</span>
          </label>

          <button
            onClick={() => createOrder.mutate()}
            disabled={!terms || createOrder.isPending}
            className="avg-btn-primary w-full py-3"
          >
            {createOrder.isPending ? <Loader2 size={16} className="animate-spin" /> : <ShoppingBag size={16} />}
            {t('buy.buyNow')} — {formatINR(selected.totalPaise)}
          </button>
        </div>
      )}
    </div>
  )
}
