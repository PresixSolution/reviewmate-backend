require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const cookieSession = require('cookie-session');

const app = express();

// --- Middleware ---
app.use(cors({ origin: true, credentials: true })); 
app.use(express.json());
app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'random_secret_key'],
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// --- Configuration ---
// 1. Google Auth Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI 
);

// 2. AI Setup (With Safety Settings Disabled)
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

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Database Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// User Schema
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

app.get('/', (req, res) => {
    res.send('ReviewMate Backend is Live! 🚀');
});

// 1. Google Login Link
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
    res.redirect(url); // Direct redirect fix
});

// 2. Google Callback
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

        res.send(`
            <h1 style="color:green; text-align:center; font-family:sans-serif; margin-top:50px;">Login Successful! ✅</h1>
            <p style="text-align:center; font-family:sans-serif;">
                Your User ID is: <br>
                <strong style="background:#eee; padding:5px; font-size:18px;">${user.googleId}</strong>
                <br><br>Copy this ID and paste it in the dashboard.
            </p>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send("Login Failed! Check Render Logs.");
    }
});

// 3. Review Generator (Updated Prompt)
app.post('/api/generate-reviews', async (req, res) => {
    try {
        const { brand, keywords, tone } = req.body;
        console.log(`Generating reviews for: ${brand}`);

        // Safer Prompt
        const prompt = `Generate 5 positive customer testimonials for a business named "${brand}". 
        Keywords to mention: ${keywords}. Tone: ${tone}.
        Output strictly as a JSON array of strings (e.g., ["Review 1", "Review 2"]). 
        Do not include markdown formatting or extra text.`;

        const result = await model.generateContent(prompt);
        let text = result.response.text();
        
        // Clean AI response
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start !== -1 && end !== -1) text = text.substring(start, end + 1);

        res.json({ success: true, reviews: JSON.parse(text) });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "Failed to generate reviews. Check API Key or Safety Filters." });
    }
});

// 4. Fetch Locations
app.get('/api/locations', async (req, res) => {
    const { googleId } = req.query; 
    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        oauth2Client.setCredentials({
            access_token: user.accessToken,
            refresh_token: user.refreshToken
        });

        const accountClient = google.mybusinessaccountmanagement('v1');
        const accounts = await accountClient.accounts.list({ auth: oauth2Client });
        
        let allLocations = [];
        const businessClient = google.mybusinessbusinessinformation('v1');

        if (accounts.data.accounts) {
            for (const account of accounts.data.accounts) {
                const locs = await businessClient.accounts.locations.list({ 
                    parent: account.name, 
                    readMask: 'name,title,storeCode' 
                });
                if (locs.data.locations) {
                    allLocations.push(...locs.data.locations);
                }
            }
        }
        res.json({ success: true, locations: allLocations });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch GMB locations" });
    }
});

// 5. Process Automation
app.post('/api/process-automation', async (req, res) => {
    const { googleId, selectedLocations } = req.body;

    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        user.automationSettings = selectedLocations;
        await user.save();

        oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
        const reviewClient = google.mybusinessreviews('v1');

        let report = [];

        for (const locSetting of selectedLocations) {
            if (!locSetting.isEnabled) continue;

            const reviews = await reviewClient.accounts.locations.reviews.list({
                parent: locSetting.name,
                pageSize: 10 
            });

            if (reviews.data.reviews) {
                for (const review of reviews.data.reviews) {
                    if (!review.reviewReply) {
                        const prompt = `Write a reply to this customer review: "${review.comment || 'Star rating only'}".
                        Rating: ${review.starRating}. Tone: ${locSetting.tone}.
                        ${locSetting.tone === 'SEO Friendly' ? `Keywords: ${locSetting.keywords}` : ''}
                        Keep it professional.`;

                        const aiResult = await model.generateContent(prompt);
                        const replyText = aiResult.response.text();

                        report.push({
                            business: locSetting.title,
                            original: review.comment || "Star Rating Only",
                            generated_reply: replyText
                        });
                    }
                }
            }
        }

        res.json({ success: true, report });

    } catch (error) {
        console.error("Automation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
