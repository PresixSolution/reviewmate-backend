require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ DB Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// --- UPDATED SCHEMA (With Smart Settings) ---
const UserSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    picture: String,
    accessToken: String,
    refreshToken: String,
    automationSettings: [{
        name: String, // Location ID
        title: String, // Business Name
        tone: String,
        keywords: String,
        isEnabled: Boolean,
        timeFilter: String, // '7days', '14days', '30days', 'all'
        replyScope: String  // 'unreplied_only', 'rewrite_all'
    }]
});
const User = mongoose.model('User', UserSchema);

// --- ROUTES ---
app.get('/', (req, res) => res.send('ReviewMate Smart Backend Live 🚀'));

// 1. LOGIN (Manual OAuth - No Passport needed)
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/business.manage',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email'
        ],
        prompt: 'consent'
    });
    res.redirect(url);
});

// 2. CALLBACK (Handshake) - FIXED URL HERE ✅
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
        
        // Save Tokens & Profile
        user.accessToken = tokens.access_token;
        if(tokens.refresh_token) user.refreshToken = tokens.refresh_token;
        user.name = userInfo.data.name;
        user.picture = userInfo.data.picture;
        
        await user.save();

        // ✅ FIXED LINK: Correct Domain & Slash added
        res.redirect(`https://picxomaster.in/reviewmate/?uid=${user.googleId}&name=${encodeURIComponent(user.name)}&pic=${encodeURIComponent(user.picture)}`);

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).send("Login Failed. Please try again.");
    }
});

// 3. GET LOCATIONS
app.get('/api/locations', async (req, res) => {
    const { googleId } = req.query; 
    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
        const accountClient = google.mybusinessaccountmanagement('v1');
        
        // Fetch Accounts
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
            } catch (e) { console.error("Loc fetch error:", e.message); }
        }
        res.json({ success: true, locations: allLocations });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. SAVE SETTINGS & RUN AUTOMATION (The Smart Part)
app.post('/api/save-and-run', async (req, res) => {
    const { googleId, selectedLocations } = req.body;
    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        // Save new settings
        user.automationSettings = selectedLocations;
        await user.save();

        // Trigger Automation
        const report = await runAutomationForUser(user);
        res.json({ success: true, report });

    } catch (error) {
        console.error("Automation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 5. GLOBAL CRON (For Daily Auto-Run)
app.get('/api/global-cron-run', async (req, res) => {
    console.log("⏰ Global Cron Started...");
    const users = await User.find({});
    let count = 0;
    for(const user of users) {
        if(user.automationSettings && user.automationSettings.some(s => s.isEnabled)) {
            await runAutomationForUser(user);
            count++;
        }
    }
    res.send(`✅ Automation Complete. Processed ${count} users.`);
});

// --- HELPER: SMART AUTOMATION LOGIC ---
async function runAutomationForUser(user) {
    oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
    const reviewClient = google.mybusinessreviews('v1');
    let report = [];

    for (const setting of user.automationSettings) {
        if (!setting.isEnabled) continue;

        try {
            const reviews = await reviewClient.accounts.locations.reviews.list({
                parent: setting.name,
                pageSize: 20 // Check last 20 reviews
            });

            if (reviews.data.reviews) {
                for (const review of reviews.data.reviews) {
                    
                    // --- A. TIME FILTER CHECK ---
                    const reviewDate = new Date(review.createTime);
                    const now = new Date();
                    const daysDiff = (now - reviewDate) / (1000 * 60 * 60 * 24);
                    
                    let limit = 9999;
                    if(setting.timeFilter === '7days') limit = 7;
                    if(setting.timeFilter === '14days') limit = 14;
                    if(setting.timeFilter === '30days') limit = 30;
                    
                    if(daysDiff > limit) continue; // Skip old reviews

                    // --- B. SCOPE CHECK ---
                    const hasReply = !!review.reviewReply;
                    if (setting.replyScope === 'unreplied_only' && hasReply) continue; // Skip if replied

                    // --- C. GENERATE REPLY ---
                    const prompt = `Write a reply to this customer review: "${review.comment || 'Star Rating'}". 
                    Business: ${setting.title}. Tone: ${setting.tone}. 
                    ${setting.keywords ? 'Include keywords: '+setting.keywords : ''}. 
                    Keep it professional and short.`;
                    
                    const aiResult = await model.generateContent(prompt);
                    const replyText = aiResult.response.text();

                    // --- D. POST REPLY ---
                    await reviewClient.accounts.locations.reviews.updateReply({
                        parent: review.name,
                        requestBody: { comment: replyText }
                    });

                    report.push({ 
                        business: setting.title, 
                        reviewer: review.reviewer.displayName,
                        action: "Replied",
                        details: hasReply ? "Updated existing reply" : "New reply"
                    });
                }
            }
        } catch (e) {
            console.error(`Error processing ${setting.title}:`, e.message);
        }
    }
    return report;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
