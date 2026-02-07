require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const cookieSession = require('cookie-session');

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true })); 
app.use(express.json());
app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'random_secret_key'],
    maxAge: 24 * 60 * 60 * 1000 
}));

// Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI 
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
});

// Database
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Database Connected"))
    .catch(err => console.error("❌ DB Error:", err));

const UserSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    accessToken: String,
    refreshToken: String,
    automationSettings: [{
        locationName: String,
        locationTitle: String,
        tone: String,
        keywords: String,
        isEnabled: Boolean
    }]
});
const User = mongoose.model('User', UserSchema);

// --- ROUTES ---

app.get('/', (req, res) => res.send('ReviewMate Backend Live 🚀'));

// 1. Login Redirect
app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/business.manage',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
    ];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent'
    });
    res.redirect(url);
});

// 2. Login Callback (AUTO REDIRECT FIX)
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        let user = await User.findOne({ googleId: userInfo.data.id });
        if (!user) {
            user = new User({
                googleId: userInfo.data.id,
                email: userInfo.data.email,
                name: userInfo.data.name,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token
            });
        } else {
            user.accessToken = tokens.access_token;
            user.refreshToken = tokens.refresh_token;
        }
        await user.save();

        // 🔥 IMPORTANT: Redirect back to WordPress with ID
        // Note: Change this URL if your page is different
        res.redirect(`https://picxomaster.in/reviewmate/?uid=${user.googleId}&login=success`);

    } catch (error) {
        console.error(error);
        res.status(500).send("Login Failed! Check Render Logs.");
    }
});

// 3. API Routes (Same as before)
app.post('/api/generate-reviews', async (req, res) => {
    try {
        const { brand, keywords, tone } = req.body;
        const prompt = `Generate 5 creative customer reviews for "${brand}". Keywords: ${keywords}. Tone: ${tone}. JSON Array format only.`;
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const start = text.indexOf('['); const end = text.lastIndexOf(']');
        if (start !== -1 && end !== -1) text = text.substring(start, end + 1);
        res.json({ success: true, reviews: JSON.parse(text) });
    } catch (error) {
        res.status(500).json({ error: "AI Error" });
    }
});

// --- UPDATED API: Crash Proof Locations Fetch ---
app.get('/api/locations', async (req, res) => {
    const { googleId } = req.query; 
    console.log(`📡 Fetching locations for User ID: ${googleId}`);

    try {
        // 1. User Check
        const user = await User.findOne({ googleId });
        if (!user) {
            console.error("❌ User not found in DB");
            return res.status(401).json({ error: "User not found. Please Login again." });
        }

        // 2. Auth Setup
        oauth2Client.setCredentials({
            access_token: user.accessToken,
            refresh_token: user.refreshToken
        });

        // 3. Google API Call (Account Management)
        console.log("🔄 Calling Google Account Management API...");
        const accountClient = google.mybusinessaccountmanagement('v1');
        
        // Yahan Error 500 aata hai agar API Enable na ho
        const accounts = await accountClient.accounts.list({ auth: oauth2Client });
        
        console.log("✅ Accounts API Response Recieved");

        if (!accounts.data || !accounts.data.accounts) {
             console.error("⚠️ No accounts found in Google response.");
             return res.json({ success: true, locations: [], message: "No Business Accounts found linked to this email." });
        }

        let allLocations = [];
        const businessClient = google.mybusinessbusinessinformation('v1');

        // 4. Loop through accounts
        for (const account of accounts.data.accounts) {
            console.log(`🔎 Checking locations for account: ${account.name}`);
            
            try {
                const locs = await businessClient.accounts.locations.list({ 
                    parent: account.name, 
                    readMask: 'name,title,storeCode',
                    pageSize: 100
                });

                if (locs.data.locations) {
                    allLocations.push(...locs.data.locations);
                }
            } catch (innerError) {
                console.error(`⚠️ Error fetching locations for ${account.name}:`, innerError.message);
                // Agar ek account fail ho, to baki check karo (Crash mat karo)
            }
        }

        console.log(`🎉 Total Locations Found: ${allLocations.length}`);
        res.json({ success: true, locations: allLocations });

    } catch (error) {
        console.error("💥 CRITICAL SERVER ERROR:", error);
        
        // Agar Google API Enable nahi hai, to ye 403 error aayega
        if (error.code === 403) {
            return res.status(500).json({ 
                error: "Google API Error (403): Please ENABLE 'Google My Business Account Management API' in Cloud Console.",
                details: error.message
            });
        }

        res.status(500).json({ error: "Server Error: " + error.message });
    }
});
app.post('/api/process-automation', async (req, res) => {
    const { googleId, selectedLocations } = req.body;
    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });
        
        oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
        const reviewClient = google.mybusinessreviews('v1');
        let report = [];

        for (const locSetting of selectedLocations) {
            if (!locSetting.isEnabled) continue;
            const reviews = await reviewClient.accounts.locations.reviews.list({ parent: locSetting.name, pageSize: 5 });
            if (reviews.data.reviews) {
                for (const review of reviews.data.reviews) {
                    if (!review.reviewReply) {
                        const prompt = `Reply to this review: "${review.comment || 'Star rating'}". Tone: ${locSetting.tone}. ${locSetting.keywords ? 'Keywords: '+locSetting.keywords : ''}. Be professional.`;
                        const ai = await model.generateContent(prompt);
                        report.push({ business: locSetting.title, original: review.comment, generated_reply: ai.response.text() });
                    }
                }
            }
        }
        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
