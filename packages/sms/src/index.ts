/**
 * @truckdesk/sms - notification delivery.
 *
 * Push is the default and costs nothing. SMS exists behind an explicit opt-in
 * with a daily cap, because a dispatch loop on a trial balance is a way to
 * lose money by accident.
 */

export * from './types.js';
export * from './push.js';
export * from './twilio.js';
export * from './notifier.js';

export const SMS_VERSION = '1.0.0';