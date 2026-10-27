import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { runDailyReminderJob } from '../services/reminder.service';
import { IST_TIMEZONE } from '../utils/istDate';

/** Every morning (IST) build each shop's "Aaj ke reminders" list. Empty REMINDER_CRON turns it off. */
export function startReminderJob() {
  if (!env.REMINDER_CRON) {
    logger.info('Daily reminder job disabled (REMINDER_CRON is empty)');
    return null;
  }
  if (!cron.validate(env.REMINDER_CRON)) {
    logger.warn(`Invalid REMINDER_CRON "${env.REMINDER_CRON}"; daily reminder job not started`);
    return null;
  }
  return cron.schedule(
    env.REMINDER_CRON,
    async () => {
      const built = await runDailyReminderJob();
      logger.info(`Daily reminders built for ${built} shop(s)`);
    },
    { timezone: IST_TIMEZONE, name: 'daily-reminders', noOverlap: true },
  );
}
