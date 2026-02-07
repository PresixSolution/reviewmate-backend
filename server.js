// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cookieSession = require("cookie-session");
const passport = require("passport");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

/* -------------------- SESSION -------------------- */
app.use(
  cookieSession({
    name: "reviewmate-session",
    keys: [process.env.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000,
  })
);

app.use(passport.initialize());
app.use(passport.session());

/* -------------------- DB -------------------- */
mongoose.connect(process.env.MONGO_URI);

/* -------------------- USER SCHEMA -------------------- */
const automationSchema = new mongoose.Schema({
  locationId: String,
  timeFilter: {
    type: String,
    enum: ["7days", "14days", "30days", "all"],
    default: "7days",
  },
  replyScope: {
    type: String,
    enum: ["unreplied_only", "rewrite_all"],
    default: "unreplied_only",
  },
  tone: { type: String, default: "polite and professional" },
  isEnabled: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema({
  googleId: String,
  name: String,
  picture: String,
  email: String,
  accessToken: String,
  refreshToken: String,
  tokens: { type: Number, default: 1000 },
  automationSettings: [automationSchema],
});

const User = mongoose.model("User", userSchema);

/* -------------------- PASSPORT -------------------- */
const GoogleStrategy = require("passport-google-oauth20").Strategy;

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await User.findById(id);
  done(null, user);
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback", // ❗ DO NOT CHANGE
    },
    async (accessToken, refreshToken, profile, done) => {
      let user = await User.findOne({ googleId: profile.id });

      if (!user) {
        user = await User.create({
          googleId: profile.id,
          name: profile.displayName,
          picture: profile.photos[0].value,
          email: profile.emails[0].value,
          accessToken,
          refreshToken,
        });
      } else {
        user.accessToken = accessToken;
        user.refreshToken = refreshToken;
        await user.save();
      }
      done(null, user);
    }
  )
);

/* -------------------- AUTH ROUTES -------------------- */
app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: [
      "https://www.googleapis.com/auth/business.manage",
      "profile",
      "email",
    ],
    accessType: "offline",
    prompt: "consent",
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    // ❗ DO NOT CHANGE
    res.redirect(
      `https://picxomaster.in/reviewmate/?uid=${req.user._id}`
    );
  }
);

/* -------------------- GOOGLE CLIENT -------------------- */
function getGoogleClient(user) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });
  return oauth2Client;
}

/* -------------------- FETCH LOCATIONS -------------------- */
app.get("/api/locations", async (req, res) => {
  const user = await User.findById(req.query.uid);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const auth = getGoogleClient(user);
  const myBusiness = google.mybusinessbusinessinformation({
    version: "v1",
    auth,
  });

  const locations = await myBusiness.accounts.locations.list({
    parent: "accounts/-",
  });

  res.json(locations.data.locations || []);
});

/* -------------------- AI -------------------- */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* -------------------- AUTOMATION CORE -------------------- */
async function runAutomation(user, log = console.log) {
  const auth = getGoogleClient(user);
  const myBusinessReviews = google.mybusinessreviews({
    version: "v1",
    auth,
  });

  for (const setting of user.automationSettings) {
    if (!setting.isEnabled) continue;

    const reviewsRes = await myBusinessReviews.accounts.locations.reviews.list({
      parent: setting.locationId,
    });

    const reviews = reviewsRes.data.reviews || [];
    const now = Date.now();

    for (const review of reviews) {
      const created = new Date(review.createTime).getTime();
      const daysOld = (now - created) / (1000 * 60 * 60 * 24);

      /* ---- TIME FILTER ---- */
      if (
        setting.timeFilter !== "all" &&
        daysOld > parseInt(setting.timeFilter)
      ) {
        log("Skipped old review");
        continue;
      }

      /* ---- SCOPE FILTER ---- */
      if (
        setting.replyScope === "unreplied_only" &&
        review.reviewReply
      ) {
        log("Skipped replied review");
        continue;
      }

      /* ---- AI REPLY ---- */
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });

      const prompt = `
Reply to this Google review in a ${setting.tone} tone:

"${review.comment}"
      `;

      const result = await model.generateContent(prompt);
      const reply = result.response.text();

      await myBusinessReviews.accounts.locations.reviews.updateReply({
        name: review.name,
        requestBody: { comment: reply },
      });

      log(`Replied to review by ${review.reviewer.displayName}`);
    }
  }
}

/* -------------------- SAVE & RUN -------------------- */
app.post("/api/save-and-run", async (req, res) => {
  const { uid, settings } = req.body;
  const user = await User.findById(uid);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  user.automationSettings = settings;
  await user.save();

  runAutomation(user);
  res.json({ success: true });
});

/* -------------------- CRON -------------------- */
app.get("/api/global-cron-run", async (req, res) => {
  const users = await User.find({ "automationSettings.isEnabled": true });
  for (const user of users) {
    await runAutomation(user);
  }
  res.json({ status: "Automation completed" });
});

/* -------------------- SERVER -------------------- */
app.listen(5000, () =>
  console.log("ReviewMate backend running on port 5000")
);
