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
  bankStatus: 'pending' | 'verified' | 'rejected'
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
  /** Whether KYC is currently required before a purchase. Driven by the
   *  management-controlled kyc_optional system setting (false = mandatory). */
  kycMandatory?: boolean
  /** Server-side "notifications last seen" ISO timestamp. null = never seen.
   *  Drives the bell's unread count so read-state is consistent across devices. */
  notificationsSeenAt?: string | null
}

// ---- system settings (management) ----
export interface SystemSettings {
  /** When true, KYC is optional for purchases (payout still requires verified KYC+bank). */
  kycOptional: boolean
  /** When true, a welcome email is sent to new members upon registration. */
  welcomeEmailEnabled: boolean
  /** When true, every login requires a 6-digit OTP sent to the member's email. */
  loginOtpEnabled: boolean
  /** When true, registration requires email-OTP verification before the account is created. */
  registerOtpEnabled: boolean
}

/** Returned by POST /auth/register or POST /auth/login when OTP is required. */
export interface OtpChallenge {
  otpRequired: true
}

export interface RegisterReq {
  sponsorCode: string
  name: string
  phone: string
  email: string
  password: string
  /** Optional placement side from a leg-specific referral link; omit for auto L-then-R. */
  leg?: 'L' | 'R'
}

/** Sent to POST /auth/register/verify-otp — full signup payload + OTP code. */
export type RegisterVerifyReq = RegisterReq & { otp: string }

export interface LoginReq {
  email: string
  password: string
}

export interface AuthRes {
  accessToken: string
  refreshToken: string
  member: Me
}

export interface ForgotPasswordReq {
  email: string
}

export interface ResetPasswordReq {
  email: string
  otp: string
  newPassword: string
}

// ---- catalog & orders ----
export interface ProductImage {
  id: string
  key: string
  url: string
  sortOrder: number
}

// PDF attachments (datasheets/brochures). Only returned by GET /products/:id.
export interface ProductDocument {
  id: string
  name: string
  url: string
  sortOrder: number
}

// Served by both GET /products (list) and GET /products/:id (detail).
// `documents` is populated on the detail endpoint only.
export interface Product {
  id: number
  name: string
  description: string
  basePricePaise: number
  gstPaise: number
  totalPaise: number
  badges: string[]
  images: ProductImage[]
  documents?: ProductDocument[]
}

export interface Order {
  orderId: string
  totalPaise: number
  status: 'created'
}

export interface MyOrder {
  orderId: string
  productId: number
  productName: string
  totalPaise: number
  status: 'created' | 'paid' | 'confirmed' | 'rejected' | 'failed' | 'refunded'
  createdAt: string
  rejectionReason?: string
  paymentRef?: string
  confirmedAt?: string
  paymentProofUrls?: string[]
}

export interface OrderStatus {
  orderId: string
  status: 'created' | 'paid' | 'confirmed' | 'rejected'
  productName: string
  totalPaise: number
  rejectionReason?: string
}

// ---- admin: pending orders ----
export interface AdminOrder {
  orderId: string
  memberCode: string
  memberName: string
  productId: number
  productName: string
  totalPaise: number
  status: string
  createdAt: string
  paymentRef?: string
  confirmedAt?: string
  /** Raw S3 keys for uploaded payment-proof screenshots — used by the edit modal to diff additions/removals. */
  paymentProofKeys?: string[]
  /** Short-lived presigned GET URLs for uploaded payment-proof screenshots (status=paid only). */
  paymentProofUrls?: string[]
}

// ---- dashboard ----
export interface DashboardCounters {
  leftActive: number
  rightActive: number
  leftQualified: number
  rightQualified: number
  /** Pairs matched at this member's own node (v2: LEAST(leftActive, rightActive)). */
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
  type: 'pair_bonus' | 'payout' | 'purchase' | 'sweep' | 'withdrawal'
  amountPaise: number
  direction: 'credit' | 'debit'
  at: string
}

