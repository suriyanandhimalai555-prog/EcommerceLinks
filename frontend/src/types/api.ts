// ---- auth ----
export interface Me {
  memberCode: string
  name: string
  phone: string
  email?: string
  sponsorCode: string
  joinedAt: string
  isActive: boolean
  kycStatus: 'pending' | 'verified' | 'rejected'
  bankStatus: 'pending' | 'verified'
  currentRankLevel: number
  currentRankName: string
  role: 'member' | 'admin' | 'management'
  blocked?: boolean
  // KYC & bank detail fields (persisted and returned for pre-fill)
  pan?: string
  aadhaarLast4?: string
  bankAccountName?: string
  bankAccountNumber?: string
  bankIfsc?: string
}

export interface RegisterReq {
  sponsorCode: string
  name: string
  phone: string
  email: string
  password: string
}

export interface LoginReq {
  email: string
  password: string
}

export interface AuthRes {
  accessToken: string
  refreshToken: string
  member: Me
}

// ---- catalog & orders ----
export interface ProductImage {
  id: string
  key: string
  url: string
  sortOrder: number
}

// Served by both GET /products (list) and GET /products/:id (detail)
export interface Product {
  id: number
  name: string
  description: string
  basePricePaise: number
  gstPaise: number
  totalPaise: number
  badges: string[]
  images: ProductImage[]
}

export interface Order {
  orderId: string
  totalPaise: number
  status: 'created'
}

export interface OrderStatus {
  orderId: string
  status: 'created' | 'paid' | 'confirmed'
  productName: string
  totalPaise: number
}

// ---- dashboard ----
export interface DashboardCounters {
  leftActive: number
  rightActive: number
  leftQualified: number
  rightQualified: number
  /** Pairs completed anywhere in the member's subtree (own pair included). */
  pairsMatched: number
}

export interface DashboardRank {
  current: number
  currentName: string
  next: number | null
  progress: {
    leftQualified: number
    rightQualified: number
    requiredEachSide: number
  } | null
}

export interface DashboardTransaction {
  type: 'pair_bonus' | 'payout' | 'purchase' | 'sweep'
  amountPaise: number
  direction: 'credit' | 'debit'
  at: string
}

export interface Dashboard {
  totalIncomePaise: number
  pairMatchIncomePaise: number
  /** Accrued pair bonuses held until the member qualifies (3-gen gate). */
  pendingBonusPaise: number
  walletBalancePaise: number
  deferredBalancePaise: number
  counters: DashboardCounters
  /** Display-only leg imbalance; income no longer depends on leg balance. */
  carryForward: { side: 'L' | 'R'; excess: number }
  todayPairBonusPaise: number
  rank: DashboardRank
  incomeSeries: { date: string; pairPaise: number }[]
  recentTransactions: DashboardTransaction[]
}

// ---- network ----
export interface TreeNode {
  memberCode: string
  name: string
  position: 'L' | 'R' | null
  isActive: boolean
  isQualified: boolean
  left: TreeNode | null
  right: TreeNode | null
}

export interface NetworkSummary {
  totalTeam: number
  leftTeam: number
  rightTeam: number
  activeMembers: number
  qualifiedMembers: number
  directs: { left: number; right: number }
  levelDistribution: { level: number; members: number }[]
}

export interface DirectMember {
  memberCode: string
  name: string
  leg: 'L' | 'R'
  isActive: boolean
  isQualified: boolean
  joinedAt: string
}

export interface DirectsRes {
  items: DirectMember[]
  nextCursor: string | null
}

// ---- income ----
// One pair-bonus accrual: a pair that completed at pairMemberCode somewhere in
// the member's subtree. Pending until the member's own qualification.
export interface Pair {
  pairMemberCode: string
  leftMemberCode: string
  rightMemberCode: string
  bonusPaise: number
  status: 'pending' | 'released'
  at: string
}

