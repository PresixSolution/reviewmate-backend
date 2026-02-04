require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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
// Google Auth Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI 
);

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Database Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// User Schema (To save tokens)
const UserSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    accessToken: String,
    refreshToken: String
});
const User = mongoose.model('User', UserSchema);

// --- ROUTES ---

// 1. Home Check
app.get('/', (req, res) => {
    res.send('ReviewMate Backend is Live! 🚀');
});

// 2. Google Login Link (Updated Fix)
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
    
    // Yahan hum JSON nahi, direct bhejenge
    res.redirect(url); 
});

// 3. Google Callback (Login Success)
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        // Save/Update User in DB
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
            user.refreshToken = tokens.refresh_token; // Save new refresh token
        }
        await user.save();

        req.session.userId = user._id; // Save login session

        res.send(`
            <h1 style="color:green; text-align:center; margin-top:50px;">Login Successful! ✅</h1>
            <p style="text-align:center;">You can close this tab and return to the dashboard.</p>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send("Login Failed! Check console logs.");
    }
});

// 4. Review Generator (AI Tool)
app.post('/api/generate-reviews', async (req, res) => {
    try {
        const { brand, keywords, tone } = req.body;
        console.log(`Generating reviews for: ${brand}`);

        const prompt = `Write 5 unique Google Reviews for a brand named "${brand}". 
        Keywords: ${keywords}. Tone: ${tone}.
        Output ONLY a valid JSON array of strings. Example: ["Review 1", "Review 2"]`;

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
        res.status(500).json({ error: "Failed to generate reviews." });
    }
});

// 5. GMB Auto Reply Logic
app.post('/api/auto-reply', async (req, res) => {
    // Note: Iske liye user ko pehle Login hona padega.
    // Testing ke liye hum User ID body me maang rahe hain (Simple version)
    const { userId, replyTone } = req.body;

    try {
        const user = await User.findById(userId); // Ya req.session.userId use karein
        if (!user) return res.status(401).json({ error: "User not logged in" });

        oauth2Client.setCredentials({
            access_token: user.accessToken,
            refresh_token: user.refreshToken
        });

        // Abhi ke liye hum Fake Data reply kar rahe hain (Test Mode)
        // Asli GMB connect karne par 'google.mybusiness' use hoga
        const dummyReviews = [
            { reviewer: "Rohan", star: "5", text: "Amazing service!" },
            { reviewer: "Sita", star: "3", text: "Good but slow." }
        ];

        let replies = [];
        for (const review of dummyReviews) {
            const prompt = `Write a reply to a Google Review.
            Reviewer: ${review.reviewer}, Rating: ${review.star} stars.
            Review: "${review.text}". Tone: ${replyTone}.
            Keep it short and professional.`;

            const result = await model.generateContent(prompt);
            replies.push({
                original: review.text,
                reply: result.response.text()
            });
        }

        res.json({ success: true, replies });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
