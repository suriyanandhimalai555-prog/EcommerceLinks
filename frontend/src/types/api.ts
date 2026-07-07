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
}

export interface RegisterReq {
  sponsorCode: string
  preferredLeg: 'L' | 'R'
  name: string
  phone: string
  email?: string
  password: string
}

export interface LoginReq {
  phone: string
  password: string
}

export interface AuthRes {
  accessToken: string
  refreshToken: string
  member: Me
}

// ---- catalog & orders ----
export interface Product {
  id: number
  name: string
  basePricePaise: number
  gstPaise: number
  totalPaise: number
  badges: string[]
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
  walletBalancePaise: number
  deferredBalancePaise: number
  counters: DashboardCounters
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
export interface Pair {
  sequenceNo: number
  leftMemberCode: string
  rightMemberCode: string
  bonusPaise: number
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

// ---- error ----
export interface ApiError {
  error: { code: string; message: string }
}