export interface PairsRes {
  items: Pair[]
  nextCursor: string | null
}

export interface Wallet {
  balancePaise: number
  deferredPaise: number
  currentWindow: {
    start: string
    end: string
    earnedPaise: number
    capPaise: number
  }
}

export interface LedgerEntry {
  at: string
  description: string
  direction: 'credit' | 'debit'
  amountPaise: number
  refType: 'pair' | 'payout' | 'sweep' | 'manual'
}

export interface LedgerRes {
  items: LedgerEntry[]
  nextCursor: string | null
}

export interface Payout {
  date: string
  grossPaise: number
  tdsPaise: number
  netPaise: number
  status: 'pending' | 'sent' | 'settled' | 'failed'
  bankRef: string | null
}

export interface Withdrawal {
  id: string
  amountPaise: number
  status: 'pending' | 'processing' | 'done' | 'failed'
  requestedAt: string
}

// ---- ranks ----
export interface RankLevel {
  level: number
  name: string
  achieved: boolean
  achievedAt: string | null
  verificationStatus: 'pending' | 'approved' | 'rejected' | null
  requirement:
    | {
        kind: 'qualified'
        requiredEachSide: number
        leftQualified: number
        rightQualified: number
      }
    | {
        kind: 'achiever'
        requiredRank: number
        leftAchievers: number
        rightAchievers: number
      }
}

export interface RankProgress {
  levels: RankLevel[]
}

// ---- admin console ----
export interface AdminOverview {
  totalMembers: number
  activeMembers: number
  blockedMembers: number
  pendingKyc: number
  pendingRanks: number
  todayPairs: number
  todayBonusPaise: number
  openWindow: { start: string; end: string } | null
  outboxBacklog: number
  deadLetters: number
}

export interface AdminMemberRow {
  id: string
  memberCode: string
  name: string
  phone: string
  email: string | null
  isActive: boolean
  isQualified: boolean
  role: 'member' | 'admin' | 'management'
  kycStatus: 'pending' | 'verified' | 'rejected'
  bankStatus: 'pending' | 'verified'
  blocked: boolean
  createdAt: string
  hasDocuments: boolean
}

export interface AdminMembersPage {
  items: AdminMemberRow[]
  total: number
  page: number
  limit: number
}

export interface PendingRank {
  id: string
  member_id: string
  member_code: string
  name: string
  rank_level: number
  achieved_at: string
  verification_status: 'pending' | 'approved' | 'rejected'
  fulfilled_at: string | null
  fulfillment_notes: string | null
}

export interface AdminPayoutBatch {
  id: string
  scheduledFor: string
  status: 'building' | 'sent' | 'reconciled'
  createdAt: string
  items: number
  pending: number
  sent: number
  settled: number
  failed: number
  netTotalPaise: number
}

export interface AdminPayoutItem {
  id: string
  memberCode: string
  name: string
  grossPaise: number
  tdsPaise: number
  netPaise: number
  status: 'pending' | 'sent' | 'settled' | 'failed'
  bankRef: string | null
  failureReason: string | null
}

export interface DeadLetter {
  id: string
  stream: string
  consumerGroup: string
  entryId: string
  payload: string
  deliveryCount: number
  createdAt: string
}

export interface AuditRow {
  id: string
  actorId: string
  actorName: string
  action: string
  targetType: string
  targetId: string | null
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
  createdAt: string
}

export interface AdminProduct {
  id: number
  name: string
  description: string
  basePricePaise: number
  active: boolean
  images: ProductImage[]
}

// ---- uploads (S3 presigned POST) ----
export interface PresignRes {
  key: string
  url: string
  fields: Record<string, string>
}

export interface KycDocument {
  id: string
  docType: 'pan' | 'aadhaar' | 'other'
  originalName: string | null
  uploadedAt: string
  url: string
}

// ---- error ----
export interface ApiError {
  error: { code: string; message: string }
}
