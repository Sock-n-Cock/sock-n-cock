import { describe, it, expect, vi } from 'vitest';
import { generateSafeId, getTrimmedLogs, generateUserCredentials } from '../utils';

describe('App Utilities', () => {

  it('1. generateSafeId should strip all non-alphanumeric characters', () => {
    const rawId = 'User_123!@#$%-test';
    const safeId = generateSafeId(rawId);

    expect(safeId).toBe('User123test');
    expect(generateSafeId('---')).toBe('');
  });

  it('2. getTrimmedLogs should prepend new logs and enforce max length', () => {
    const mockDate = new Date('2026-04-22T17:51:52');
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);

    const initialLogs = ['17:50:00 - User left: abcd', '17:49:00 - Connected to server'];
    const newLogs = getTrimmedLogs('Remote edit: xyz', initialLogs, 3);

    expect(newLogs.length).toBe(3);
    expect(newLogs[0]).toContain('Remote edit: xyz');
    expect(newLogs[0]).toContain(mockDate.toLocaleTimeString());

    const overflowLogs = getTrimmedLogs('Another edit', newLogs, 3);
    expect(overflowLogs.length).toBe(3);
    expect(overflowLogs[2]).toBe('17:50:00 - User left: abcd');

    vi.useRealTimers();
  });

  it('3. generateUserCredentials should generate valid hex colors and names', () => {
    const user = generateUserCredentials();

    expect(user.name).toMatch(/^User_\d+$/);
    expect(user.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});