import { ExactDecimal as D } from '../../src/pricing/exact-decimal';
import { legacyNumberToDecimal } from '../../src/pricing/legacy-pricing-adapter';

describe('pricing exact decimal', () => {
  it('retains exact fractions for recurring minute rates', () => {
    expect(D.parse('61').divide(D.parse('60')).multiply(D.parse('0.06')).toFixed(9)).toBe(
      '0.061000000',
    );
    expect(D.one.divide(D.parse('3')).multiply(D.parse('3')).compare(D.one)).toBe(0);
    expect(D.parse('0.1').add(D.parse('0.2')).toFixed(1)).toBe('0.3');
  });

  it.each([
    ['2.5', 'half_even', '2'],
    ['3.5', 'half_even', '4'],
    ['-2.5', 'half_even', '-2'],
    ['-3.5', 'half_even', '-4'],
    ['2.5', 'half_up', '3'],
    ['-2.5', 'half_up', '-3'],
    ['-1.1', 'ceil', '-1'],
    ['-1.1', 'floor', '-2'],
    ['1.1', 'ceil', '2'],
    ['1.1', 'floor', '1'],
    ['0.000', 'ceil', '0'],
  ] as const)('rounds %s with %s to %s', (input, mode, expected) => {
    expect(D.parse(input).toFixed(0, mode)).toBe(expected);
  });

  it('rounds quantities at an explicit increment', () => {
    expect(D.parse('61').roundToIncrement(D.parse('60'), 'ceil').toFixed(0)).toBe('120');
    expect(D.parse('6.4').roundToIncrement(D.one, 'ceil').toFixed(0)).toBe('7');
    expect(D.parse('6.4').roundToIncrement(D.parse('0.5'), 'ceil').toFixed(1)).toBe('6.5');
  });

  it.each([
    '',
    ' ',
    '1e6',
    '+1',
    'NaN',
    'Infinity',
    '1,000',
    '.1',
    '1.',
    '0x10',
    '1'.repeat(31),
    '0.' + '1'.repeat(19),
  ])('rejects invalid or unbounded input %s', (input) => {
    expect(() => D.parse(input)).toThrow();
  });

  it('supports large exact integers and serializable fractions', () => {
    const value = D.parse('9007199254740993');
    expect(value.add(D.one).toFixed(0)).toBe('9007199254740994');
    expect(value.divide(D.parse('2')).toFraction()).toEqual({
      numerator: '9007199254740993',
      denominator: '2',
    });
  });

  it('rejects zero denominators and invalid precision', () => {
    expect(() => D.one.divide(D.zero)).toThrow('Division by zero');
    expect(() => D.one.roundToIncrement(D.zero, 'ceil')).toThrow();
    expect(() => D.one.toFixed(19)).toThrow();
    expect(() => D.one.toFixed(1.5)).toThrow();
  });

  it('expands only legacy numeric exponent representations without binary rounding artifacts', () => {
    expect(legacyNumberToDecimal(1e-7)).toBe('0.0000001');
    expect(legacyNumberToDecimal(1.234e-7)).toBe('0.0000001234');
    expect(legacyNumberToDecimal(1e21)).toBe('1000000000000000000000');
    expect(legacyNumberToDecimal(0.1)).toBe('0.1');
    expect(() => legacyNumberToDecimal(1e-19)).toThrow();
    expect(() => legacyNumberToDecimal(NaN)).toThrow();
    expect(() => legacyNumberToDecimal(-1)).toThrow();
  });
});
