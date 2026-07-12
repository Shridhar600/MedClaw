import { randomUUID } from 'crypto';
import type { Clock } from './clock';
import type { IdGen } from './id-gen';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class CryptoIdGen implements IdGen {
  newId(): string {
    return randomUUID();
  }
}
