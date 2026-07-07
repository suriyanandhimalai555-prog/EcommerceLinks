export const statsData = [
  {
    id: 'total-income',
    label: 'TOTAL INCOME',
    value: '₹ 2,55,000',
    sub: 'Total Earnings',
    color: '#1E3A8A',
    bg: '#EFF6FF',
    icon: 'wallet',
  },
  {
    id: 'pair-match',
    label: 'PAIR MATCH INCOME',
    value: '₹ 2,10,000',
    sub: 'This Month',
    color: '#16A34A',
    bg: '#F0FDF4',
    icon: 'network',
  },
  {
    id: 'direct-income',
    label: 'DIRECT INCOME',
    value: '₹ 45,000',
    sub: 'This Month',
    color: '#EA580C',
    bg: '#FFF7ED',
    icon: 'users',
  },
  {
    id: 'wallet-balance',
    label: 'WALLET BALANCE',
    value: '₹ 18,500',
    sub: 'Available Balance',
    color: '#7C3AED',
    bg: '#F5F3FF',
    icon: 'credit-card',
  },
]

export const pairMatchData = [
  { label: 'Total Pair', value: '210', icon: 'pair', isAmount: false },
  { label: 'Completed Pair', value: '185', icon: 'check', isAmount: false },
  { label: 'Uncompleted Pair', value: '25', icon: 'gift', isAmount: false },
  { label: 'Carry Forward', value: '₹ 25,000', icon: 'forward', isAmount: true },
  { label: "Today's Pair Bonus", value: '₹ 1,000', icon: 'bonus', isAmount: true },
]

export const teamStats = [
  { label: 'LEFT TEAM', value: '128', sub: 'Members', icon: 'users-left' },
  { label: 'RIGHT TEAM', value: '112', sub: 'Members', icon: 'users-right' },
  { label: 'TOTAL TEAM', value: '240', sub: 'Members', icon: 'users-total' },
  { label: 'ACTIVE MEMBERS', value: '215', sub: 'Members', icon: 'user-check' },
]

export const incomeChartData = [
  { date: '01 May', pairMatch: 35000, direct: 18000, other: 8000 },
  { date: '05 May', pairMatch: 42000, direct: 22000, other: 10000 },
  { date: '10 May', pairMatch: 55000, direct: 28000, other: 12000 },
  { date: '15 May', pairMatch: 50000, direct: 32000, other: 14000 },
  { date: '20 May', pairMatch: 65000, direct: 38000, other: 18000 },
  { date: '25 May', pairMatch: 72000, direct: 45000, other: 22000 },
  { date: '31 May', pairMatch: 80000, direct: 55000, other: 28000 },
]

export const recentTransactions = [
  {
    id: 1,
    name: 'Pair Match Bonus',
    date: '01 Jun 2025, 10:30 AM',
    amount: '+₹1,000',
    type: 'Credit',
    positive: true,
    icon: 'pair-match',
    color: '#16A34A',
    bg: '#F0FDF4',
  },
  {
    id: 2,
    name: 'Direct Bonus',
    date: '01 Jun 2025, 10:15 AM',
    amount: '+₹500',
    type: 'Credit',
    positive: true,
    icon: 'direct',
    color: '#EA580C',
    bg: '#FFF7ED',
  },
  {
    id: 3,
    name: 'Product Purchase',
    date: '31 May 2025, 04:30 PM',
    amount: '-₹10,000',
    type: 'Debit',
    positive: false,
    icon: 'product',
    color: '#DC2626',
    bg: '#FEF2F2',
  },
  {
    id: 4,
    name: 'Withdrawal Request',
    date: '30 May 2025, 11:20 AM',
    amount: '-₹5,000',
    type: 'Debit',
    positive: false,
    icon: 'withdrawal',
    color: '#DC2626',
    bg: '#FEF2F2',
  },
]

export const quickLinks = [
  { label: 'Buy New Product', icon: 'shopping-bag', path: '/buy-product' },
  { label: 'My Genealogy Tree', icon: 'git-fork', path: '/genealogy' },
  { label: 'Direct Members', icon: 'users', path: '/direct-members' },
  { label: 'Income Report', icon: 'bar-chart', path: '/income-report' },
  { label: 'Payout History', icon: 'clock', path: '/payout-history' },
  { label: 'Support Center', icon: 'help-circle', path: '/support' },
]

export const profileQuickLinks = [
  { label: 'My Network', icon: 'network', path: '/network' },
  { label: 'My Genealogy Tree', icon: 'git-fork', path: '/genealogy' },
  { label: 'Direct Members', icon: 'users', path: '/direct-members' },
  { label: 'Payout History', icon: 'clock', path: '/payout-history' },
  { label: 'Support Center', icon: 'help-circle', path: '/support' },
]

export const verificationData = [
  { label: 'Email Verified', status: 'verified' },
  { label: 'Mobile Verified', status: 'verified' },
  { label: 'KYC Verified', status: 'verified' },
  { label: 'Bank Verified', status: 'pending' },
]

export const accountSummary = [
  { label: 'Total Income', value: '₹ 2,55,000', highlight: true },
  { label: 'Pair Match Income', value: '₹ 2,10,000', highlight: true },
  { label: 'Direct Income', value: '₹ 45,000', highlight: true },
  { label: 'Wallet Balance', value: '₹ 18,500', highlight: true },
  { label: 'Total Members', value: '240', highlight: false },
]

export const recentActivities = [
  {
    id: 1,
    name: 'Pair Match Bonus',
    date: '01 Jun 2025, 10:30 AM',
    amount: '+ ₹ 1,000',
    positive: true,
    color: '#16A34A',
    bg: '#F0FDF4',
  },
  {
    id: 2,
    name: 'Direct Bonus',
    date: '01 Jun 2025, 10:15 AM',
    amount: '+ ₹ 500',
    positive: true,
    color: '#EA580C',
    bg: '#FFF7ED',
  },
  {
    id: 3,
    name: 'Product Purchase',
    date: '31 May 2025, 04:30 PM',
    amount: '- ₹ 10,000',
    positive: false,
    color: '#DC2626',
    bg: '#FEF2F2',
  },
  {
    id: 4,
    name: 'Withdrawal Request',
    date: '30 May 2025, 11:20 AM',
    amount: '- ₹ 5,000',
    positive: false,
    color: '#DC2626',
    bg: '#FEF2F2',
  },
]
