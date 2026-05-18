import { APP_NAME } from '@pkg/shared';
import { describe, expect, it } from 'vitest';

describe('worker smoke', () => {
  it('imports shared package', () => {
    expect(APP_NAME).toBe('photo-portfolio-store');
  });
});
