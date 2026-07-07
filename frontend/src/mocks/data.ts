import type {
  Me, Dashboard, TreeNode, NetworkSummary, DirectMember,
  Product, Wallet, LedgerEntry, Payout, RankLevel, Pair, Withdrawal
} from '../types/api'

export const mockMe: Me = {
  memberCode: 'AGV123456',
  name: 'Karthik Kumar',
  phone: '9876543210',
  email: 'karthik@example.com',
  sponsorCode: 'AGV100001',
  joinedAt: '2024-01-15T10:00:00.000Z',
  isActive: true,
  kycStatus: 'verified',
  bankStatus: 'pending',
  currentRankLevel: 1,
  currentRankName: 'Starter Achiever',
}

export const mockDashboard: Dashboard = {
  totalIncomePaise: 25500000,
  pairMatchIncomePaise: 21000000,
  walletBalancePaise: 1850000,
  deferredBalancePaise: 250000,
  counters: {
    leftActive: 128,
    rightActive: 112,
    leftQualified: 61,
    rightQualified: 47,
    pairsMatched: 210,
  },
  carryForward: { side: 'L', excess: 16 },
  todayPairBonusPaise: 100000,
  rank: {
    current: 1,
    currentName: 'Starter Achiever',
    next: 2,
    progress: { leftQualified: 61, rightQualified: 47, requiredEachSide: 50 },
  },
  incomeSeries: [
    { date: '2025-06-06', pairPaise: 3500000 },
    { date: '2025-06-07', pairPaise: 4200000 },
    { date: '2025-06-08', pairPaise: 5500000 },
    { date: '2025-06-09', pairPaise: 5000000 },
    { date: '2025-06-10', pairPaise: 6500000 },
    { date: '2025-06-11', pairPaise: 7200000 },
    { date: '2025-06-12', pairPaise: 8000000 },
    { date: '2025-06-13', pairPaise: 7500000 },
    { date: '2025-06-14', pairPaise: 9000000 },
    { date: '2025-06-15', pairPaise: 8500000 },
    { date: '2025-06-16', pairPaise: 10000000 },
    { date: '2025-06-17', pairPaise: 9500000 },
    { date: '2025-06-18', pairPaise: 11000000 },
    { date: '2025-06-19', pairPaise: 10500000 },
    { date: '2025-06-20', pairPaise: 12000000 },
    { date: '2025-06-21', pairPaise: 11500000 },
    { date: '2025-06-22', pairPaise: 13000000 },
    { date: '2025-06-23', pairPaise: 12500000 },
    { date: '2025-06-24', pairPaise: 14000000 },
    { date: '2025-06-25', pairPaise: 13500000 },
    { date: '2025-06-26', pairPaise: 15000000 },
    { date: '2025-06-27', pairPaise: 14500000 },
    { date: '2025-06-28', pairPaise: 16000000 },
    { date: '2025-06-29', pairPaise: 15500000 },
    { date: '2025-06-30', pairPaise: 17000000 },
    { date: '2025-07-01', pairPaise: 16500000 },
    { date: '2025-07-02', pairPaise: 18000000 },
    { date: '2025-07-03', pairPaise: 17500000 },
    { date: '2025-07-04', pairPaise: 19000000 },
    { date: '2025-07-05', pairPaise: 21000000 },
  ],
  recentTransactions: [
    { type: 'pair_bonus', amountPaise: 100000, direction: 'credit', at: '2025-07-05T10:30:00Z' },
    { type: 'pair_bonus', amountPaise: 100000, direction: 'credit', at: '2025-07-04T14:20:00Z' },
    { type: 'payout', amountPaise: 500000, direction: 'debit', at: '2025-07-03T09:00:00Z' },
    { type: 'purchase', amountPaise: 1180000, direction: 'debit', at: '2025-07-01T11:15:00Z' },
    { type: 'pair_bonus', amountPaise: 100000, direction: 'credit', at: '2025-06-30T16:45:00Z' },
    { type: 'pair_bonus', amountPaise: 100000, direction: 'credit', at: '2025-06-29T13:10:00Z' },
    { type: 'sweep', amountPaise: 250000, direction: 'debit', at: '2025-06-28T18:00:00Z' },
    { type: 'pair_bonus', amountPaise: 100000, direction: 'credit', at: '2025-06-27T12:30:00Z' },
    { type: 'pair_bonus', amountPaise: 100000, direction: 'credit', at: '2025-06-26T09:45:00Z' },
    { type: 'payout', amountPaise: 300000, direction: 'debit', at: '2025-06-25T08:00:00Z' },
  ],
}

