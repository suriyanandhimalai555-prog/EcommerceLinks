export interface BankAccount {
  bank: string
  accountName: string
  accountNo: string
  ifsc: string
}

/** Company bank accounts for offline payment. Members transfer here and upload proof. */
export const BANK_ACCOUNTS: BankAccount[] = [
  {
    bank: 'Federal Bank',
    accountName: 'AGILAVETRI PROMOTERS PRIVATE LIMITED',
    accountNo: '23950200001906',
    ifsc: 'FDRL0002395',
  },
  {
    bank: 'Axis Bank',
    accountName: 'AGILAVETRI PROMOTERS PRIVATE LIMITED',
    accountNo: '924020021267728',
    ifsc: 'UTIB0001191',
  },
  {
    bank: 'HDFC Bank',
    accountName: 'AGILAVETRI PROMOTORS PRIVATE LIMITED',
    accountNo: '99999786786919',
    ifsc: 'HDFC0002633',
  },
]
