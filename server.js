// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieSession = require("cookie-session");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

/* ---------------- BASIC SETUP ---------------- */
app.use(express.json());
app.use(
  cors({
    origin: process.env.WP_FRONTEND_URL,
    credentials: true,
  })
);

app.use(
  cookieSession({
    name: "reviewmate-session",
    keys: [process.env.COOKIE_KEY],
    maxAge: 24 * 60 * 60 * 1000,
  })
);

/* ---------------- DB ---------------- */
mongoose.connect(process.env.MONGO_URI);

const UserSchema = new mongoose.Schema({
  googleId: String,
  email: String,
  name: String,
  picture: String,
  accessToken: String,
  refreshToken: String,
  automationSettings: [
    {
      locationName: String,
      locationId: String,
      isEnabled: Boolean,
      tone: String,
      keywords: String,
      timeFilter: String,
      replyScope: String,
    },
  ],
});

const User = mongoose.model("User", UserSchema);

/* ---------------- GOOGLE AUTH ---------------- */
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.BACKEND_URL}/auth/google/callback`
);

const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2("v2");
    const { data } = await oauth2.userinfo.get({ auth: oauth2Client });

    let user = await User.findOne({ googleId: data.id });

    if (!user) {
      user = await User.create({
        googleId: data.id,
        email: data.email,
        name: data.name,
        picture: data.picture,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      });
    } else {
      user.accessToken = tokens.access_token;
      if (tokens.refresh_token) user.refreshToken = tokens.refresh_token;
      await user.save();
    }

    res.redirect(
      `${process.env.WP_FRONTEND_URL}?uid=${user.googleId}&name=${encodeURIComponent(
        user.name
      )}&pic=${encodeURIComponent(user.picture)}`
    );
  } catch (err) {
    res.send("Authentication Failed");
  }
});

/* ---------------- TOKEN REFRESH ---------------- */
async function getAuthClient(user) {
  oauth2Client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });

  oauth2Client.on("tokens", (tokens) => {
    if (tokens.access_token) user.accessToken = tokens.access_token;
    if (tokens.refresh_token) user.refreshToken = tokens.refresh_token;
    user.save();
  });

  return oauth2Client;
}

/* ---------------- FETCH LOCATIONS ---------------- */
app.get("/api/locations", async (req, res) => {
  try {
    const user = await User.findOne({ googleId: req.query.googleId });
    if (!user) return res.status(401).json({ error: "User not found" });

    const auth = await getAuthClient(user);
    const mybusiness = google.mybusinessbusinessinformation({ version: "v1", auth });

    const accounts = await mybusiness.accounts.list();
    const locations = [];

    for (const acc of accounts.data.accounts || []) {
      const locRes = await mybusiness.accounts.locations.list({
        parent: acc.name,
        readMask: "name,title",
      });
      locations.push(...(locRes.data.locations || []));
    }

    res.json(locations);
  } catch (e) {
    if (e.code === 401) return res.json({ error: "Invalid credentials" });
    if (e.code === 429) return res.json({ error: "Quota exceeded. Wait 2 mins." });
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------- SAVE & RUN ---------------- */
app.post("/api/save-and-run", async (req, res) => {
  const { googleId, settings } = req.body;
  const user = await User.findOne({ googleId });
  user.automationSettings = settings;
  await user.save();

  const report = await runAutomation(user);
  res.json(report);
});

/* ---------------- CRON ---------------- */
app.get("/api/global-cron-run", async (req, res) => {
  const users = await User.find({});
  for (const user of users) {
    if (user.automationSettings?.length) {
      await runAutomation(user);
    }
  }
  res.send("Cron Completed");
});

/* ---------------- AUTOMATION BRAIN ---------------- */
async function runAutomation(user) {
  const auth = await getAuthClient(user);
  const reviewsApi = google.mybusinessreviews({ version: "v1", auth });
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  const logs = [];

  for (const loc of user.automationSettings.filter((l) => l.isEnabled)) {
    const reviews = await reviewsApi.accounts.locations.reviews.list({
      parent: loc.locationId,
    });

    for (const review of reviews.data.reviews || []) {
      if (loc.replyScope === "Unreplied Only" && review.reviewReply) continue;

      const prompt = `
Reply to this Google review politely.
Tone: ${loc.tone}
Keywords: ${loc.keywords}
Review: "${review.comment}"
`;

      const ai = await model.generateContent(prompt);
      const reply = ai.response.text();

      await reviewsApi.accounts.locations.reviews.updateReply({
        name: review.name,
        requestBody: { comment: reply },
      });

      logs.push(`Replied to ${review.reviewer.displayName}`);
    }
  }

  return logs;
}

/* ---------------- START ---------------- */
app.listen(5000, () => console.log("ReviewMate Backend Running"));