export interface Dashboard {
  /** Sum of all pair bonuses ever released — the all-time earned total. */
  lifetimeEarnedPaise: number
  totalIncomePaise: number
  pairMatchIncomePaise: number
  /** Accrued pair bonuses held until the member qualifies (3-gen gate). */
  pendingBonusPaise: number
  walletBalancePaise: number
  deferredBalancePaise: number
  /** Balance in the withdrawable wallet (swept from earnings at each cutoff). */
  withdrawablePaise: number
  counters: DashboardCounters
  /** Leg carry-forward surplus. Leg balance is the sole income driver (v2). excess=0 means equal legs. */
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

// One member of the caller's placement subtree (GET /network/downline).
export interface DownlineMember {
  memberCode: string
  name: string
  /** Placement-tree depth below the caller (1 = direct placement child). */
  level: number
  /** Which of the caller's legs this member sits under. */
  leg: 'L' | 'R'
  isActive: boolean
  isQualified: boolean
  joinedAt: string
}

export interface DownlinePage {
  items: DownlineMember[]
  total: number
  page: number
  limit: number
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
  /** Balance in the withdrawable wallet. Swept from earnings at each weekly cutoff. */
  withdrawablePaise: number
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
  refType: 'pair' | 'payout' | 'sweep' | 'wsweep' | 'withdrawal' | 'manual'
}

export interface LedgerRes {
  items: LedgerEntry[]
  nextCursor: string | null
}

export interface Payout {
  date: string
  grossPaise: number
  /** null until the payout is actually paid (TDS is computed at payment). */
  tdsPaise: number | null
  netPaise: number | null
  status: 'pending' | 'requested' | 'approved' | 'rejected' | 'paid'
  bankRef: string | null
}

export interface Withdrawal {
  id: string
  amountPaise: number
  tdsPaise: number | null
  netPaise: number | null
  status: 'pending' | 'requested' | 'approved' | 'rejected' | 'paid'
  requestedAt: string
  processedAt: string | null
  /** Presigned GET URLs for proof screenshots management uploaded (paid rows only). */
  proofUrls?: string[]
}

export interface WithdrawalsRes {
  items: Withdrawal[]
}

export interface AdminWithdrawal {
  id: string
  memberCode: string
  memberName: string
  kycStatus: string
  bankStatus: string
  amountPaise: number
  tdsPaise: number | null
  netPaise: number | null
  status: 'pending' | 'requested' | 'approved' | 'rejected' | 'paid'
  requestedAt: string
  processedAt: string | null
  notes: string | null
  /** Presigned GET URLs for proof screenshots (paid rows only). */
  proofUrls?: string[]
  /** Week linkage — null for legacy manual withdrawals. */
  sourceCutoffId: string | null
  weekStart: string | null
  weekEnd: string | null
}

export interface AdminWithdrawalsPage {
  items: AdminWithdrawal[]
  total: number
  page: number
  limit: number
}

export interface AdminWithdrawalWeek {
  cutoffId: string
  weekStart: string
  weekEnd: string
  pendingCount: number
  pendingTotalPaise: number
  paidTotalPaise: number
}

export interface AdminWithdrawalWeeksRes {
  weeks: AdminWithdrawalWeek[]
  /** Global totals over ALL withdrawals (incl. NULL-cutoff rows), role<>management. */
  totals: {
    paidPaise: number
    pendingPaise: number
    pendingCount: number
  }
}

export interface AdminWithdrawalExportRow {
  memberCode: string
  memberName: string
  amountPaise: number
  tdsPaise: number | null
  netPaise: number | null
  status: string
  requestedAt: string
  processedAt: string | null
  weekStart: string | null
  weekEnd: string | null
  bankRef: string | null
  notes: string | null
}

export interface AdminWithdrawalExport {
  rows: AdminWithdrawalExportRow[]
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
  bankStatus: 'pending' | 'verified' | 'rejected'
  blocked: boolean
  createdAt: string
  hasDocuments: boolean
  /** Sponsor (who referred this member). Null for the tree root and management. */
  sponsorCode: string | null
  sponsorName: string | null
}

export interface AdminMembersPage {
  items: AdminMemberRow[]
  total: number
  page: number
  limit: number
}

/** Identity + bank details a member submitted, shown in the KYC review modal. */
export interface AdminKycDetail {
  pan?: string
  aadhaarLast4?: string
  bankAccountName?: string
  bankAccountNumber?: string
  bankIfsc?: string
  bankStatus: 'pending' | 'verified' | 'rejected'
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

export interface RanksPage {
  ranks: PendingRank[]
  total: number
  page: number
  limit: number
}

export interface RankSummaryRow {
  rank_level: number
  pending: number
  approved: number
  received: number
  rejected: number
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

// Admin editing needs the S3 key + original name for each document so the
// uploader can round-trip the current set on edit.
export interface AdminProductDocument {
  id: string
  key: string
  name: string
  url: string
  sortOrder: number
}

export interface AdminProduct {
  id: number
  name: string
  description: string
  basePricePaise: number
  active: boolean
  images: ProductImage[]
  documents: AdminProductDocument[]
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

// ---- admin: earnings report ----
export interface AdminEarningsRow {
  id: string
  memberCode: string
  name: string
  kycStatus: string
  bankStatus: string
  netEarnedPaise: number
  pairsMatched: number
  withdrawnPaise: number
}

export interface AdminEarningsPage {
  items: AdminEarningsRow[]
  total: number
  page: number
  limit: number
  /** Global grand totals over the current filtered set (all matching members). */
  totals: {
    netEarnedPaise: number
    pairsMatched: number
    withdrawnPaise: number
  }
}

export interface AdminEarningsDetail {
  id: string
  memberCode: string
  name: string
  isActive: boolean
  isQualified: boolean
  /** Amount that actually landed in wallet after the weekly cap */
  netEarnedPaise: number
  /** Total pair bonuses generated (may exceed net due to cap forfeiture) */
  grossEarnedPaise: number
  /** grossEarned − netEarned: bonuses forfeited due to the ₹1 lakh weekly cap */
  forfeitedPaise: number
  /** Number of pair events this member benefited from (as beneficiary in pair_accruals) */
  pairsMatched: number
  /** Gross withdrawal amount for paid withdrawals */
  withdrawnGrossPaise: number
  /** Post-TDS net withdrawal amount for paid withdrawals */
  withdrawnNetPaise: number
  withdrawalCount: number
  /** Amount held in-flight for requested (not yet paid) withdrawals */
  pendingWithdrawalPaise: number
}

export interface AdminCutoff {
  id: string
  windowStart: string
  windowEnd: string
  status: 'open' | 'closed' | 'paid'
}

export interface AdminEarningsExportRow {
  memberCode: string
  name: string
  earnedPaise: number
  kycStatus: string
  bankStatus: string
  bankAccountName: string
  bankAccountNumber: string
  bankIfsc: string
}

export interface AdminEarningsExport {
  cutoffId: string
  windowStart: string
  windowEnd: string
  status: string
  verification: string
  rows: AdminEarningsExportRow[]
}

// ---- admin: all-orders list (management-only export view) ----
export interface AdminAllOrderRow {
  orderId: string
  memberCode: string
  memberName: string
  memberPhone: string
  productId: number
  productName: string
  totalPaise: number
  status: 'created' | 'paid' | 'confirmed' | 'rejected' | 'failed' | 'refunded'
  paymentRef?: string
  rejectionReason?: string
  createdAt: string
  confirmedAt?: string
}

export interface AdminOrdersPage {
  items: AdminAllOrderRow[]
  total: number
  page: number
  limit: number
}

// ---- management: on-behalf payment ----
export interface OnBehalfRes {
  ok: boolean
  /** The order that was created or reused. */
  orderId: string
  /** True when this call was the one that set the member's is_active to TRUE. */
  activated: boolean
}

// ---- error ----
export interface ApiError {
  error: { code: string; message: string }
}
