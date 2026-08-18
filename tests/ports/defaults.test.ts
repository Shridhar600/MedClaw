import { systemClock, uuidIdGen, SystemClock, CryptoIdGen } from '../../src/ports';

describe('ports default instances', () => {
  it('exposes a shared systemClock whose now() returns a Date', () => {
    expect(systemClock).toBeInstanceOf(SystemClock);
    const t = systemClock.now();
    expect(t).toBeInstanceOf(Date);
    expect(Number.isNaN(t.getTime())).toBe(false);
  });

  it('exposes a shared uuidIdGen whose newId() returns a v4-shaped id', () => {
    expect(uuidIdGen).toBeInstanceOf(CryptoIdGen);
    const id = uuidIdGen.newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates distinct ids on successive calls', () => {
    expect(uuidIdGen.newId()).not.toBe(uuidIdGen.newId());
  });
});