export const mockTree: TreeNode = {
  memberCode: 'AGV123456',
  name: 'Karthik Kumar',
  position: null,
  isActive: true,
  isQualified: true,
  left: {
    memberCode: 'AGV123457',
    name: 'Priya Sharma',
    position: 'L',
    isActive: true,
    isQualified: true,
    left: {
      memberCode: 'AGV123459',
      name: 'Ravi Balan',
      position: 'L',
      isActive: true,
      isQualified: false,
      left: null,
      right: null,
    },
    right: {
      memberCode: 'AGV123460',
      name: 'Meena Devi',
      position: 'R',
      isActive: true,
      isQualified: true,
      left: null,
      right: null,
    },
  },
  right: {
    memberCode: 'AGV123458',
    name: 'Suresh Nair',
    position: 'R',
    isActive: true,
    isQualified: false,
    left: {
      memberCode: 'AGV123461',
      name: 'Lakshmi K',
      position: 'L',
      isActive: false,
      isQualified: false,
      left: null,
      right: null,
    },
    right: {
      memberCode: 'AGV123462',
      name: 'Vijay Raja',
      position: 'R',
      isActive: true,
      isQualified: false,
      left: null,
      right: null,
    },
  },
}

export const mockNetworkSummary: NetworkSummary = {
  totalTeam: 240,
  leftTeam: 128,
  rightTeam: 112,
  activeMembers: 215,
  qualifiedMembers: 108,
  directs: { left: 1, right: 1 },
  levelDistribution: [
    { level: 1, members: 2 },
    { level: 2, members: 4 },
    { level: 3, members: 8 },
    { level: 4, members: 16 },
    { level: 5, members: 32 },
    { level: 6, members: 64 },
    { level: 7, members: 80 },
    { level: 8, members: 34 },
  ],
}

export const mockDirects: DirectMember[] = [
  { memberCode: 'AGV123457', name: 'Priya Sharma', leg: 'L', isActive: true, isQualified: true, joinedAt: '2024-02-01T10:00:00Z' },
  { memberCode: 'AGV123458', name: 'Suresh Nair', leg: 'R', isActive: true, isQualified: false, joinedAt: '2024-02-05T14:30:00Z' },
]

export const mockProducts: Product[] = [
  { id: 1, name: 'Starter Pack', basePricePaise: 1000000, gstPaise: 180000, totalPaise: 1180000, badges: ['ENTRY LEVEL'] },
  { id: 2, name: 'Business Pack', basePricePaise: 2500000, gstPaise: 450000, totalPaise: 2950000, badges: ['POPULAR'] },
  { id: 3, name: 'Premium Pack', basePricePaise: 5000000, gstPaise: 900000, totalPaise: 5900000, badges: ['BEST VALUE', 'PREMIUM'] },
]

export const mockWallet: Wallet = {
  balancePaise: 1850000,
  deferredPaise: 250000,
  currentWindow: {
    start: '2025-06-29T12:30:00Z',
    end: '2025-07-05T11:59:00Z',
    earnedPaise: 9950000,
    capPaise: 10000000,
  },
}

