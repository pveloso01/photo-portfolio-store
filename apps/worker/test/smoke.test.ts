import { describe, expect, it } from 'vitest';
import { APP_NAME } from '@pkg/shared';

describe('worker smoke', () => {
  it('imports shared package', () => {
    expect(APP_NAME).toBe('photo-portfolio-store');
  });
});
