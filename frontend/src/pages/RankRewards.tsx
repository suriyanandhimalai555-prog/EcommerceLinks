import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Trophy, CheckCircle2, Lock, Clock, Star, Info } from 'lucide-react'
import api from '../lib/api'
import { formatDate } from '../lib/format'
import { Badge } from '../components/ui/Badge'
import { SkeletonCard } from '../components/ui/Skeleton'
import type { RankLevel } from '../types/api'

const RANK_REWARDS = [
  { reward: 'Kodaikanal group tour', value: '' },
  { reward: 'Thailand group tour', value: '' },
  { reward: 'Royal Enfield', value: 'worth ₹1.5L' },
  { reward: 'Car', value: 'worth ₹5L' },
  { reward: 'Gold', value: 'worth ₹10L' },
  { reward: 'Gold', value: 'worth ₹25L' },
  { reward: 'Villa', value: 'worth ₹50L' },
  { reward: 'Luxury Car', value: 'worth ₹1Cr' },
  { reward: 'Gold', value: 'worth ₹2.5Cr' },
  { reward: 'Villa', value: 'worth ₹6Cr' },
  { reward: 'Dubai Villa + 10-yr Golden Visa', value: 'worth ₹12Cr' },
  { reward: 'Rolls Royce + Director Royalty', value: 'worth ₹25Cr' },
]

const levelGradients = [
  'from-primary to-[#7C93F0]',
  'from-primary to-[#7C93F0]',
  'from-primary to-[#7C93F0]',
  'from-primary to-[#7C93F0]',
  'from-[#3355C9] to-primary',
  'from-[#3355C9] to-primary',
  'from-[#3355C9] to-primary',
  'from-[#3355C9] to-primary',
  'from-amber-400 to-amber-500',
  'from-amber-400 to-amber-500',
  'from-amber-400 to-amber-500',
  'from-amber-400 to-amber-500',
]

