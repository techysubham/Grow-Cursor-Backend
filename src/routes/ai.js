

import express from 'express';
import OpenAI from 'openai';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Lazy singleton — instantiated on first request so dotenv has already run
let _openai = null;
function getOpenAI() {
    if (!_openai) {
        // Use a dedicated key for fitment AI if configured, else fall back to the default
        const apiKey = process.env.OPENAI_FITMENT_API_KEY;
        _openai = new OpenAI({ apiKey });
    }
    return _openai;
}

// ============================================
// AI SUGGEST FITMENT
// POST /api/ai/suggest-fitment
// Body: { title: string, description: string }
// Returns: { make, model, startYear, endYear, allFitments }
// ============================================
router.post('/suggest-fitment', requireAuth, async (req, res) => {
    try {
        const { title = '', description = '' } = req.body;

        if (!title && !description) {
            return res.status(400).json({ error: 'title or description is required' });
        }

        // Strip HTML tags, then cut at boilerplate phrases that appear mid-description
        // (shipping promos, seller banners, store links — all irrelevant for fitment)
        const BOILERPLATE_SIGNALS = [
            'Top Seller', 'Fast, Reliable Shipping', 'Always Free', '1-Day Processing',
            'Questions?', "We're Happy to Help", 'Buy with Confidence',
            'Ship from USA', 'Free & Fast Shipping', '30 Days Return',
            'PLEASE VISIT OUR STORE', 'Thank you for shopping',
            'All communication is handled', 'eBay\'s messaging platform',
            'Orders ship within', 'carefully inspected before shipping',
        ];
        let rawText = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        // Find the earliest boilerplate cut point
        let cutAt = rawText.length;
        for (const signal of BOILERPLATE_SIGNALS) {
            const idx = rawText.indexOf(signal);
            if (idx !== -1 && idx < cutAt) cutAt = idx;
        }
        const cleanDescription = rawText.slice(0, cutAt).trim().slice(0, 500);

        const prompt = `You are an automotive parts expert. Extract all vehicle fitments from this eBay listing.

Title: ${title}
Description: ${cleanDescription}

Return ONLY a valid JSON array (no markdown, no explanation) where each object has:
- "make": string (e.g. "Toyota")
- "model": string (e.g. "Camry")
- "startYear": string (e.g. "2010")
- "endYear": string (same as startYear if only one year)

Rules:
- If a year range is given like "2008-2013", use startYear="2008" endYear="2013"
- If a single year is given like "2005", use startYear="2005" endYear="2005"
- Only include entries where you are confident of all four fields
- Do not invent data not present in the title or description

Example output: [{"make":"Lexus","model":"IS F","startYear":"2008","endYear":"2013"},{"make":"Lexus","model":"IS250","startYear":"2006","endYear":"2015"}]`;

        const completion = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 500
        });

        const raw = completion.choices[0]?.message?.content?.trim() || '[]';

        let allFitments = [];
        try {
            // Strip any accidental markdown code fences
            const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
            allFitments = JSON.parse(cleaned);
            if (!Array.isArray(allFitments)) allFitments = [];
        } catch (parseErr) {
            console.error('[AI Suggest Fitment] Failed to parse OpenAI response:', raw);
            return res.status(500).json({ error: 'AI returned unexpected format', raw });
        }

        if (allFitments.length === 0) {
            return res.json({ make: null, model: null, startYear: null, endYear: null, allFitments: [] });
        }

        // Pick the fitment with the longest year gap
        const best = allFitments.reduce((prev, curr) => {
            const prevGap = Number(prev.endYear) - Number(prev.startYear);
            const currGap = Number(curr.endYear) - Number(curr.startYear);
            return currGap > prevGap ? curr : prev;
        });

        res.json({
            make: best.make,
            model: best.model,
            startYear: best.startYear,
            endYear: best.endYear,
            allFitments
        });

    } catch (error) {
        console.error('[AI Suggest Fitment] Error:', error.message);
        res.status(500).json({ error: 'AI request failed', details: error.message });
    }
});

export default router;
