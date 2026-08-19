import { describe, it, expect } from 'vitest'
import { AddressBody, isCompleteAddress } from '../../src/lib/address.js'

describe('isCompleteAddress', () => {
  const full = {
    addr_recipient_name: 'Ravi Kumar',
    addr_phone: '9876543210',
    addr_line1: '12 Main Street',
    addr_city: 'Chennai',
    addr_state: 'Tamil Nadu',
    addr_pincode: '600001',
  }

  it('returns true when all required fields are present', () => {
    expect(isCompleteAddress(full)).toBe(true)
  })

  it('returns true even when addr_line2 is absent (optional field)', () => {
    const { ...row } = full
    expect(isCompleteAddress(row)).toBe(true)
  })

  it('returns false when any required field is null', () => {
    expect(isCompleteAddress({ ...full, addr_recipient_name: null })).toBe(false)
    expect(isCompleteAddress({ ...full, addr_phone: null })).toBe(false)
    expect(isCompleteAddress({ ...full, addr_line1: null })).toBe(false)
    expect(isCompleteAddress({ ...full, addr_city: null })).toBe(false)
    expect(isCompleteAddress({ ...full, addr_state: null })).toBe(false)
    expect(isCompleteAddress({ ...full, addr_pincode: null })).toBe(false)
  })

  it('returns false for empty strings', () => {
    expect(isCompleteAddress({ ...full, addr_recipient_name: '' })).toBe(false)
    expect(isCompleteAddress({ ...full, addr_pincode: '' })).toBe(false)
  })

  it('returns false when row is empty', () => {
    expect(isCompleteAddress({})).toBe(false)
  })
})

describe('AddressBody schema', () => {
  const valid = {
    recipientName: 'Ravi Kumar',
    phone: '9876543210',
    line1: '12 Main Street',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600001',
  }

  it('accepts valid address', () => {
    expect(AddressBody.safeParse(valid).success).toBe(true)
  })

  it('accepts address with optional line2', () => {
    expect(AddressBody.safeParse({ ...valid, line2: 'Near Bus Stand' }).success).toBe(true)
  })

  it('rejects invalid pincode (not 6 digits)', () => {
    expect(AddressBody.safeParse({ ...valid, pincode: '1234' }).success).toBe(false)
    expect(AddressBody.safeParse({ ...valid, pincode: '1234567' }).success).toBe(false)
    expect(AddressBody.safeParse({ ...valid, pincode: 'ABCDEF' }).success).toBe(false)
  })

  it('rejects empty required fields', () => {
    expect(AddressBody.safeParse({ ...valid, recipientName: '' }).success).toBe(false)
    expect(AddressBody.safeParse({ ...valid, line1: '' }).success).toBe(false)
    expect(AddressBody.safeParse({ ...valid, city: '' }).success).toBe(false)
  })

  it('rejects phone shorter than 10 chars', () => {
    expect(AddressBody.safeParse({ ...valid, phone: '98765' }).success).toBe(false)
  })
})