export default function RankRewards() {
  const { t } = useTranslation()
  const { data: rankData, isPending: ranksPending } = useQuery<{ levels: RankLevel[] }>({
    queryKey: ['ranks'],
    queryFn: () => api.get('/ranks/progress').then(r => r.data),
  })
  const { data: dash, isPending: dashPending } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard').then(r => r.data),
  })

  const levels = rankData?.levels ?? []
  const currentLevel = dash?.rank?.current ?? 0
  const nextLevel = dash?.rank?.next ?? null

  if (ranksPending || dashPending) {
    return (
      <div className="space-y-6">
        <SkeletonCard lines={4} />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} lines={2} />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="bg-gradient-to-br from-primary via-primary to-violet rounded-2xl p-6 text-white relative overflow-hidden">
        <div className="absolute -right-8 -top-8 w-40 h-40 bg-white/5 rounded-full" />
        <div className="absolute -right-2 bottom-4 w-24 h-24 bg-white/5 rounded-full" />
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
              <Trophy size={24} />
            </div>
            <div>
              <p className="text-white/70 text-sm">Your Current Rank</p>
              <h1 className="text-2xl font-bold">{currentLevel ? t(`ranks.l${currentLevel}`) : '—'}</h1>
            </div>
          </div>
          {nextLevel && dash?.rank?.progress && (
            <div>
              <p className="text-white/70 text-sm mb-2">
                Progress to {t(`ranks.l${nextLevel}`)}: need {dash.rank.progress.requiredEachSide} qualified each side
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex justify-between text-xs text-white/70 mb-1">
                    <span>Left Qualified</span>
                    <span>{dash.rank.progress.leftQualified}/{dash.rank.progress.requiredEachSide}</span>
                  </div>
                  <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                    <div className="h-full bg-white rounded-full" style={{ width: `${Math.min(100, (dash.rank.progress.leftQualified / dash.rank.progress.requiredEachSide) * 100)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-white/70 mb-1">
                    <span>Right Qualified</span>
                    <span>{dash.rank.progress.rightQualified}/{dash.rank.progress.requiredEachSide}</span>
                  </div>
                  <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                    <div className="h-full bg-white rounded-full" style={{ width: `${Math.min(100, (dash.rank.progress.rightQualified / dash.rank.progress.requiredEachSide) * 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Note */}
      <div className="flex items-start gap-2 bg-primary-50 border border-primary/20 rounded-xl p-3 text-sm text-ink-muted">
        <Info size={14} className="text-primary mt-0.5 flex-shrink-0" />
        <span>{t('ranks.fulfillmentNote')}</span>
      </div>

      {/* Rank ladder */}
      <div className="space-y-3">
        {levels.map((level, idx) => {
          const isAchieved = level.achieved
          const isInProgress = level.level === nextLevel
          const isLocked = !isAchieved && !isInProgress && level.level > (nextLevel ?? currentLevel + 1)
          const reward = RANK_REWARDS[idx]
          const gradient = levelGradients[idx]

          return (
            <div
              key={level.level}
              className={`avg-card p-5 transition-all duration-200 ${
                isAchieved ? 'border-success/30 bg-success-50/20' :
                isInProgress ? 'border-primary/30 ring-1 ring-primary/20' :
                isLocked ? 'opacity-60' : ''
              }`}
            >
              <div className="flex items-start gap-4">
                {/* Level badge */}
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} flex flex-col items-center justify-center flex-shrink-0 text-white`}>
                  <span className="text-[10px] font-semibold opacity-80">L</span>
                  <span className="text-lg font-bold leading-none">{level.level}</span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="text-base font-bold text-ink">{t(`ranks.l${level.level}`)}</h3>
                    {isAchieved && <Badge variant="success"><CheckCircle2 size={10} /> Achieved</Badge>}
                    {isInProgress && <Badge variant="primary"><Star size={10} /> In Progress</Badge>}
                    {isLocked && <Badge variant="neutral"><Lock size={10} /> Locked</Badge>}
                    {level.verificationStatus === 'pending' && <Badge variant="warning"><Clock size={10} /> Pending verification</Badge>}
                  </div>

                  {/* Reward */}
                  <div className="flex items-center gap-1.5 mb-2">
                    <Trophy size={13} className="text-warning" />
                    <span className="text-sm text-ink-muted">{reward.reward}{reward.value ? ` ${reward.value}` : ''}</span>
                  </div>

                  {/* Requirement */}
                  {isInProgress && level.requirement.kind === 'qualified' && (
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div>
                        <div className="flex justify-between text-xs text-ink-muted mb-1">
                          <span>Left {t('counters.qualified')}</span>
                          <span className="font-semibold">{level.requirement.leftQualified}/{level.requirement.requiredEachSide}</span>
                        </div>
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-primary to-violet rounded-full"
                            style={{ width: `${Math.min(100, (level.requirement.leftQualified / level.requirement.requiredEachSide) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-xs text-ink-muted mb-1">
                          <span>Right {t('counters.qualified')}</span>
                          <span className="font-semibold">{level.requirement.rightQualified}/{level.requirement.requiredEachSide}</span>
                        </div>
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-violet to-primary rounded-full"
                            style={{ width: `${Math.min(100, (level.requirement.rightQualified / level.requirement.requiredEachSide) * 100)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {isInProgress && level.requirement.kind === 'achiever' && (
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div className="text-xs">
                        <div className="flex justify-between text-ink-muted mb-1">
                          <span>Left L{level.requirement.requiredRank} Achiever</span>
                          <span className="font-semibold">{level.requirement.leftAchievers}/1</span>
                        </div>
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-primary rounded-full" style={{ width: `${level.requirement.leftAchievers * 100}%` }} />
                        </div>
                      </div>
                      <div className="text-xs">
                        <div className="flex justify-between text-ink-muted mb-1">
                          <span>Right L{level.requirement.requiredRank} Achiever</span>
                          <span className="font-semibold">{level.requirement.rightAchievers}/1</span>
                        </div>
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-violet rounded-full" style={{ width: `${level.requirement.rightAchievers * 100}%` }} />
                        </div>
                      </div>
                    </div>
                  )}

                  {isAchieved && level.achievedAt && (
                    <p className="text-xs text-success mt-1">Achieved on {formatDate(level.achievedAt)}</p>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
