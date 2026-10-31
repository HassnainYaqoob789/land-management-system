import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import domain logic directly
import { 
  validateCoOwnershipShares, 
  convertArea, 
  validateCNIC, 
  calculateFBRTax,
  PROVINCIAL_HIERARCHIES,
  amountInWords
} from '../../src/lib/domain.ts';

describe('1. Cadastral Co-Ownership 100.0% Share Balancing (REQ-01)', () => {
  it('should accept shares that sum to exactly 100.0%', () => {
    const shares = [
      { landowner_id: 'lo-1', share_pct: 50.0 },
      { landowner_id: 'lo-2', share_pct: 30.0 },
      { landowner_id: 'lo-3', share_pct: 20.0 },
    ];
    const result = validateCoOwnershipShares(shares);
    assert.equal(result.isValid, true);
    assert.equal(result.total, 100.0);
    assert.equal(result.discrepancy, 0.0);
  });

  it('should accept 3-way equal fractional shares totaling 100.0%', () => {
    const shares = [
      { landowner_id: 'lo-1', share_pct: 33.3333 },
      { landowner_id: 'lo-2', share_pct: 33.3333 },
      { landowner_id: 'lo-3', share_pct: 33.3334 },
    ];
    const result = validateCoOwnershipShares(shares);
    assert.equal(result.isValid, true);
    assert.ok(Math.abs(result.total - 100.0) < 0.0001);
  });

  it('should reject shares with a shortfall (< 100.0%)', () => {
    const shares = [
      { landowner_id: 'lo-1', share_pct: 45.0 },
      { landowner_id: 'lo-2', share_pct: 50.0 },
    ];
    const result = validateCoOwnershipShares(shares);
    assert.equal(result.isValid, false);
    assert.equal(result.total, 95.0);
    assert.equal(result.discrepancy, -5.0);
    assert.ok(result.error.includes('Under-allocated'));
  });

  it('should reject shares with an excess (> 100.0%)', () => {
    const shares = [
      { landowner_id: 'lo-1', share_pct: 60.0 },
      { landowner_id: 'lo-2', share_pct: 45.0 },
    ];
    const result = validateCoOwnershipShares(shares);
    assert.equal(result.isValid, false);
    assert.equal(result.total, 105.0);
    assert.equal(result.discrepancy, 5.0);
    assert.ok(result.error.includes('Over-allocated'));
  });

  it('should reject empty or negative share inputs', () => {
    assert.equal(validateCoOwnershipShares([]).isValid, false);
    const negativeShares = [
      { landowner_id: 'lo-1', share_pct: 120.0 },
      { landowner_id: 'lo-2', share_pct: -20.0 },
    ];
    const result = validateCoOwnershipShares(negativeShares);
    assert.equal(result.isValid, false);
    assert.ok(result.error.includes('Negative'));
  });
});

describe('2. Multi-Provincial Area Unit Conversions (REQ-04)', () => {
  it('should convert standard Pakistani units accurately', () => {
    // 1 Acre = 8 Kanals
    assert.equal(convertArea(1, 'Acre', 'Kanal'), 8);
    // 1 Acre = 160 Marlas
    assert.equal(convertArea(1, 'Acre', 'Marla'), 160);
    // 1 Acre = 4,840 Sq. Yards
    assert.equal(convertArea(1, 'Acre', 'Sq. Yards'), 4840);
    // 1 Murabba = 25 Acres
    assert.equal(convertArea(1, 'Murabba', 'Acre'), 25);
    // 1 Jareeb = 0.5 Acres
    assert.equal(convertArea(1, 'Jareeb', 'Acre'), 0.5);
  });

  it('should convert fractional areas bidirectionally', () => {
    const kanals = 16;
    const acres = convertArea(kanals, 'Kanal', 'Acre');
    assert.equal(acres, 2);
    assert.equal(convertArea(acres, 'Acre', 'Kanal'), kanals);
  });

  it('should handle zero gracefully', () => {
    assert.equal(convertArea(0, 'Acre', 'Kanal'), 0);
  });
});

