import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createMeetingSchema, updateMeetingSchema } from '../schemas/index.js';
import Meeting from '../models/Meeting.js';
import User from '../models/User.js';

const router = Router();

const MEETING_ADMIN_ROLES = ['superadmin', 'hradmin', 'operationhead'];
const MEETING_PAGE_ROLES = [
    'superadmin',
    'productadmin',
    'listingadmin',
    'lister',
    'advancelister',
    'compatibilityadmin',
    'compatibilityeditor',
    'fulfillmentadmin',
    'hradmin',
    'hr',
    'operationhead',
    'trainee',
    'hoc',
    'compliancemanager'
];

const userSummaryPopulate = { path: 'organizer attendees createdBy updatedBy actionItems.assignee', select: 'username email role department' };

function canViewAllMeetings(user) {
    return MEETING_ADMIN_ROLES.includes(user.role);
}

function buildScopedQuery(user) {
    if (canViewAllMeetings(user)) {
        return {};
    }

    return {
        $or: [
            { createdBy: user.userId },
            { organizer: user.userId },
            { attendees: user.userId },
        ]
    };
}

function dedupeObjectIds(ids = []) {
    const seen = new Set();
    return ids.filter((id) => {
        const key = String(id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function validateMeetingUsers({ organizerId, attendeeIds = [], actionItems = [] }) {
    const relatedIds = dedupeObjectIds([
        organizerId,
        ...attendeeIds,
        ...actionItems.map((item) => item?.assigneeId).filter(Boolean)
    ].filter(Boolean));

    if (relatedIds.length === 0) {
        return [];
    }

    const users = await User.find({
        _id: { $in: relatedIds },
        active: true,
        role: { $ne: 'seller' }
    }).select('_id').lean();

    if (users.length !== relatedIds.length) {
        throw Object.assign(new Error('Meetings can only include active non-seller users'), { status: 400 });
    }

    return relatedIds;
}

function normalizeActionItems(actionItems = []) {
    return actionItems.map((item) => ({
        text: item.text.trim(),
        assignee: item.assigneeId || undefined,
        dueDate: item.dueDate ? new Date(item.dueDate) : undefined,
        status: item.status || 'pending',
    }));
}

async function loadMeetingOr404(meetingId, user) {
    if (!mongoose.Types.ObjectId.isValid(meetingId)) {
        throw Object.assign(new Error('Meeting not found'), { status: 404 });
    }

    const scopeQuery = buildScopedQuery(user);
    const query = { _id: meetingId, ...scopeQuery };
    const meeting = await Meeting.findOne(query).populate(userSummaryPopulate);

    if (!meeting) {
        throw Object.assign(new Error('Meeting not found'), { status: 404 });
    }

    return meeting;
}

function canEditMeeting(meeting, user) {
    if (canViewAllMeetings(user)) {
        return true;
    }

    const userId = String(user.userId);
    return String(meeting.createdBy?._id || meeting.createdBy) === userId
        || String(meeting.organizer?._id || meeting.organizer) === userId;
}

router.get('/users', requireAuth, requirePageAccess('Meetings', MEETING_PAGE_ROLES), async (req, res) => {
    try {
        const users = await User.find({ active: true, role: { $ne: 'seller' } })
            .select('username email role department')
            .sort({ username: 1 })
            .lean();

        res.json(users);
    } catch (error) {
        console.error('Failed to fetch meeting users:', error);
        res.status(500).json({ error: 'Failed to fetch meeting users' });
    }
});

router.get('/', requireAuth, requirePageAccess('Meetings', MEETING_PAGE_ROLES), async (req, res) => {
    try {
        const { status, search = '', organizerId = '' } = req.query;
        const scopedQuery = buildScopedQuery(req.user);
        const query = { ...scopedQuery };

        if (status && status !== 'all') {
            query.status = status;
        }

        if (organizerId && mongoose.Types.ObjectId.isValid(organizerId)) {
            query.organizer = organizerId;
        }

        if (search.trim()) {
            query.$and = [
                ...(query.$and || []),
                {
                    $or: [
                        { title: { $regex: search.trim(), $options: 'i' } },
                        { discussionSummary: { $regex: search.trim(), $options: 'i' } },
                        { futureScope: { $regex: search.trim(), $options: 'i' } },
                        { agenda: { $regex: search.trim(), $options: 'i' } },
                    ]
                }
            ];
        }

        const meetings = await Meeting.find(query)
            .populate(userSummaryPopulate)
            .sort({ scheduledFor: -1, updatedAt: -1 });

        res.json(meetings);
    } catch (error) {
        console.error('Failed to fetch meetings:', error);
        res.status(500).json({ error: 'Failed to fetch meetings' });
    }
});

router.get('/:id', requireAuth, requirePageAccess('Meetings', MEETING_PAGE_ROLES), async (req, res) => {
    try {
        const meeting = await loadMeetingOr404(req.params.id, req.user);
        res.json(meeting);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message || 'Failed to fetch meeting' });
    }
});

router.post('/', requireAuth, requirePageAccess('Meetings', MEETING_PAGE_ROLES), validate(createMeetingSchema), async (req, res) => {
    try {
        const {
            title,
            scheduledFor,
            organizerId,
            attendeeIds,
            status,
            location,
            agenda,
            discussionSummary,
            decisions,
            futureScope,
            actionItems,
        } = req.body;

        await validateMeetingUsers({ organizerId, attendeeIds, actionItems });

        const meeting = await Meeting.create({
            title: title.trim(),
            scheduledFor: new Date(scheduledFor),
            organizer: organizerId,
            attendees: dedupeObjectIds(attendeeIds),
            status: status || 'planned',
            location: location || '',
            agenda: agenda || '',
            discussionSummary: discussionSummary || '',
            decisions: decisions || '',
            futureScope: futureScope || '',
            actionItems: normalizeActionItems(actionItems),
            createdBy: req.user.userId,
            updatedBy: req.user.userId,
        });

        await meeting.populate(userSummaryPopulate);
        res.status(201).json(meeting);
    } catch (error) {
        console.error('Failed to create meeting:', error);
        res.status(error.status || 500).json({ error: error.message || 'Failed to create meeting' });
    }
});

router.put('/:id', requireAuth, requirePageAccess('Meetings', MEETING_PAGE_ROLES), validate(updateMeetingSchema), async (req, res) => {
    try {
        const meeting = await loadMeetingOr404(req.params.id, req.user);
        if (!canEditMeeting(meeting, req.user)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const updates = req.body || {};
        const organizerId = updates.organizerId || String(meeting.organizer?._id || meeting.organizer);
        const attendeeIds = updates.attendeeIds || meeting.attendees.map((attendee) => String(attendee._id || attendee));
        const actionItems = updates.actionItems || meeting.actionItems.map((item) => ({
            text: item.text,
            assigneeId: item.assignee?._id ? String(item.assignee._id) : item.assignee ? String(item.assignee) : undefined,
            dueDate: item.dueDate,
            status: item.status,
        }));

        await validateMeetingUsers({ organizerId, attendeeIds, actionItems });

        if (updates.title !== undefined) meeting.title = updates.title.trim();
        if (updates.scheduledFor !== undefined) meeting.scheduledFor = new Date(updates.scheduledFor);
        if (updates.organizerId !== undefined) meeting.organizer = updates.organizerId;
        if (updates.attendeeIds !== undefined) meeting.attendees = dedupeObjectIds(updates.attendeeIds);
        if (updates.status !== undefined) meeting.status = updates.status;
        if (updates.location !== undefined) meeting.location = updates.location || '';
        if (updates.agenda !== undefined) meeting.agenda = updates.agenda || '';
        if (updates.discussionSummary !== undefined) meeting.discussionSummary = updates.discussionSummary || '';
        if (updates.decisions !== undefined) meeting.decisions = updates.decisions || '';
        if (updates.futureScope !== undefined) meeting.futureScope = updates.futureScope || '';
        if (updates.actionItems !== undefined) meeting.actionItems = normalizeActionItems(updates.actionItems);
        meeting.updatedBy = req.user.userId;

        await meeting.save();
        await meeting.populate(userSummaryPopulate);
        res.json(meeting);
    } catch (error) {
        console.error('Failed to update meeting:', error);
        res.status(error.status || 500).json({ error: error.message || 'Failed to update meeting' });
    }
});

router.delete('/:id', requireAuth, requirePageAccess('Meetings', MEETING_PAGE_ROLES), async (req, res) => {
    try {
        const meeting = await loadMeetingOr404(req.params.id, req.user);
        if (!canEditMeeting(meeting, req.user)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await Meeting.findByIdAndDelete(meeting._id);
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to delete meeting:', error);
        res.status(error.status || 500).json({ error: error.message || 'Failed to delete meeting' });
    }
});

export default router;