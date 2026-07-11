import { describe, it, expect } from 'vitest';
import { weekDutySlots } from './dutyWeekSlots';

describe('weekDutySlots', () => {
  it('returns exactly 12 required duty slots for a given Monday', () => {
    const slots = weekDutySlots('2026-01-05');
    
    expect(slots).toHaveLength(12);
    
    // Ensure 2 secondary slots (Monday only)
    expect(slots.filter(s => s.dutyType === 'secondary')).toHaveLength(2);
    
    // Ensure 10 primary slots (Mon-Fri)
    expect(slots.filter(s => s.dutyType === 'primary')).toHaveLength(10);
    
    // Check specific dates match Tuesday (offset 1) and Friday (offset 4)
    expect(slots.some(s => s.date === '2026-01-06')).toBe(true);
    expect(slots.some(s => s.date === '2026-01-09')).toBe(true);
  });
});