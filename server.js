// ... (Upar ke imports same rahenge: express, mongoose, googleapis, gemini etc)

// --- DATABASE SCHEMAS ---
const UserSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    accessToken: String,
    refreshToken: String,
    // New: User ki settings save karne ke liye
    automationSettings: [{
        locationName: String, // GMB ID
        locationTitle: String, // Shop Name
        tone: String,
        keywords: String,
        isEnabled: Boolean
    }]
});
const User = mongoose.model('User', UserSchema);

// ... (Login Routes same rahenge)

// --- NEW API 1: Fetch GMB Locations ---
app.get('/api/locations', async (req, res) => {
    // Note: Asli production me Session/Cookie se User ID nikalna chahiye.
    // Abhi testing ke liye hum Query Param me email/id lenge.
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
                // Har account ki locations nikalo
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

// --- NEW API 2: Process Automation (The Main Logic) ---
app.post('/api/process-automation', async (req, res) => {
    const { googleId, selectedLocations } = req.body;
    // selectedLocations format: [{ name: "locations/123", tone: "SEO", keywords: "best pizza", enabled: true }]

    try {
        const user = await User.findOne({ googleId });
        if (!user) return res.status(401).json({ error: "User not found" });

        // Settings update karo DB me (Future use ke liye)
        // (Yahan simple logic likh rha hu, aap ise enhance kar sakte hain)
        user.automationSettings = selectedLocations;
        await user.save();

        oauth2Client.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
        const reviewClient = google.mybusinessreviews('v1');

        let report = [];

        // Loop through each selected GMB
        for (const locSetting of selectedLocations) {
            if (!locSetting.isEnabled) continue;

            // 1. Fetch Reviews
            const reviews = await reviewClient.accounts.locations.reviews.list({
                parent: locSetting.name,
                pageSize: 20 // Ek baar me 20 check karega
            });

            if (reviews.data.reviews) {
                for (const review of reviews.data.reviews) {
                    
                    // CHECK: Kya reply pehle se hai?
                    if (!review.reviewReply) {
                        
                        // 2. AI Reply Generate karo
                        const prompt = `
                            Act as the owner of "${locSetting.title}".
                            Write a reply to this customer review: "${review.comment || '(No text, just stars)'}".
                            Rating: ${review.starRating} stars.
                            Reviewer Language: Detect language of review and reply in SAME language.
                            Tone: ${locSetting.tone}.
                            ${locSetting.tone === 'SEO Friendly' ? `Include these Keywords naturally: ${locSetting.keywords}` : ''}
                            Keep it professional yet personal. No placeholders.
                        `;

                        const aiResult = await model.generateContent(prompt);
                        const replyText = aiResult.response.text();

                        // 3. (Optional) Asli Reply Post karna (Commented out for safety testing)
                        // await reviewClient.accounts.locations.reviews.reply({
                        //     parent: review.name,
                        //     requestBody: { comment: replyText }
                        // });

                        report.push({
                            business: locSetting.title,
                            reviewer: review.reviewer.displayName,
                            original: review.comment,
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
