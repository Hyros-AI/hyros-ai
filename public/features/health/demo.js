/**
 * Demo block for Tracking Health — the shape server.js produces, with every
 * check completed (`checks.*.status === 'ok'`) so the view's happy path is
 * exercised on the Demo account. Fixed values, no clock beyond today's date
 * (like the Scale demo), so two runs are byte-identical.
 */
import { ymd } from '../../demo.js';

export function demo() {
  return {
    checkedAt: `${ymd(new Date())}T08:00:00.000Z`,
    domains: ['data.scale-ecom.com', 'track.scale-ecom.co.uk'],
    sites: [
      { url: 'https://scale-ecom.com/', trackingDomain: 'data.scale-ecom.com' },
      { url: 'https://scale-ecom.co.uk/', trackingDomain: 'track.scale-ecom.co.uk' },
      { url: 'https://www.scale-ecom.com/', trackingDomain: 'data.scale-ecom.com' },
      { url: 'https://www.scale-ecom.co.uk/', trackingDomain: 'track.scale-ecom.co.uk' },
    ],
    scripts: {
      'https://scale-ecom.com/': 'SCRIPT_FOUND',
      'https://scale-ecom.co.uk/': 'SCRIPT_NOT_FOUND',
      'https://www.scale-ecom.com/': 'SCRIPT_FOUND',
      'https://www.scale-ecom.co.uk/': 'SCRIPT_NOT_FOUND',
    },
    visitedHosts: [],
    trackingParams: [{
      type: 'SEARCH',
      rows: [
        { adName: 'Brand Exact — RSA 1', valid: true },
        { adName: 'Brand + Reviews — RSA 2', valid: true },
        { adName: 'Category Exact — RSA 4', valid: false, missing: ['gclid'] },
      ],
    }, { type: 'PERFORMANCE_MAX', rows: [{ adName: 'PMax — Best Sellers', valid: true }] }],
    errors: [],
    checks: {
      domains: { status: 'ok', ms: 412 },
      params: { status: 'ok', ms: 1730, channels: { SEARCH: 'ok', PERFORMANCE_MAX: 'ok' } },
      script: { status: 'ok', ms: 21880 },
      visits: { status: 'empty', ms: 640 },
    },
  };
}
