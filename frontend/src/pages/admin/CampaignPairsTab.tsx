import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Gift, CheckCircle2, Clock, Users, Coins, Download, Loader2, AlertTriangle,
} from 'lucide-react'
import api from '../../lib/api'
import { formatINR } from '../../lib/format'
import { downloadCsv } from '../../lib/exportCsv'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { StatCard } from '../../components/ui/StatCard'
import type { CampaignPairsAdminRes, CampaignPairsAdminRow } from '../../types/api'

const PAGE_LIMIT = 50

type Scope = 'pairs' | 'all'
type Pkg = '' | '1000000' | '3000000' | '5000000'

const PKG_OPTIONS: Array<{ value: Pkg; label: string }> = [
  { value: '',        label: 'pkgAll'  },
  { value: '1000000', label: 'pkg10k'  },
  { value: '3000000', label: 'pkg30k'  },
  { value: '5000000', label: 'pkg50k'  },
]

function pkgRupees(paise: number): string {
  if (paise === 0) return '—'
  return formatINR(paise)
}

function statusLabel(r: CampaignPairsAdminRow, t: (k: string) => string) {
  if (r.pendingPaise === 0 && r.pairs > 0) return <Badge variant="success">{t('admin.campaignPairs.statusReleased')}</Badge>
  if (r.releasedPaise === 0 && r.pairs > 0) return <Badge variant="warning">{t('admin.campaignPairs.statusPending')}</Badge>
  if (r.pairs > 0) return <Badge variant="neutral">{t('admin.campaignPairs.statusPartial')}</Badge>
  return <Badge variant="neutral">—</Badge>
}