export const mockLedger: LedgerEntry[] = [
  { at: '2025-07-05T10:30:00Z', description: 'Pair Match Bonus #210', direction: 'credit', amountPaise: 100000, refType: 'pair' },
  { at: '2025-07-04T14:20:00Z', description: 'Pair Match Bonus #209', direction: 'credit', amountPaise: 100000, refType: 'pair' },
  { at: '2025-07-03T09:00:00Z', description: 'Payout to bank', direction: 'debit', amountPaise: 500000, refType: 'payout' },
  { at: '2025-07-01T11:15:00Z', description: 'Product Purchase', direction: 'debit', amountPaise: 1180000, refType: 'manual' },
  { at: '2025-06-30T16:45:00Z', description: 'Pair Match Bonus #208', direction: 'credit', amountPaise: 100000, refType: 'pair' },
  { at: '2025-06-29T13:10:00Z', description: 'Pair Match Bonus #207', direction: 'credit', amountPaise: 100000, refType: 'pair' },
  { at: '2025-06-28T18:00:00Z', description: 'Weekly cap sweep — deferred', direction: 'debit', amountPaise: 250000, refType: 'sweep' },
  { at: '2025-06-27T12:30:00Z', description: 'Pair Match Bonus #206', direction: 'credit', amountPaise: 100000, refType: 'pair' },
  { at: '2025-06-26T09:45:00Z', description: 'Pair Match Bonus #205', direction: 'credit', amountPaise: 100000, refType: 'pair' },
  { at: '2025-06-25T08:00:00Z', description: 'Payout to bank', direction: 'debit', amountPaise: 300000, refType: 'payout' },
]

export const mockPayouts: Payout[] = [
  { date: '2025-07-05T08:00:00Z', grossPaise: 500000, tdsPaise: 25000, netPaise: 475000, status: 'settled', bankRef: 'REF20250705A' },
  { date: '2025-06-28T08:00:00Z', grossPaise: 300000, tdsPaise: 15000, netPaise: 285000, status: 'settled', bankRef: 'REF20250628B' },
  { date: '2025-06-21T08:00:00Z', grossPaise: 400000, tdsPaise: 20000, netPaise: 380000, status: 'settled', bankRef: 'REF20250621C' },
  { date: '2025-06-14T08:00:00Z', grossPaise: 200000, tdsPaise: 10000, netPaise: 190000, status: 'failed', bankRef: null },
  { date: '2025-06-07T08:00:00Z', grossPaise: 600000, tdsPaise: 30000, netPaise: 570000, status: 'settled', bankRef: 'REF20250607D' },
]

export const mockPairs: Pair[] = Array.from({ length: 20 }, (_, i) => ({
  sequenceNo: 210 - i,
  leftMemberCode: `AGV${100000 + i * 2}`,
  rightMemberCode: `AGV${100001 + i * 2}`,
  bonusPaise: 100000,
  at: new Date(Date.now() - i * 3600000 * 6).toISOString(),
}))

export const mockWithdrawals: Withdrawal[] = [
  { id: 'WD001', amountPaise: 500000, status: 'done', requestedAt: '2025-07-03T09:00:00Z' },
  { id: 'WD002', amountPaise: 300000, status: 'done', requestedAt: '2025-06-25T08:00:00Z' },
]

export const mockRanks: RankLevel[] = [
  {
    level: 1, name: 'Starter Achiever', achieved: true,
    achievedAt: '2024-06-15T00:00:00Z', verificationStatus: 'approved',
    requirement: { kind: 'qualified', requiredEachSide: 25, leftQualified: 61, rightQualified: 47 },
  },
  {
    level: 2, name: 'International Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'qualified', requiredEachSide: 50, leftQualified: 61, rightQualified: 47 },
  },
  {
    level: 3, name: 'Bike Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'qualified', requiredEachSide: 100, leftQualified: 61, rightQualified: 47 },
  },
  {
    level: 4, name: 'Car Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'qualified', requiredEachSide: 250, leftQualified: 61, rightQualified: 47 },
  },
  {
    level: 5, name: 'Gold Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 4, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 6, name: '10L Gold Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 5, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 7, name: '30L Gold Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 6, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 8, name: 'Villa Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 7, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 9, name: 'Crorepati Gold Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 8, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 10, name: 'Dubai Villa Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 9, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 11, name: 'Global Luxury Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 10, leftAchievers: 0, rightAchievers: 0 },
  },
  {
    level: 12, name: 'Royal Achiever', achieved: false,
    achievedAt: null, verificationStatus: null,
    requirement: { kind: 'achiever', requiredRank: 11, leftAchievers: 0, rightAchievers: 0 },
  },
]
