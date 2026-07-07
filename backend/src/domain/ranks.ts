export interface RankDef {
  level: number
  name: string
  reward: string
}

export const RANKS: RankDef[] = [
  { level:  1, name: 'Rank 1',  reward: 'Kodaikanal tour' },
  { level:  2, name: 'Rank 2',  reward: 'Thailand tour' },
  { level:  3, name: 'Rank 3',  reward: 'Royal Enfield ₹1.5L' },
  { level:  4, name: 'Rank 4',  reward: 'Car ₹5L' },
  { level:  5, name: 'Rank 5',  reward: 'Gold ₹10L' },
  { level:  6, name: 'Rank 6',  reward: 'Gold ₹30L' },
  { level:  7, name: 'Rank 7',  reward: 'Villa ₹50L' },
  { level:  8, name: 'Rank 8',  reward: 'Luxury car ₹1Cr' },
  { level:  9, name: 'Rank 9',  reward: 'Gold ₹2.5Cr' },
  { level: 10, name: 'Rank 10', reward: 'Villa ₹6Cr' },
  { level: 11, name: 'Rank 11', reward: 'Dubai villa ₹12Cr + visa' },
  { level: 12, name: 'Rank 12', reward: 'Rolls Royce ₹25Cr + Director' },
]

// Ranks 1–4 use qualified-counter thresholds (min of L+R each side).
export const QUALIFIED_THRESHOLDS: Record<number, number> = {
  1: 25,
  2: 50,
  3: 100,
  4: 250,
}