describe('3. NADRA CNIC Validation (REQ-05)', () => {
  it('should validate standard NADRA format XXXXX-XXXXXXX-X', () => {
    assert.equal(validateCNIC('45501-1234567-1'), true);
    assert.equal(validateCNIC('54400-9876543-3'), true);
    assert.equal(validateCNIC('35202-5555555-5'), true);
  });

  it('should reject malformed CNIC inputs', () => {
    assert.equal(validateCNIC('4550112345671'), false); // Missing hyphens
    assert.equal(validateCNIC('45501-123456-1'), false);  // Missing digit
    assert.equal(validateCNIC('45501-1234567-12'), false); // Extra digit
    assert.equal(validateCNIC('4550A-1234567-1'), false); // Non-digit
    assert.equal(validateCNIC(''), false);
    assert.equal(validateCNIC(null), false);
  });
});

describe('4. FBR Withholding Tax (WHT) Calculations (REQ-18)', () => {
  it('should apply standard 10% rate for Active Taxpayer Filers', () => {
    const gross = 500000;
    const tax = calculateFBRTax(gross, true);
    assert.equal(tax.taxRate, 10.0);
    assert.equal(tax.taxAmount, 50000);
    assert.equal(tax.netAmount, 450000);
  });

  it('should apply punitive 2x rate (20%) for Non-Filers', () => {
    const gross = 500000;
    const tax = calculateFBRTax(gross, false);
    assert.equal(tax.taxRate, 20.0);
    assert.equal(tax.taxAmount, 100000);
    assert.equal(tax.netAmount, 400000);
  });

  it('should handle zero and edge amounts', () => {
    const tax = calculateFBRTax(0, true);
    assert.equal(tax.taxAmount, 0);
    assert.equal(tax.netAmount, 0);
  });
});

describe('5. Provincial Revenue Hierarchies (REQ-03)', () => {
  it('should verify all 4 provinces have registered hierarchies', () => {
    assert.ok(PROVINCIAL_HIERARCHIES.SND, 'Sindh exists');
    assert.ok(PROVINCIAL_HIERARCHIES.BAL, 'Balochistan exists');
    assert.ok(PROVINCIAL_HIERARCHIES.PNJ, 'Punjab exists');
    assert.ok(PROVINCIAL_HIERARCHIES.KPK, 'KP exists');
  });

  it('should verify Sindh uses Taluka and Deh tiers', () => {
    const sndTiers = PROVINCIAL_HIERARCHIES.SND.tiers;
    assert.ok(sndTiers.includes('Taluka'));
    assert.ok(sndTiers.includes('Deh'));
  });

  it('should verify Balochistan and Punjab use Tehsil and Mauza tiers', () => {
    const balTiers = PROVINCIAL_HIERARCHIES.BAL.tiers;
    const pnjTiers = PROVINCIAL_HIERARCHIES.PNJ.tiers;
    assert.ok(balTiers.includes('Tehsil'));
    assert.ok(balTiers.includes('Mauza'));
    assert.ok(pnjTiers.includes('Tehsil'));
    assert.ok(pnjTiers.includes('Mauza'));
  });
});

describe('Receipt amount in words (REQ-65)', () => {
  it('matches the client sample receipt', () => {
    assert.equal(amountInWords(111250), 'One Hundred Eleven Thousand Two Hundred Fifty');
  });
  it('states paisa and millions, and accepts numeric strings', () => {
    assert.equal(amountInWords(90000), 'Ninety Thousand');
    assert.equal(amountInWords('125000.00'), 'One Hundred Twenty Five Thousand');
    assert.equal(amountInWords(1041562.5), 'One Million Forty One Thousand Five Hundred Sixty Two and Fifty Paisa');
    assert.equal(amountInWords(0), 'Zero');
  });
  it('gives nothing for an invalid amount rather than a guess', () => {
    assert.equal(amountInWords(-5), '');
    assert.equal(amountInWords('abc'), '');
  });
});
