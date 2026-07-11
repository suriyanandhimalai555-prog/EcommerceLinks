import { describe, it, expect } from 'vitest'
import { csvQuote } from '../../src/workers/payout.js'

describe('csvQuote — RFC-4180 quoting and formula injection prevention', () => {
  it('passes through a plain alphanumeric field unchanged', () => {
    expect(csvQuote('AVG00042')).toBe('AVG00042')
  })

  it('passes through a numeric value unchanged', () => {
    expect(csvQuote(1000)).toBe('1000')
  })

  it('wraps fields containing a comma in double-quotes', () => {
    expect(csvQuote('Smith, John')).toBe('"Smith, John"')
  })

  it('doubles embedded double-quotes per RFC-4180', () => {
    expect(csvQuote('She said "hi"')).toBe('"She said ""hi"""')
  })

  it('wraps fields containing a newline in double-quotes', () => {
    expect(csvQuote('Line1\nLine2')).toBe('"Line1\nLine2"')
  })

  it('wraps fields containing a carriage-return in double-quotes', () => {
    expect(csvQuote('A\rB')).toBe('"A\rB"')
  })

  it('prefixes = with apostrophe to prevent formula injection', () => {
    expect(csvQuote('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)")
  })

  it('prefixes + with apostrophe', () => {
    expect(csvQuote('+1234567890')).toBe("'+1234567890")
  })

  it('prefixes - with apostrophe', () => {
    expect(csvQuote('-1')).toBe("'-1")
  })

  it('prefixes @ with apostrophe', () => {
    expect(csvQuote('@SUM')).toBe("'@SUM")
  })

  it('wraps a formula-prefixed field that also contains a comma', () => {
    // First prefix is added, then the comma triggers quoting
    expect(csvQuote('=A,B')).toBe("\"'=A,B\"")
  })
})