export function CampaignPairsTab() {
  const { t } = useTranslation()

  const [scope, setScope] = useState<Scope>('pairs')
  const [pkg, setPkg] = useState<Pkg>('')
  const [exporting, setExporting] = useState(false)

  const buildUrl = (offsetParam: number, overrides?: { scope?: Scope; pkg?: Pkg }) => {
    const s = overrides?.scope ?? scope
    const p = overrides?.pkg ?? pkg
    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      offset: String(offsetParam),
      scope: s,
    })
    if (p) params.set('package', p)
    return `/admin/campaign/pairs?${params}`
  }

  const {
    data,
    isPending,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    isError,
  } = useInfiniteQuery<CampaignPairsAdminRes>({
    queryKey: ['admin', 'campaign', 'pairs', scope, pkg],
    queryFn: ({ pageParam }) =>
      api.get(buildUrl(pageParam as number ?? 0)).then((r) => r.data),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  })

  const summary = data?.pages[0]?.summary
  const rows: CampaignPairsAdminRow[] = data?.pages.flatMap((p) => p.items) ?? []

  // ── Export ────────────────────────────────────────────────────────────────
  const exportCsv = async () => {
    setExporting(true)
    try {
      const all: CampaignPairsAdminRow[] = []
      let nextOffset: number | null = 0
      while (nextOffset !== null) {
        const res: CampaignPairsAdminRes = await api
          .get(buildUrl(nextOffset))
          .then((r) => r.data)
        all.push(...res.items)
        if (res.items.length === 0) break
        nextOffset = res.nextOffset
      }
      const headers = [
        t('admin.campaignPairs.colMember'),
        'Member Code',
        t('admin.campaignPairs.colPackage') + ' (₹)',
        t('admin.campaignPairs.colPairs'),
        t('admin.campaignPairs.colBonus') + ' (₹)',
        t('admin.campaignPairs.colReleased') + ' (₹)',
        t('admin.campaignPairs.colPending') + ' (₹)',
        t('admin.campaignPairs.colCoins'),
        t('admin.campaignPairs.colStatus'),
      ]
      const csvRows = all.map((r) => {
        const statusStr =
          r.pendingPaise === 0 && r.pairs > 0
            ? t('admin.campaignPairs.statusReleased')
            : r.releasedPaise === 0 && r.pairs > 0
              ? t('admin.campaignPairs.statusPending')
              : r.pairs > 0
                ? t('admin.campaignPairs.statusPartial')
                : '—'
        return [
          r.name,
          r.memberCode,
          r.packageValuePaise ? (r.packageValuePaise / 100).toFixed(0) : '0',
          r.pairs,
          (r.bonusPaise   / 100).toFixed(2),
          (r.releasedPaise / 100).toFixed(2),
          (r.pendingPaise  / 100).toFixed(2),
          r.coins,
          statusStr,
        ]
      })
      downloadCsv(`campaign-pairs-${new Date().toISOString().slice(0, 10)}.csv`, headers, csvRows)
    } finally {
      setExporting(false)
    }
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns: Column<CampaignPairsAdminRow>[] = [
    {
      key: 'member',
      header: t('admin.campaignPairs.colMember'),
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-ink">{r.name}</p>
          <p className="text-xs text-ink-muted">{r.memberCode}</p>
        </div>
      ),
    },
    {
      key: 'package',
      header: t('admin.campaignPairs.colPackage'),
      align: 'right',
      render: (r) => (
        <span className="text-sm text-ink">{pkgRupees(r.packageValuePaise)}</span>
      ),
    },
    {
      key: 'coins',
      header: t('admin.campaignPairs.colCoins'),
      align: 'right',
      render: (r) => (
        <span className="font-semibold text-amber-400 flex items-center justify-end gap-1">
          <Coins size={12} />
          {r.coins}
        </span>
      ),
    },
    {
      key: 'pairs',
      header: t('admin.campaignPairs.colPairs'),
      align: 'right',
      render: (r) => (
        <span className="font-bold text-ink">{r.pairs}</span>
      ),
    },
    {
      key: 'bonus',
      header: t('admin.campaignPairs.colBonus'),
      align: 'right',
      render: (r) => (
        <span className="font-semibold text-ink">{formatINR(r.bonusPaise)}</span>
      ),
    },
    {
      key: 'released',
      header: t('admin.campaignPairs.colReleased'),
      align: 'right',
      render: (r) => (
        <span className="text-success">{formatINR(r.releasedPaise)}</span>
      ),
    },
    {
      key: 'pending',
      header: t('admin.campaignPairs.colPending'),
      align: 'right',
      render: (r) => (
        <span className="text-warning">{formatINR(r.pendingPaise)}</span>
      ),
    },
    {
      key: 'status',
      header: t('admin.campaignPairs.colStatus'),
      render: (r) => statusLabel(r, t),
    },
  ]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">{t('admin.campaignPairs.title')}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{t('admin.campaignPairs.subtitle')}</p>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label={t('admin.campaignPairs.statTotalPairs')}
          value={isPending ? '—' : String(summary?.totalPairs ?? 0)}
          sub={t('admin.campaignPairs.statEarners', { count: summary?.earners ?? 0 })}
          icon={<Gift />}
          tint="primary"
        />
        <StatCard
          label={t('admin.campaignPairs.statTotalBonus')}
          value={isPending ? '—' : formatINR(summary?.totalBonusPaise ?? 0)}
          icon={<Users />}
          tint="violet"
        />
        <StatCard
          label={t('admin.campaignPairs.statReleased')}
          value={isPending ? '—' : formatINR(summary?.releasedBonusPaise ?? 0)}
          sub={t('admin.campaignPairs.statReleasedCount', { count: summary?.releasedCount ?? 0 })}
          icon={<CheckCircle2 />}
          tint="success"
        />
        <StatCard
          label={t('admin.campaignPairs.statPending')}
          value={isPending ? '—' : formatINR(summary?.pendingBonusPaise ?? 0)}
          sub={t('admin.campaignPairs.statPendingCount', { count: summary?.pendingCount ?? 0 })}
          icon={<Clock />}
          tint="warning"
        />
        <StatCard
          label={t('admin.campaignPairs.statTotalCoins')}
          value={isPending ? '—' : String(summary?.totalCoins ?? 0)}
          icon={<Coins />}
          tint="violet"
        />
      </div>

      {/* Controls: scope toggle + package filter + export */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Scope pills */}
        <div className="flex rounded-lg overflow-hidden border border-surface-line">
          {(['pairs', 'all'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                scope === s
                  ? 'bg-primary text-white'
                  : 'bg-[#10141F] text-ink-muted hover:text-ink'
              }`}
            >
              {s === 'pairs'
                ? t('admin.campaignPairs.scopePairs')
                : t('admin.campaignPairs.scopeAllHolders')}
            </button>
          ))}
        </div>

        {/* Package filter */}
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-ink-muted">{t('admin.campaignPairs.filterPackage')}</label>
          <select
            value={pkg}
            onChange={(e) => setPkg(e.target.value as Pkg)}
            className="rounded-lg border border-surface-line bg-[#10141F] px-3 py-1.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          >
            {PKG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(`admin.campaignPairs.${o.label}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Export */}
        <button
          type="button"
          onClick={exportCsv}
          disabled={exporting || isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-surface-line bg-[#10141F] text-xs text-ink-muted hover:text-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {exporting
            ? <Loader2 size={13} className="animate-spin" />
            : <Download size={13} />}
          {exporting
            ? t('admin.campaignPairs.exporting')
            : t('admin.campaignPairs.exportButton')}
        </button>
      </div>

      {/* Error banner — shown when the backend returns a non-2xx (e.g. missing migrations) */}
      {isError && (
        <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-xl p-3">
          <AlertTriangle size={14} className="text-danger shrink-0" />
          <p className="text-sm text-danger">{t('admin.campaignPairs.loadError')}</p>
        </div>
      )}

      {/* Per-member table */}
      <DataTable<CampaignPairsAdminRow>
        columns={columns}
        data={rows}
        rowKey={(r) => r.memberId}
        loading={isPending}
        emptyTitle={t('admin.campaignPairs.emptyTitle')}
        emptyDescription={t('admin.campaignPairs.emptyDesc')}
        onLoadMore={hasNextPage ? () => fetchNextPage() : undefined}
        hasMore={!!hasNextPage}
        loadingMore={isFetchingNextPage}
      />
    </div>
  )
}
