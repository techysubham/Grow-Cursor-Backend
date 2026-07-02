import { Router } from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import Attendance from '../models/Attendance.js';
import User from '../models/User.js';
import { validate } from '../utils/validate.js';
import { editAttendanceHoursSchema } from '../schemas/index.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Attendance
 *   description: Working hours tracking — start, pause, resume, stop timer and reporting
 */

// Nomenclature note:
// This route file uses the legacy name `attendance` for compatibility,
// but the feature behavior is WORKING HOURS TRACKING (start/pause/resume/stop timer + reports).

// Helper function to get today's date string (YYYY-MM-DD) in IST
function getTodayDateString() {
    // Get current time in Indian Standard Time to avoid UTC rollover bugs early in the morning
    const istString = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const istDate = new Date(istString);
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * @swagger
 * /attendance/start:
 *   post:
 *     tags: [Attendance]
 *     summary: Start or restart the working-hours timer
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Creates or updates today's attendance record and starts the timer.
 *       If the timer was previously stopped or paused, calling start again resumes a new session.
 *     responses:
 *       200: { description: Updated attendance record }
 *       401: { description: Unauthorized }
 */
// POST /start - Start or restart timer
router.post('/start', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const today = getTodayDateString();

        // Find or create today's attendance record
        let attendance = await Attendance.findOne({ user: userId, date: today });

        const now = new Date();

        if (!attendance) {
            // Create new attendance record for today
            attendance = await Attendance.create({
                user: userId,
                date: today,
                sessions: [{ startTime: now }],
                status: 'active',
                currentSessionStart: now
            });
        } else {
            // Restart or resume - add new session
            if (attendance.status === 'completed' || attendance.status === 'paused') {
                attendance.sessions.push({ startTime: now });
                attendance.status = 'active';
                attendance.currentSessionStart = now;
                await attendance.save();
            } else if (attendance.status === 'active') {
                // Already active - return current state
                return res.json({
                    message: 'Timer already running',
                    attendance
                });
            }
        }

        res.json({
            message: 'Timer started',
            attendance
        });
    } catch (error) {
        console.error('Error starting timer:', error);
        res.status(500).json({ error: 'Failed to start timer' });
    }
});

// POST /pause - Pause the timer
/**
 * @swagger
 * /attendance/pause:
 *   post:
 *     tags: [Attendance]
 *     summary: Pause the working-hours timer
 *     security:
 *       - bearerAuth: []
 *     description: Records the pause timestamp and accumulates elapsed time.
 *     responses:
 *       200: { description: Updated attendance record }
 *       400: { description: Timer not running }
 *       401: { description: Unauthorized }
 */
router.post('/pause', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const today = getTodayDateString();

        const attendance = await Attendance.findOne({ user: userId, date: today });

        if (!attendance) {
            return res.status(404).json({ error: 'No active timer found' });
        }

        if (attendance.status !== 'active') {
            return res.status(400).json({ error: 'Timer is not active' });
        }

        // Close the current session
        const currentSession = attendance.sessions[attendance.sessions.length - 1];
        if (currentSession && !currentSession.endTime) {
            currentSession.endTime = new Date();
        }

        attendance.status = 'paused';
        attendance.currentSessionStart = null;
        attendance.calculateTotalWorkTime();
        await attendance.save();

        res.json({
            message: 'Timer paused',
            attendance
        });
    } catch (error) {
        console.error('Error pausing timer:', error);
        res.status(500).json({ error: 'Failed to pause timer' });
    }
});

// POST /resume - Resume the timer after pause
/**
 * @swagger
 * /attendance/resume:
 *   post:
 *     tags: [Attendance]
 *     summary: Resume the working-hours timer from a paused state
 *     security:
 *       - bearerAuth: []
 *     description: Records the resume timestamp and continues accumulating time.
 *     responses:
 *       200: { description: Updated attendance record }
 *       400: { description: Timer not paused }
 *       401: { description: Unauthorized }
 */
router.post('/resume', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const today = getTodayDateString();

        const attendance = await Attendance.findOne({ user: userId, date: today });

        if (!attendance) {
            return res.status(404).json({ error: 'No working hours record found' });
        }

        if (attendance.status !== 'paused') {
            return res.status(400).json({ error: 'Timer is not paused' });
        }

        // Start a new session
        const now = new Date();
        attendance.sessions.push({ startTime: now });
        attendance.status = 'active';
        attendance.currentSessionStart = now;
        await attendance.save();

        res.json({
            message: 'Timer resumed',
            attendance
        });
    } catch (error) {
        console.error('Error resuming timer:', error);
        res.status(500).json({ error: 'Failed to resume timer' });
    }
});

