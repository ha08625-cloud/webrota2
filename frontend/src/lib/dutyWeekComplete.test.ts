import { describe, it, expect } from 'vitest';
import { isDutyWeekComplete } from './dutyWeekComplete';
import { makeDutyAssignment, makeFullDayClosure } from '../test/fixtures/reference';

describe('isDutyWeekComplete', () => {
  const MONDAY = '2026-01-05';
  
  // Helper to generate the baseline 12 passing slots
  const generateCompleteSet = () => [
    makeDutyAssignment({ date: MONDAY, period: 'AM', duty_type: 'primary' }),
    makeDutyAssignment({ date: MONDAY, period: 'PM', duty_type: 'primary' }),
    makeDutyAssignment({ date: MONDAY, period: 'AM', duty_type: 'secondary' }),
    makeDutyAssignment({ date: MONDAY, period: 'PM', duty_type: 'secondary' }),
    makeDutyAssignment({ date: '2026-01-06', period: 'AM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-06', period: 'PM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-07', period: 'AM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-07', period: 'PM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-08', period: 'AM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-08', period: 'PM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-09', period: 'AM', duty_type: 'primary' }),
    makeDutyAssignment({ date: '2026-01-09', period: 'PM', duty_type: 'primary' }),
  ];

  it('returns true when all 12 slots are filled', () => {
    expect(isDutyWeekComplete(MONDAY, generateCompleteSet())).toBe(true);
  });

  it('returns false when 11 of 12 slots are filled (missing Tue PM primary)', () => {
    const assignments = generateCompleteSet().filter(
      a => !(a.date === '2026-01-06' && a.period === 'PM')
    );
    expect(isDutyWeekComplete(MONDAY, assignments)).toBe(false);
  });

  it('returns false for the counting-defeater (10 primary, 2 secondary, but wrong days)', () => {
    const assignments = generateCompleteSet().filter(
      a => !(a.date === '2026-01-08' && a.period === 'AM') // Missing Thursday AM
    );
    // Add a stray Saturday primary to bring the counts back to 10/2
    assignments.push(makeDutyAssignment({ date: '2026-01-10', period: 'AM', duty_type: 'primary' }));
    
    expect(isDutyWeekComplete(MONDAY, assignments)).toBe(false);
  });

  it('returns true when a legacy off-Monday secondary is present alongside a complete week', () => {
    const assignments = generateCompleteSet();
    assignments.push(makeDutyAssignment({ date: '2026-01-06', period: 'AM', duty_type: 'secondary' }));
    expect(isDutyWeekComplete(MONDAY, assignments)).toBe(true);
  });

  it('returns false when a legacy off-Monday secondary is present but a Monday secondary is missing', () => {
    const assignments = generateCompleteSet().filter(
      a => !(a.date === MONDAY && a.period === 'AM' && a.duty_type === 'secondary')
    );
    assignments.push(makeDutyAssignment({ date: '2026-01-06', period: 'AM', duty_type: 'secondary' }));
    expect(isDutyWeekComplete(MONDAY, assignments)).toBe(false);
  });

  it('returns false for an empty assignment list', () => {
    expect(isDutyWeekComplete(MONDAY, [])).toBe(false);
  });

  it('a closed Monday needs no Monday assignments at all to read as complete', () => {
    // Monday closed: required slots are Tue(1st+2nd) + Wed + Thu + Fri = 10.
    const assignments = [
      makeDutyAssignment({ date: '2026-01-06', period: 'AM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-06', period: 'PM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-06', period: 'AM', duty_type: 'secondary' }),
      makeDutyAssignment({ date: '2026-01-06', period: 'PM', duty_type: 'secondary' }),
      makeDutyAssignment({ date: '2026-01-07', period: 'AM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-07', period: 'PM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-08', period: 'AM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-08', period: 'PM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-09', period: 'AM', duty_type: 'primary' }),
      makeDutyAssignment({ date: '2026-01-09', period: 'PM', duty_type: 'primary' }),
    ];
    const closures = makeFullDayClosure({ date: MONDAY });

    expect(isDutyWeekComplete(MONDAY, assignments, closures)).toBe(true);
  });

  it('a fully closed week is complete with zero assignments', () => {
    const closures = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].flatMap((date) =>
      makeFullDayClosure({ date }),
    );
    expect(isDutyWeekComplete(MONDAY, [], closures)).toBe(true);
  });
});