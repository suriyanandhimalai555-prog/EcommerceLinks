import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'

export default function KycRequiredBanner() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className="flex flex-wrap items-center gap-3 bg-warning-50 border border-warning/30 text-warning text-sm p-3 rounded-xl">
      <ShieldAlert size={16} className="shrink-0" />
      <span className="flex-1 min-w-48">{t('buy.kycRequired')}</span>
      <button onClick={() => navigate('/profile/kyc')} className="avg-btn-primary py-1.5 px-3 text-xs">
        {t('buy.kycRequiredCta')}
      </button>
    </div>
  )
}