// POST /stop - Stop the timer (end day)
/**
 * @swagger
 * /attendance/stop:
 *   post:
 *     tags: [Attendance]
 *     summary: Stop the working-hours timer for today
 *     security:
 *       - bearerAuth: []
 *     description: Finalises today's total hours worked and marks the session as stopped.
 *     responses:
 *       200: { description: Final attendance record with total hours }
 *       400: { description: Timer not running }
 *       401: { description: Unauthorized }
 */
router.post('/stop', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const today = getTodayDateString();

        const attendance = await Attendance.findOne({ user: userId, date: today });

        if (!attendance) {
            return res.status(404).json({ error: 'No active timer found' });
        }

        // Close the current session if active
        const currentSession = attendance.sessions[attendance.sessions.length - 1];
        if (currentSession && !currentSession.endTime) {
            currentSession.endTime = new Date();
        }

        attendance.status = 'completed';
        attendance.currentSessionStart = null;
        attendance.calculateTotalWorkTime();
        await attendance.save();

        res.json({
            message: 'Timer stopped',
            attendance,
            totalHours: (() => { const m = Math.floor(attendance.totalWorkTime / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; })()
        });
    } catch (error) {
        console.error('Error stopping timer:', error);
        res.status(500).json({ error: 'Failed to stop timer' });
    }
});

// GET /status - Get current user's timer status
/**
 * @swagger
 * /attendance/status:
 *   get:
 *     tags: [Attendance]
 *     summary: Get today's timer status for the current user
 *     security:
 *       - bearerAuth: []
 *     description: Returns today's attendance record including current status, elapsed time, and session log.
 *     responses:
 *       200: { description: Today's attendance status object (or null if not started) }
 *       401: { description: Unauthorized }
 */
