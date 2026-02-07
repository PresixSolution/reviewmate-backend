require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const cookieSession = require('cookie-session');

const app = express();
app.use(cors({ origin: true, credentials: true })); 
app.use(express.json());
app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'secret'],
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 Days
}));

// --- CONFIG ---
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI 
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ DB Connected"));

// --- SCHEMA (Smart Settings Added) ---
const UserSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    picture: String, // New: User Profile Pic
    accessToken: String,
    refreshToken: String,
    automationSettings: [{
        name: String, // Location ID
        title: String, // Business Name
        tone: String,
        keywords: String,
        isEnabled: Boolean,
        timeFilter: String, // 'all', '7days', '14days', '30days'
        replyScope: String, // 'unreplied_only' or 'rewrite_all'
    }]
});
const User = mongoose.model('User', UserSchema);

// --- ROUTES ---
app.get('/', (req, res) => res.send('ReviewMate Smart Backend Live 🚀'));

// 1. Login with Profile Info
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/business.manage',
            'https://www.googleapis.com/auth/userinfo.profile', // New: Name/Photo
            'https://www.googleapis.com/auth/userinfo.email'
        ],
        prompt: 'consent'
    });
    res.redirect(url);
});

// 2. Callback (Saves Name/Photo)
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        let user = await User.findOne({ googleId: userInfo.data.id });
        if (!user) {
            user = new User({ googleId: userInfo.data.id, email: userInfo.data.email });
        }
        
        // Update Tokens & Profile
        user.accessToken = tokens.access_token;
        if(tokens.refresh_token) user.refreshToken = tokens.refresh_token;
        user.name = userInfo.data.name;
        user.picture = userInfo.data.picture;
        
        await user.save();

        // ✅ Correct Line (With Slash / before ?)
        res.redirect(`https://picxomaster.in/reviewmate/?uid=${user.googleId}&name=${encodeURIComponent(user.name)}&pic=${encodeURIComponent(user.picture)}`);

    } catch (error) {
        res.status(500).send("Login Failed");
    }
});

// 3. Get Locations
app.get('/api/locations', async (req, res) => {
    const { googleId } = req.query; 
    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
        const accountClient = google.mybusinessaccountmanagement('v1');
        const accounts = await accountClient.accounts.list({ auth: oauth2Client });

        if (!accounts.data.accounts) return res.json({ success: true, locations: [] });

        let allLocations = [];
        const businessClient = google.mybusinessbusinessinformation('v1');

        for (const account of accounts.data.accounts) {
            try {
                const locs = await businessClient.accounts.locations.list({ 
                    parent: account.name, readMask: 'name,title', pageSize: 100 
                });
                if (locs.data.locations) allLocations.push(...locs.data.locations);
            } catch (e) {}
        }
        res.json({ success: true, locations: allLocations, user: { name: user.name, picture: user.picture } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. GENERATE REVIEWS (Home Page)
app.post('/api/generate-reviews', async (req, res) => {
    try {
        const { brand, keywords, tone } = req.body;
        const prompt = `Write 5 Google reviews for "${brand}". Keywords: ${keywords}. Tone: ${tone}. Output JSON Array only.`;
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const s = text.indexOf('['); const e = text.lastIndexOf(']');
        if(s!==-1 && e!==-1) text = text.substring(s, e+1);
        res.json({ success: true, reviews: JSON.parse(text) });
    } catch (error) { res.status(500).json({ error: "AI Error" }); }
});

// 5. PROCESS AUTOMATION (Smart Logic)
app.post('/api/save-and-run', async (req, res) => {
    const { googleId, selectedLocations } = req.body;
    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        // Save Settings
        user.automationSettings = selectedLocations;
        await user.save();

        // Run Logic
        const report = await runAutomationForUser(user);
        res.json({ success: true, report });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// --- HELPER FUNCTION: The Brain ---
async function runAutomationForUser(user) {
    oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
    const reviewClient = google.mybusinessreviews('v1');
    let report = [];

    for (const setting of user.automationSettings) {
        if (!setting.isEnabled) continue;

        // Fetch Reviews
        const reviews = await reviewClient.accounts.locations.reviews.list({
            parent: setting.name,
            pageSize: 50 // Check last 50 reviews
        });

        if (reviews.data.reviews) {
            for (const review of reviews.data.reviews) {
                
                // 1. DATE FILTER
                const reviewDate = new Date(review.createTime); // Google gives ISO date
                const now = new Date();
                let daysDiff = (now - reviewDate) / (1000 * 60 * 60 * 24);
                
                let isTimeMatch = true;
                if(setting.timeFilter === '7days' && daysDiff > 7) isTimeMatch = false;
                if(setting.timeFilter === '14days' && daysDiff > 14) isTimeMatch = false;
                if(setting.timeFilter === '30days' && daysDiff > 30) isTimeMatch = false;
                
                if(!isTimeMatch) continue; // Skip old reviews

                // 2. REPLY SCOPE (Overwrite or Skip)
                const hasReply = !!review.reviewReply;
                if (hasReply && setting.replyScope === 'unreplied_only') continue; // Skip if already replied

                // 3. GENERATE REPLY
                const prompt = `Customer Review: "${review.comment || '(Star Rating Only)'}". 
                Write a reply. Business Name: ${setting.title}. Tone: ${setting.tone}. 
                ${setting.keywords ? 'Keywords: '+setting.keywords : ''}. 
                Keep it short and professional.`;
                
                const ai = await model.generateContent(prompt);
                const replyText = ai.response.text();

                // 4. POST TO GOOGLE
                await reviewClient.accounts.locations.reviews.updateReply({
                    parent: review.name,
                    requestBody: { comment: replyText }
                });

                report.push({ 
                    business: setting.title, 
                    reviewer: review.reviewer.displayName,
                    action: hasReply ? "Updated Reply" : "New Reply",
                    reply: replyText 
                });
            }
        }
    }
    return report;
}

// 6. GLOBAL AUTOMATION CRON (For cron-job.org)
app.get('/api/global-cron-run', async (req, res) => {
    console.log("⏰ Running Global Automation...");
    const users = await User.find({});
    let totalActions = 0;

    for(const user of users) {
        if(user.automationSettings && user.automationSettings.some(s => s.isEnabled)) {
            try {
                await runAutomationForUser(user);
                totalActions++;
            } catch(e) { console.error(`Error for user ${user.name}:`, e.message); }
        }
    }
    res.send(`✅ Automation Cycle Complete. Processed active users.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
