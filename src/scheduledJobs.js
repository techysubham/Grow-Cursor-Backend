import cron from 'node-cron';
import Attendance from './models/Attendance.js';
import { runScheduledUploads } from './lib/ebayFeedUpload.js';

export function initializeScheduledJobs() {
    // Auto-stop all active timers daily at 2:00 AM
    cron.schedule('0 2 * * *', async () => {
        try {
            console.log('[CRON] Running daily timer auto-stop at 2:00 AM...');

            // Find all active attendance records
            const activeRecords = await Attendance.find({ status: 'active' });

            let stoppedCount = 0;

            for (const attendance of activeRecords) {
                // Stop the last active session
                if (attendance.sessions.length > 0) {
                    const lastSession = attendance.sessions[attendance.sessions.length - 1];
                    if (!lastSession.endTime) {
                        lastSession.endTime = new Date();
                    }
                }

                attendance.status = 'completed';
                attendance.calculateTotalWorkTime();
                await attendance.save();

                stoppedCount++;
            }

            console.log(`[CRON] Auto-stopped ${stoppedCount} active timer(s)`);
        } catch (error) {
            console.error('[CRON] Error in auto-stop job:', error);
        }
    }, {
        timezone: 'Asia/Kolkata' // IST timezone
    });

    console.log('[CRON] Scheduled job initialized: Daily timer auto-stop at 2:00 AM IST');

    // Auto-upload scheduled CSVs — runs every minute
    cron.schedule('* * * * *', async () => {
        try {
            await runScheduledUploads();
        } catch (error) {
            console.error('[CRON] Error in scheduled upload job:', error);
        }
    });

    console.log('[CRON] Scheduled job initialized: Auto-upload CSV (every minute)');
}