router.get('/status', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const today = getTodayDateString();

        // Get user's isStrictTimer setting
        const user = await User.findById(userId).select('isStrictTimer');

        const attendance = await Attendance.findOne({ user: userId, date: today });

        if (!attendance) {
            return res.json({
                status: 'not_started',
                isStrictTimer: user?.isStrictTimer !== false,
                attendance: null
            });
        }

        // Recalculate total work time for active sessions
        if (attendance.status === 'active') {
            attendance.calculateTotalWorkTime();
        }

        res.json({
            status: attendance.status,
            isStrictTimer: user?.isStrictTimer !== false,
            attendance,
            totalHours: (() => { const m = Math.floor(attendance.totalWorkTime / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; })()
        });
    } catch (error) {
        console.error('Error fetching status:', error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// GET /report - Get attendance records (with filters)
/**
 * @swagger
 * /attendance/report:
 *   get:
 *     tags: [Attendance]
 *     summary: Get the current user's attendance report
 *     security:
 *       - bearerAuth: []
 *     description: Returns the caller's own attendance history for a given date range.
 *     parameters:
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Array of attendance records }
 *       401: { description: Unauthorized }
 */
router.get('/report', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { startDate, endDate } = req.query;

        const query = { user: userId };

        if (startDate || endDate) {
            query.date = {};
            if (startDate) query.date.$gte = startDate;
            if (endDate) query.date.$lte = endDate;
        }

        const records = await Attendance.find(query).sort({ date: -1 });

        // Calculate total work time for each record
        records.forEach(record => {
            if (record.status === 'active') {
                record.calculateTotalWorkTime();
            }
        });

        res.json(records);
    } catch (error) {
        console.error('Error fetching report:', error);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
});

// GET /admin/report - Admin endpoint for viewing all attendance (Superadmin only)
/**
 * @swagger
 * /attendance/admin/report:
 *   get:
 *     tags: [Attendance]
 *     summary: Admin attendance report for all employees
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns attendance records for all employees, optionally filtered by user and date range.
 *       **Requires Attendance page access.**
 *     parameters:
 *       - { in: query, name: userId, schema: { type: string } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Array of attendance records for all matching users }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/admin/report', requireAuth, requirePageAccess('Attendance'), async (req, res) => {
    try {
        const { date, department, userId } = req.query;

        const query = {};
        if (date) query.date = date;

        let records = await Attendance.find(query)
            .populate('user', 'username email department role isStrictTimer')
            .sort({ date: -1 });

        // Filter by department if specified
        if (department) {
            records = records.filter(r => r.user?.department === department);
        }

        // Filter by specific user if specified
        if (userId) {
            records = records.filter(r => r.user?._id.toString() === userId);
        }

        // Calculate total work time for active records
        records.forEach(record => {
            if (record.status === 'active') {
                record.calculateTotalWorkTime();
            }
        });

        res.json(records);
    } catch (error) {
        console.error('Error fetching admin report:', error);
        res.status(500).json({ error: 'Failed to fetch admin report' });
    }
});

// POST /admin/force-stop/:attendanceId - Force stop a timer (Superadmin only)
/**
 * @swagger
 * /attendance/admin/force-stop/{attendanceId}:
 *   post:
 *     tags: [Attendance]
 *     summary: Admin force-stop a running timer for any employee
 *     security:
 *       - bearerAuth: []
 *     description: Forcefully stops a timer session for any user. **Requires Attendance page access.**
 *     parameters:
 *       - { in: path, name: attendanceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Force-stopped attendance record }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Attendance record not found }
 */
router.post('/admin/force-stop/:attendanceId', requireAuth, requirePageAccess('Attendance'), async (req, res) => {
    try {
        const { attendanceId } = req.params;

        const attendance = await Attendance.findById(attendanceId).populate('user', 'username email');

        if (!attendance) {
            return res.status(404).json({ error: 'Working hours record not found' });
        }

        if (attendance.status === 'completed') {
            return res.status(400).json({ error: 'Timer is already completed' });
        }

        // Force stop the timer
        if (attendance.status === 'active' && attendance.sessions.length > 0) {
            const lastSession = attendance.sessions[attendance.sessions.length - 1];
            if (!lastSession.endTime) {
                lastSession.endTime = new Date();
            }
        }

        attendance.status = 'completed';
        attendance.calculateTotalWorkTime();
        await attendance.save();

        console.log(`Admin force-stopped timer for user ${attendance.user?.username} on ${attendance.date}`);

        res.json({
            message: `Timer force-stopped for ${attendance.user?.username || 'user'}`,
            attendance
        });
    } catch (error) {
        console.error('Error force-stopping timer:', error);
        res.status(500).json({ error: 'Failed to force-stop timer' });
    }
});

// Edit attendance hours - HR admin and superadmin only
/**
 * @swagger
 * /attendance/admin/edit-hours/{attendanceId}:
 *   put:
 *     tags: [Attendance]
 *     summary: Admin manually edit hours for an attendance record
 *     security:
 *       - bearerAuth: []
 *     description: Overrides the calculated total hours for an attendance record. **Requires Attendance page access.**
 *     parameters:
 *       - { in: path, name: attendanceId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [totalHours]
 *             properties:
 *               totalHours: { type: number }
 *     responses:
 *       200: { description: Updated attendance record }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Attendance record not found }
 */
router.put('/admin/edit-hours/:attendanceId', requireAuth, requirePageAccess('Attendance'), validate(editAttendanceHoursSchema), async (req, res) => {
    try {
        const { attendanceId } = req.params;
        const { totalWorkTime } = req.body;

        const attendance = await Attendance.findById(attendanceId).populate('user', 'username email');

        if (!attendance) {
            return res.status(404).json({ error: 'Working hours record not found' });
        }

        // Update total work time
        attendance.totalWorkTime = totalWorkTime;
        await attendance.save();

        console.log(`Admin edited hours for user ${attendance.user?.username} on ${attendance.date} to ${totalWorkTime}ms`);

        res.json({
            message: `Hours updated for ${attendance.user?.username || 'user'}`,
            attendance
        });
    } catch (error) {
        console.error('Error editing working hours:', error);
        res.status(500).json({ error: 'Failed to edit working hours' });
    }
});

// Delete attendance record - HR admin and superadmin only
/**
 * @swagger
 * /attendance/admin/{attendanceId}:
 *   delete:
 *     tags: [Attendance]
 *     summary: Delete an attendance record (admin)
 *     security:
 *       - bearerAuth: []
 *     description: Permanently deletes an attendance record. **Requires Attendance page access.**
 *     parameters:
 *       - { in: path, name: attendanceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Attendance record not found }
 */
router.delete('/admin/:attendanceId', requireAuth, requirePageAccess('Attendance'), async (req, res) => {
    try {
        const { attendanceId } = req.params;

        const attendance = await Attendance.findById(attendanceId).populate('user', 'username email');

        if (!attendance) {
            return res.status(404).json({ error: 'Working hours record not found' });
        }

        const deletedInfo = {
            user: attendance.user?.username || 'Unknown',
            date: attendance.date,
            totalWorkTime: attendance.totalWorkTime
        };

        await Attendance.findByIdAndDelete(attendanceId);

        console.log(`Admin deleted working hours record for user ${deletedInfo.user} on ${deletedInfo.date}`);

        res.json({
            message: `Working hours record deleted for ${deletedInfo.user} on ${deletedInfo.date}`,
            deletedRecord: deletedInfo
        });
    } catch (error) {
        console.error('Error deleting working hours record:', error);
        res.status(500).json({ error: 'Failed to delete working hours record' });
    }
});

export default router;
