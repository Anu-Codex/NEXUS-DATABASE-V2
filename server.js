require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const MistralClient = require('@mistralai/mistralai').default;
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY; // Ensure this is in Render Env Vars
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// --- CONNECT TO THE SAME DATABASE AS NODE-01 ---
mongoose.connect(process.env.MONGO_URI);

// --- INITIALIZE AI ---
const mistral = new MistralClient(process.env.MISTRAL_API_KEY);
const { exec } = require('child_process');
const os = require('os');

app.get('/api/system/stats', (req, res) => {
    exec('df -h .', (err, stdout) => {
        let diskData = { total: "N/A", used: "N/A", free: "N/A", percent: "0" };
        if (!err) {
            const lines = stdout.split('\n');
            const stats = lines[1].replace(/\s+/g, ' ').split(' ');
            diskData = { total: stats[1], used: stats[2], free: stats[3], percent: stats[4].replace('%', '') };
        }
        res.json({
            success: true,
            ram: {
                total: (os.totalmem() / (1024 ** 3)).toFixed(2) + " GB",
                used: ((os.totalmem() - os.freemem()) / (1024 ** 3)).toFixed(2) + " GB",
                free: (os.freemem() / (1024 ** 3)).toFixed(2) + " GB",
                percent: (((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1)
            },
            disk: diskData,
            server: { region: process.env.RENDER_REGION || "USA (East)", uptime: Math.floor(process.uptime()) }
        });
    });
});

// --- IMPORT PLAYER SCHEMA (Must match Node-01 exactly) ---
const PlayerSchema = new mongoose.Schema({
    name: String,
    marketValue: Number,
    bdrPoints: Number,
    teamName: String,
    attributes: mongoose.Schema.Types.Mixed,
    googleId: { type: String, default: null, index: true },
    googleEmail: { type: String, default: null },
    email: { 
        type: String, 
        default: null, 
        lowercase: true, 
        trim: true,
        index: true 
    },
    password: { 
        type: String, 
        default: null 
    },
    isClaimed: { type: Boolean, default: false },
    cachedScoutReport: String
});
const Player = mongoose.model('Player', PlayerSchema);
// --- OTP VERIFICATION SCHEMA (Auto-expires in 10 minutes) ---
const otpSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, trim: true },
    otp: { type: String, required: true },
    purpose: { type: String, enum: ['signup', 'signin'], required: true },
    tempPasswordHash: String, // Kept temporarily during signup until OTP verified
    tempPlayerId: String,     // Target player profile to claim
    createdAt: { type: Date, default: Date.now, expires: 600 } // 10-minute TTL
});
const OtpVerification = mongoose.models.OtpVerification || mongoose.model('OtpVerification', otpSchema);
// --- AI ROUTE 1: SUPPORT BOT ---
app.post('/api/bot/groq-query', async (req, res) => {
    try {
        const { message } = req.body;
        const players = await Player.find({}, 'name marketValue bdrPoints teamName').lean();
        const dbContext = players.map(p => `${p.name}(MV:${p.marketValue}M,BDR:${p.bdrPoints})`).join('|');

        const chatResponse = await mistral.chat({
            model: 'mistral-tiny',
            messages: [
                { role: 'system', content: `Nexus Legends AI. Archive: ${dbContext}. Keep it concise.` },
                { role: 'user', content: message }
            ]
        });
        res.json({ reply: chatResponse.choices[0].message.content });
    } catch (err) { res.status(500).json({ reply: "Neural Link Overloaded." }); }
});

// --- AI ROUTE 2: SCOUTING DOSSIER ---
app.post('/api/bot/scout-player', async (req, res) => {
    try {
        const { name, attributes, marketValue } = req.body;
        const prompt = `Tactical Scout Report for ${name}. MV: ${marketValue}M. Attributes: ${JSON.stringify(attributes)}. 2 sentences max.`;

        const chatResponse = await mistral.chat({
            model: 'mistral-tiny',
            messages: [{ role: 'user', content: prompt }]
        });
        res.json({ report: chatResponse.choices[0].message.content });
    } catch (err) { res.status(500).json({ report: "Scouting Link Interrupted." }); }
});

// --- FAILOVER DATA MIRROR ---
// If Node-01 is down, this node can still provide basic data
app.get('/api/stats', async (req, res) => {
    const playersCount = await Player.countDocuments();
    res.json({ playersCount, status: "NODE-02-ACTIVE" });
});

app.get('/test', (req, res) => res.json({ status: "Auxiliary Node Online", node: 2 }));
// --- VIDEO SCHEMA ---
const VideoSchema = new mongoose.Schema({
    title: String,
    youtubeUrl: String,
    category: { type: String, default: "Tournament" }, // Highlights, Tutorials, Live
    createdAt: { type: Date, default: Date.now }
});
const Video = mongoose.model('Video', VideoSchema);

// --- API ROUTES ---
app.post('/api/media/add', async (req, res) => {
    try {
        const video = new Video(req.body);
        await video.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/media/all', async (req, res) => {
    const videos = await Video.find().sort({ createdAt: -1 });
    res.json(videos);
});

app.delete('/api/media/:id', async (req, res) => {
    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});
// --- ANNOUNCEMENT SCHEMA ---
const AnnSchema = new mongoose.Schema({
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const Announcement = mongoose.model('Announcement', AnnSchema);

// POST Announcement (Dashboard)
app.post('/api/announcements', async (req, res) => {
    try {
        const newAnn = new Announcement(req.body);
        await newAnn.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET Latest Announcements (Index)
app.get('/api/announcements', async (req, res) => {
    const list = await Announcement.find().sort({ timestamp: -1 }).limit(5);
    res.json(list);
});
// 1. Define the Tournament Structure for this new server
const TournamentSchema = new mongoose.Schema({
    type: { type: String, default: 'duo' },
    name: String,
    participants: [String],
    createdAt: { type: Date, default: Date.now }
});

// 2. Define the Standings Structure (for the Duo points table)
const StandingSchema = new mongoose.Schema({
    tourId: { type: mongoose.Schema.Types.ObjectId, ref: 'DuoTournament' },
    participant: String,
    group: { type: String, default: "Group A" },
    played: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    gf: { type: Number, default: 0 },
    ga: { type: Number, default: 0 },
    points: { type: Number, default: 0 }
});
const DuoRankSchema = new mongoose.Schema({
    tourId: String,
    category: String,
    playerName: String,
    totalValue: { type: Number, default: 0 }
});
const DuoRank = mongoose.model('DuoRank', DuoRankSchema);

// 3. Define the Fixture Structure (for Duo matches)
const fixtureSchema = new mongoose.Schema({
    tourId: { type: mongoose.Schema.Types.ObjectId, ref: 'DuoTournament' },
    playerA: String,
    playerB: String,
    scoreA: { type: Number, default: 0 },
    scoreB: { type: Number, default: 0 },
    status: { type: String, default: "Upcoming" },
    stage: { type: String, default: "Group Stage" },
    type: { type: String, default: "League" }, // League or Knockout
    createdAt: { type: Date, default: Date.now }
});

// 4. NOW you can define your models without errors
const DuoTournament = mongoose.model('DuoTournament', TournamentSchema);
const DuoStanding = mongoose.model('DuoStanding', StandingSchema);
const DuoFixture = mongoose.model('DuoFixture', fixtureSchema);

// Create Duo Tour
app.post('/api/duo/create-tour', async (req, res) => {
    try {
        const tour = await DuoTournament.create({ ...req.body, type: 'duo' });
        res.json({ success: true, tour });
    } catch (err) { res.status(500).json(err); }
});

// Add Duo Fixture (Manual Names)
app.post('/api/duo/create-fixture', async (req, res) => {
    try {
        const { tourId, playerA, playerB, stage, group } = req.body;
        const fixture = await DuoFixture.create({ tourId, playerA, playerB, stage, group });

        const names = [playerA, playerB];
        for (let name of names) {
            // This finds the team in the table for THAT specific group
            await DuoStanding.findOneAndUpdate(
                { tourId, participant: name, group: group }, 
                { tourId, participant: name, group: group },
                { upsert: true }
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json(err); }
});

// --- DUO MODELS (Ensure these are defined at the top) ---


// --- DUO ROUTES with CRASH PROTECTION ---

app.get('/api/duo/tournaments', async (req, res) => {
    try {
        const tours = await DuoTournament.find().sort({ createdAt: -1 });
        res.json(tours);
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/duo/fixtures/:tourId', async (req, res) => {
    try {
        const matches = await DuoFixture.find({ tourId: req.params.tourId });
        res.json(matches);
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/duo/standings/:tourId', async (req, res) => {
    try {
        const data = await DuoStanding.find({ tourId: req.params.tourId });
        res.json(data);
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/duo/boot/:tourId', async (req, res) => {
    try {
        // Fix: Ensure we filter by tourId and category
        const data = await DuoRank.find({ tourId: req.params.tourId, category: 'boot' });
        res.json(data);
    } catch (err) { res.status(500).json([]); }
});

// UPDATE DUO MATCH (Scores + Group + Stage)
app.put('/api/duo/update-score/:id', async (req, res) => {
    try {
        const { scoreA, scoreB, group, stage } = req.body;
        
        // This updates the fixture in the database
        await DuoFixture.findByIdAndUpdate(req.params.id, { 
            scoreA, 
            scoreB, 
            group, 
            stage,
            status: "Completed" // Mark as completed so Sync can find it
        });

        res.json({ success: true, message: "Match details updated!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// DELETE DUO FIXTURE
app.delete('/api/duo/fixture/:id', async (req, res) => {
    try {
        const fixture = await DuoFixture.findByIdAndDelete(req.params.id);
        if (!fixture) return res.status(404).json({ message: "Fixture not found" });
        
        res.json({ success: true, message: "Fixture removed from database." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// NUCLEAR RECALCULATE: Wipes everything and rebuilds strictly from Fixtures
app.get('/api/duo/recalculate/:tourId', async (req, res) => {
    try {
        const { tourId } = req.params;

        // 1. DELETE EVERY STANDING ENTRY for this tour
        // This removes all the teams stuck in "Group A"
        await DuoStanding.deleteMany({ tourId: tourId });

        // 2. GET ALL FIXTURES (We need these to know who belongs where)
        const allFixtures = await DuoFixture.find({ tourId: tourId });

        if (allFixtures.length === 0) return res.json({ success: false, error: "No matches found." });

        // 3. REBUILD THE TABLE
        for (let m of allFixtures) {
            const currentGroup = m.group || "Group A"; // Takes Group B, C, etc.
            
            const processTeam = async (pName, myG, oppG, isCompleted) => {
                let wins = 0, draws = 0, losses = 0, played = 0, pts = 0;

                if (isCompleted) {
                    played = 1;
                    if (myG > oppG) { wins = 1; pts = 3; }
                    else if (myG === oppG) { draws = 1; pts = 1; }
                    else { losses = 1; }
                }

                // We use $inc so it adds up match by match
                await DuoStanding.findOneAndUpdate(
                    { tourId: tourId, participant: pName, group: currentGroup },
                    { 
                        $inc: { 
                            played: played, wins: wins, draws: draws, losses: losses, 
                            gf: myG || 0, ga: oppG || 0, points: pts 
                        } 
                    },
                    { upsert: true }
                );
            };

            const isDone = m.status === "Completed";
            await processTeam(m.playerA, m.scoreA, m.scoreB, isDone);
            await processTeam(m.playerB, m.scoreB, m.scoreA, isDone);
        }

        res.json({ success: true, message: "DATABASE RESTRUCTURED: All teams moved to their assigned groups." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// AGGRESSIVE GROUP FIXER: Deletes duplicates and forces fixtures to sync
app.post('/api/duo/manual-group-move', async (req, res) => {
    try {
        const { tourId, teamName, newGroup } = req.body;

        if (!tourId || !teamName || !newGroup) {
            return res.status(400).json({ error: "Missing data" });
        }

        // 1. DELETE all existing table entries for this team in this tour
        // This kills the "MFs" staying in Group A
        await DuoStanding.deleteMany({ tourId: tourId, participant: teamName });

        // 2. FORCE UPDATE every single fixture this team has ever played in this tour
        // This moves "Matchday 1" from Group A to the correct group
        const updateResult = await DuoFixture.updateMany(
            { tourId: tourId, $or: [{ playerA: teamName }, { playerB: teamName }] },
            { $set: { group: newGroup } }
        );

        res.json({ 
            success: true, 
            message: `Cleaned records. Forced ${updateResult.modifiedCount} matches into ${newGroup}. NOW CLICK 'SYNC DUO POINTS TABLE' TO REBUILD.` 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// DELETE ENTIRE DUO TOURNAMENT (Tournament + Fixtures + Standings + Ranks)
app.delete('/api/duo/tournament/:id', async (req, res) => {
    try {
        const tourId = req.params.id;

        // 1. Delete the Tournament Metadata
        await DuoTournament.findByIdAndDelete(tourId);

        // 2. Delete all Fixtures belonging to this tour
        await DuoFixture.deleteMany({ tourId: tourId });

        // 3. Delete all Standings (Points Table) entries
        await DuoStanding.deleteMany({ tourId: tourId });

        // 4. Delete all Scorer records (Golden Boot)
        // Ensure your DuoRank model matches the field name 'tourId'
        if (mongoose.models.DuoRank) {
            await mongoose.model('DuoRank').deleteMany({ tourId: tourId });
        }

        res.json({ success: true, message: "Tournament and all associated data permanently deleted." });
    } catch (err) {
        console.error("Delete Tour Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});
// --- 1. NEURAL STAT INJECTOR (Sync stats without shifting groups) ---
app.get('/api/duo/sync-stats/:tourId', async (req, res) => {
    try {
        const { tourId } = req.params;

        // Reset only numeric stats for existing teams in standings
        // We DO NOT delete the entries, so groups remain locked
        await DuoStanding.updateMany({ tourId }, { 
            played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 
        });

        const completedMatches = await DuoFixture.find({ tourId, status: "Completed" });

        for (let m of completedMatches) {
            const updateTeam = async (name, myG, oppG) => {
                const win = myG > oppG ? 1 : 0;
                const draw = myG === oppG ? 1 : 0;
                const pts = (win * 3) + (draw * 1);

                // We find by name + tourId. The group remains what was already there.
                await DuoStanding.findOneAndUpdate(
                    { tourId, participant: name },
                    { $inc: { played: 1, wins: win, draws: draw, losses: (myG < oppG ? 1 : 0), gf: myG, ga: oppG, points: pts } }
                );
            };
            await updateTeam(m.playerA, m.scoreA, m.scoreB);
            await updateTeam(m.playerB, m.scoreB, m.scoreA);
        }
        res.json({ success: true, message: `Stats injected from ${completedMatches.length} matches.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. GET INTERNAL PARTICIPANTS (For Fixture Gen v2) ---
app.get('/api/duo/participants/:tourId', async (req, res) => {
    try {
        // Fetch teams that are already in the Points Table for this tour
        const teams = await DuoStanding.find({ tourId: req.params.tourId }, 'participant group');
        res.json(teams);
    } catch (err) { res.status(500).json([]); }
});
// --- LIVE BROADCAST SCHEMA ---
const LiveMatchSchema = new mongoose.Schema({
    title: { type: String, default: "LIVE TOURNAMENT" },
    url: { type: String, default: "" },
    isActive: { type: Boolean, default: false }
});
const LiveMatch = mongoose.model('LiveMatch', LiveMatchSchema);

// Admin: Set Live Link
app.post('/api/live/update', async (req, res) => {
    await LiveMatch.deleteMany({}); // Keep only 1 active link
    const newLive = new LiveMatch(req.body);
    await newLive.save();
    res.json({ success: true });
});

// Public: Get Live Link
app.get('/api/live/now', async (req, res) => {
    const live = await LiveMatch.findOne();
    res.json(live || { isActive: false });
});
// --- 1. PROFILE VIEW SCHEMA ---
const profileViewSchema = new mongoose.Schema({
    playerId: { type: String, required: true, index: true }, // String is safer for matching
    ip: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, index: true }
});

// Auto-delete records older than 14 days
profileViewSchema.index({ timestamp: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

const ProfileView = mongoose.models.ProfileView || mongoose.model('ProfileView', profileViewSchema);

// --- 2. RECORD VISIT (With 30-Min Deduplication) ---
app.post('/api/players/:id/view', async (req, res) => {
    try {
        const playerId = req.params.id;
        if (!playerId || playerId === "undefined" || playerId === "null") {
            return res.status(400).json({ success: false, error: "Invalid Player ID" });
        }

        const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        const clientIp = rawIp.split(',')[0].trim();
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

        // Check if recently viewed by same IP
        const recentVisit = await ProfileView.findOne({
            playerId: String(playerId),
            ip: clientIp,
            timestamp: { $gte: thirtyMinutesAgo }
        });

        if (recentVisit) {
            console.log(`[View Tracker] Skipped duplicate view for player: ${playerId}`);
            return res.json({ success: true, recorded: false, message: "View already counted recently (Cooldown active)" });
        }

        await ProfileView.create({
            playerId: String(playerId),
            ip: clientIp,
            timestamp: new Date()
        });

        console.log(`[View Tracker] ✅ New view logged for player: ${playerId}`);
        res.json({ success: true, recorded: true });
    } catch (err) {
        console.error("[View Tracker Error]:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 3. GET 7-DAY TRENDING LEADERBOARD (Bulletproof Join) ---
app.get('/api/players/trending/weekly', async (req, res) => {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        // 1. Group total views in last 7 days + today
        const viewStats = await ProfileView.aggregate([
            { $match: { timestamp: { $gte: sevenDaysAgo } } },
            {
                $group: {
                    _id: "$playerId",
                    views7d: { $sum: 1 },
                    viewsToday: {
                        $sum: {
                            $cond: [{ $gte: ["$timestamp", startOfToday] }, 1, 0]
                        }
                    }
                }
            },
            { $sort: { views7d: -1 } },
            { $limit: 15 }
        ]);

        if (viewStats.length === 0) {
            return res.json([]);
        }

        // 2. Fetch player details safely using Mongoose
        const playerIds = viewStats.map(v => v._id);
        const players = await Player.find({ _id: { $in: playerIds } });

        // 3. Merge views and player data in JS (Immune to BSON ObjectId/String type errors)
        const result = [];
        for (let stat of viewStats) {
            const p = players.find(player => String(player._id) === String(stat._id));
            if (p) {
                // Tier logic: uses existing tier or calculates by Market Value
                let tier = p.tier;
                if (!tier) {
                    const val = p.marketValue || 0;
                    if (val >= 40) tier = 'S';
                    else if (val >= 20) tier = 'A';
                    else tier = 'B';
                }

                result.push({
                    _id: p._id,
                    name: p.name,
                    image: p.image || 'https://via.placeholder.com/50',
                    teamName: p.teamName || 'No team',
                    tier: tier,
                    views7d: stat.views7d,
                    viewsToday: stat.viewsToday
                });
            }
        }

        res.json(result);
    } catch (err) {
        console.error("[Trending Route Error]:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// --- GLORY GALLERY POSTER SCHEMA ---
const gloryPosterSchema = new mongoose.Schema({
    playerName: { type: String, required: true },
    tourName: { type: String, required: true },
    status: { type: String, default: "CHAMPION" }, // CHAMPION, RUNNER-UP, MVP, GOLDEN BOOT
    imageUrl: { type: String, required: true },
    season: { type: String, default: "Season 1" },
    createdAt: { type: Date, default: Date.now }
});

const GloryPoster = mongoose.models.GloryPoster || mongoose.model('GloryPoster', gloryPosterSchema);

// 1. GET ALL POSTERS
app.get('/api/glory/posters', async (req, res) => {
    try {
        const posters = await GloryPoster.find().sort({ createdAt: -1 });
        res.json(posters);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ADD POSTER (From Dashboard)
app.post('/api/glory/posters', async (req, res) => {
    try {
        const poster = new GloryPoster(req.body);
        await poster.save();
        res.json({ success: true, message: "Glory Poster published successfully!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. DELETE POSTER (From Dashboard)
app.delete('/api/glory/posters/:id', async (req, res) => {
    try {
        await GloryPoster.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Poster deleted." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// =======================================================
// BULK IMPORT PLAYERS (CSV / REGISTRATION FORM IMPORT)
// =======================================================
app.post('/api/players/bulk-import', async (req, res) => {
    try {
        const { players } = req.body;

        // 1. Validation
        if (!Array.isArray(players) || players.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: "Invalid request. 'players' array is required and cannot be empty." 
            });
        }

        const PlayerModel = mongoose.models.Player || mongoose.model('Player');

        const added = [];
        const updated = [];
        const skipped = [];

        // 2. Process each player from the parsed CSV
        for (const p of players) {
            const trimmedName = p.name ? p.name.trim() : "";
            if (!trimmedName) continue;

            const trimmedNick = p.nickname ? p.nickname.trim() : "";
            const squadImg = p.squadImage ? p.squadImage.trim() : "";

            // Check if player already exists (Case-Insensitive)
            const existingPlayer = await PlayerModel.findOne({
                name: { $regex: new RegExp('^' + trimmedName + '$', 'i') }
            });

            if (!existingPlayer) {
                // Create brand-new player profile
                const newPlayer = new PlayerModel({
                    name: trimmedName,
                    nickname: trimmedNick,
                    squadImage: squadImg,
                    image: squadImg, // Sets squad screenshot as initial avatar so profile isn't blank
                    teamName: "Free Agent",
                    auctionPrice: 0,
                    marketValue: 0,
                    bdrPoints: 0,
                    soloBdrPoints: 0,
                    isCaptain: false,
                    attributes: {
                        consistency: 50,
                        bigMatch: 50,
                        scoring: 50,
                        playmaking: 50,
                        defense: 50,
                        mental: 50
                    }
                });

                await newPlayer.save();
                added.push(trimmedName);
            } else {
                // If player already exists, update their squad image or nickname if missing
                let wasModified = false;

                if (squadImg && (!existingPlayer.squadImage || existingPlayer.squadImage === "")) {
                    existingPlayer.squadImage = squadImg;
                    if (!existingPlayer.image || existingPlayer.image === "") {
                        existingPlayer.image = squadImg;
                    }
                    wasModified = true;
                }

                if (trimmedNick && (!existingPlayer.nickname || existingPlayer.nickname === "")) {
                    existingPlayer.nickname = trimmedNick;
                    wasModified = true;
                }

                if (wasModified) {
                    await existingPlayer.save();
                    updated.push(trimmedName);
                } else {
                    skipped.push(trimmedName);
                }
            }
        }

        console.log(`[Bulk Import] Added: ${added.length}, Updated: ${updated.length}, Skipped: ${skipped.length}`);

        res.json({
            success: true,
            message: `Successfully processed registration: ${added.length} added, ${updated.length} updated, ${skipped.length} duplicates skipped.`,
            addedCount: added.length,
            updatedCount: updated.length,
            skippedCount: skipped.length,
            addedPlayers: added
        });

    } catch (err) {
        console.error("Bulk Import Error:", err);
        res.status(500).json({ 
            success: false, 
            error: "Failed to import players: " + err.message 
        });
    }
});
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// --- 1. GOOGLE LOGIN & STATUS CHECK ---
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ error: "Missing Google credential token" });

        // Verify token directly with Google
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const { sub: googleId, email, picture, name } = payload;

        // A. Check if already linked to a player profile
        let player = await Player.findOne({ googleId: googleId });

        // B. If not found by googleId, check if pre-registered by email
        if (!player && email) {
            player = await Player.findOne({ 
                $or: [{ googleEmail: email.toLowerCase() }, { email: email.toLowerCase() }] 
            });
            if (player) {
                // Auto-link by matching email
                player.googleId = googleId;
                player.googleEmail = email.toLowerCase();
                player.isClaimed = true;
                if (!player.image) player.image = picture;
                await player.save();
            }
        }

        // C. If already linked: Return player data immediately
        if (player) {
            return res.json({
                success: true,
                isLinked: true,
                player: player
            });
        }

        // D. First-Time User: Fetch all unclaimed players for the one-time dropdown
        const unclaimedPlayers = await Player.find({ 
            $or: [{ isClaimed: false }, { isClaimed: { $exists: false } }, { googleId: null }] 
        }, 'name teamName image').sort({ name: 1 });

        res.json({
            success: true,
            isLinked: false,
            googleUser: { googleId, email, name, picture },
            unclaimedPlayers: unclaimedPlayers
        });

    } catch (err) {
        console.error("Google Auth Error:", err);
        res.status(500).json({ error: "Google verification failed: " + err.message });
    }
});

// --- 2. ONE-TIME PROFILE CLAIM ROUTE (PERMANENTLY LOCKED) ---
app.post('/api/auth/google/claim-profile', async (req, res) => {
    try {
        const { credential, playerId } = req.body;

        // Verify Google token again for strict security
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const { sub: googleId, email, picture } = ticket.getPayload();

        // 1. Check if this Google account already claimed someone
        const existingClaim = await Player.findOne({ googleId: googleId });
        if (existingClaim) {
            return res.status(400).json({ error: "Your Google account is already linked to " + existingClaim.name });
        }

        // 2. Find target player
        const player = await Player.findById(playerId);
        if (!player) return res.status(404).json({ error: "Player profile not found" });

        // 3. Prevent overwriting another player's claimed account
        if (player.isClaimed && player.googleId) {
            return res.status(400).json({ error: "This player profile has already been claimed by another user!" });
        }

        // 4. Lock Profile Permanently
        player.googleId = googleId;
        player.googleEmail = email.toLowerCase();
        player.isClaimed = true;
        if (!player.image || player.image === "") {
            player.image = picture; // Use Google photo if player had no avatar
        }
        await player.save();

        console.log(`🔒 [AUTH LOCKED] ${player.name} claimed by ${email} (${googleId})`);

        res.json({
            success: true,
            message: `Successfully linked your Google account to ${player.name}!`,
            player: player
        });

    } catch (err) {
        console.error("Claim Profile Error:", err);
        res.status(500).json({ error: "Failed to claim profile: " + err.message });
    }
});

// --- 3. SECRET ADMIN OVERRIDE: RESET / UNLINK GOOGLE ACCOUNT (DASHBOARD ONLY) ---
app.put('/api/admin/players/:id/unlink-auth', async (req, res) => {
    try {
        const { id } = req.params;
        const player = await Player.findByIdAndUpdate(
            id,
            {
                $set: {
                    googleId: null,
                    googleEmail: null,
                    isClaimed: false
                }
            },
            { new: true }
        );

        if (!player) return res.status(404).json({ error: "Player not found" });

        res.json({ success: true, message: `Auth unlinked. ${player.name} can now be claimed again.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// --- UPDATE PLAYER PROFILE (DASHBOARD & SELF-UPDATE) ---
app.put('/api/players/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Validate MongoDB ObjectId to prevent CastError crashes
        if (!id || id === "undefined" || id === "null" || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                success: false, 
                error: "Invalid or missing Player ID in session. Please re-login." 
            });
        }

        const { name, nickname, image, squadImage } = req.body;

        // 2. Find existing player
        const player = await Player.findById(id);
        if (!player) {
            return res.status(404).json({ success: false, error: "Player not found in database." });
        }

        // Inside app.put('/api/players/:id', ...)
        const oldName = player.name;
        const newName = name ? name.trim() : oldName;

        // Save new name to Player document
        player.name = newName;
        if (nickname !== undefined) player.nickname = nickname.trim();
        if (image !== undefined) player.image = image.trim();
        if (squadImage !== undefined) player.squadImage = squadImage.trim();
        await player.save();

        // 👉 AUTOMATIC CASCADE IF NAME CHANGED:
        if (oldName && newName && oldName.toLowerCase() !== newName.toLowerCase()) {
            const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const oldRegex = new RegExp('^' + escapeRegex(oldName.trim()) + '$', 'i');

            const FixtureModel = mongoose.models.Fixture || mongoose.model('Fixture');
            const StandingModel = mongoose.models.Standing || mongoose.model('Standing');

            if (FixtureModel) {
                await FixtureModel.updateMany({ playerA: oldRegex }, { $set: { playerA: newName } });
                await FixtureModel.updateMany({ playerB: oldRegex }, { $set: { playerB: newName } });
            }
            if (StandingModel) {
                await StandingModel.updateMany({ participant: oldRegex }, { $set: { participant: newName } });
            }
        }

        res.json({
            success: true,
            message: "Profile updated successfully!",
            player: updatedPlayer
        });

    } catch (err) {
        console.error("Player Update Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});
// --- HELPER: SEND OTP VIA BREVO API ---
async function sendBrevoOtpEmail(toEmail, otpCode, purposeTitle) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `🔐 NEXUS LEGENDS CODE: ${otpCode}`;
    sendSmtpEmail.htmlContent = `
        <div style="font-family:sans-serif; background:#060b13; color:#ffffff; padding:30px; border-radius:18px; border:2px solid #00e5ff; max-width:440px; margin:auto;">
            <h2 style="color:#00e5ff; margin-top:0; letter-spacing:2px;">NEXUS LEGENDS</h2>
            <p style="color:#94a3b8; font-size:0.9rem;">Your 6-digit security code for <b>${purposeTitle}</b> is:</p>
            <div style="background:#0e1726; border:1px solid #1e293b; padding:18px; text-align:center; border-radius:12px; margin:20px 0;">
                <span style="font-size:2.2rem; font-weight:900; letter-spacing:8px; color:#10b981;">${otpCode}</span>
            </div>
            <p style="color:#64748b; font-size:0.75rem;">This code expires in 10 minutes. If you did not request this, please ignore this email.</p>
        </div>
    `;
    sendSmtpEmail.sender = {
        name: "NEXUS LEGENDS SECURITY",
        email: process.env.BREVO_SENDER_EMAIL || "mysticfcmlegends@gmail.com"
    };
    sendSmtpEmail.to = [{ email: toEmail }];

    return apiInstance.sendTransacEmail(sendSmtpEmail);
}
// ==========================================
// 1. SIGN-UP: REQUEST OTP & CLAIM PROFILE
// ==========================================
app.post('/api/auth/email/signup-request', async (req, res) => {
    try {
        const { email, password, playerId } = req.body;

        if (!email || !password || !playerId) {
            return res.status(400).json({ error: "Email, password, and player profile are required." });
        }

        const cleanEmail = email.toLowerCase().trim();

        // Check if email already used by any player
        const emailTaken = await Player.findOne({ 
            $or: [{ email: cleanEmail }, { googleEmail: cleanEmail }] 
        });
        if (emailTaken) {
            return res.status(400).json({ error: "This email address is already registered. Please Sign In." });
        }

        // Check if player profile is already claimed
        const targetPlayer = await Player.findById(playerId);
        if (!targetPlayer) return res.status(404).json({ error: "Player profile not found." });
        if (targetPlayer.isClaimed) {
            return res.status(400).json({ error: "This player profile is already claimed by another user!" });
        }

        // Generate 6-digit numeric OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedPassword = await bcrypt.hash(password, 10);

        // Save temporary verification record (replaces any previous pending OTP for this email)
        await OtpVerification.deleteMany({ email: cleanEmail });
        await OtpVerification.create({
            email: cleanEmail,
            otp: otpCode,
            purpose: 'signup',
            tempPasswordHash: hashedPassword,
            tempPlayerId: playerId
        });

        // Send OTP via Brevo
        await sendBrevoOtpEmail(cleanEmail, otpCode, "Account Registration & Profile Claim");

        res.json({ success: true, message: `OTP sent to ${cleanEmail}` });
    } catch (err) {
        console.error("Signup Request Error:", err);
        res.status(500).json({ error: "Failed to dispatch verification email: " + err.message });
    }
});

// ==========================================
// 2. SIGN-UP: VERIFY OTP & FINALIZE ACCOUNT
// ==========================================
app.post('/api/auth/email/verify-signup', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const cleanEmail = email.toLowerCase().trim();

        const record = await OtpVerification.findOne({ 
            email: cleanEmail, 
            otp: otp.trim(),
            purpose: 'signup' 
        });

        if (!record) {
            return res.status(400).json({ error: "Invalid or expired OTP code." });
        }

        // Lock player profile permanently
        const player = await Player.findById(record.tempPlayerId);
        if (!player) return res.status(404).json({ error: "Player profile not found." });

        player.email = cleanEmail;
        player.password = record.tempPasswordHash;
        player.isClaimed = true;
        await player.save();

        // Delete used OTP
        await OtpVerification.deleteMany({ email: cleanEmail });

        res.json({
            success: true,
            message: `Account activated and locked to ${player.name}!`,
            player: player
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. SIGN-IN: VERIFY CREDENTIALS & DISPATCH OTP
// ==========================================
app.post('/api/auth/email/signin-request', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required." });

        const cleanEmail = email.toLowerCase().trim();

        // Find claimed player with this email
        const player = await Player.findOne({ email: cleanEmail });
        if (!player || !player.password) {
            return res.status(401).json({ error: "Account not found. Please Sign Up first." });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, player.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Incorrect password." });
        }

        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        await OtpVerification.deleteMany({ email: cleanEmail });
        await OtpVerification.create({
            email: cleanEmail,
            otp: otpCode,
            purpose: 'signin'
        });

        // Send OTP via Brevo
        await sendBrevoOtpEmail(cleanEmail, otpCode, "Sign-In Two-Factor Authentication");

        res.json({ success: true, message: `Security OTP sent to ${cleanEmail}` });
    } catch (err) {
        res.status(500).json({ error: "Sign-in error: " + err.message });
    }
});

// ==========================================
// 4. SIGN-IN: VERIFY OTP & COMPLETE LOGIN
// ==========================================
app.post('/api/auth/email/verify-signin', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const cleanEmail = email.toLowerCase().trim();

        const record = await OtpVerification.findOne({ 
            email: cleanEmail, 
            otp: otp.trim(),
            purpose: 'signin' 
        });

        if (!record) {
            return res.status(400).json({ error: "Invalid or expired OTP code." });
        }

        const player = await Player.findOne({ email: cleanEmail });
        await OtpVerification.deleteMany({ email: cleanEmail });

        res.json({
            success: true,
            message: "Login verified successfully!",
            player: player
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// --- EMERGENCY REPAIR: RE-LINK ALL PAST MATCHES FROM OLD NAME TO NEW NAME ---
app.get('/api/players/repair-history', async (req, res) => {
    try {
        const { oldName, newName } = req.query;

        if (!oldName || !newName) {
            return res.status(400).json({ error: "Please provide both oldName and newName query parameters." });
        }

        const cleanOld = oldName.trim();
        const cleanNew = newName.trim();
        const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const oldRegex = new RegExp('^' + escapeRegex(cleanOld) + '$', 'i');

        const FixtureModel = mongoose.models.Fixture || mongoose.model('Fixture');
        const StandingModel = mongoose.models.Standing || mongoose.model('Standing');
        const TournamentModel = mongoose.models.Tournament || mongoose.model('Tournament');
        const TourRankModel = mongoose.models.TourRank || mongoose.model('TourRank');

        // 1. Update all Fixtures (Player A & Player B)
        const fixA = await FixtureModel.updateMany({ playerA: oldRegex }, { $set: { playerA: cleanNew } });
        const fixB = await FixtureModel.updateMany({ playerB: oldRegex }, { $set: { playerB: cleanNew } });

        // 2. Update Legacy SoloFixtures (if any)
        let legacyCount = 0;
        if (mongoose.models.SoloFixture) {
            const sA = await mongoose.models.SoloFixture.updateMany({ playerA: oldRegex }, { $set: { playerA: cleanNew } });
            const sB = await mongoose.models.SoloFixture.updateMany({ playerB: oldRegex }, { $set: { playerB: cleanNew } });
            legacyCount = sA.modifiedCount + sB.modifiedCount;
        }

        // 3. Update Standings (Points Table)
        const stand = await StandingModel.updateMany({ participant: oldRegex }, { $set: { participant: cleanNew } });

        // 4. Update Tournament Participant lists
        const tours = await TournamentModel.find({ participants: oldRegex });
        for (let t of tours) {
            t.participants = t.participants.map(p => oldRegex.test(p) ? cleanNew : p);
            await t.save();
        }

        // 5. Update Rankings (Golden Boot / Ratings)
        if (TourRankModel) {
            await TourRankModel.updateMany({ playerName: oldRegex }, { $set: { playerName: cleanNew } });
        }

        res.json({
            success: true,
            message: `Successfully re-linked matches! Updated ${fixA.modifiedCount + fixB.modifiedCount} matches and ${stand.modifiedCount} table records from "${cleanOld}" to "${cleanNew}".`
        });

    } catch (err) {
        console.error("Repair Error:", err);
        res.status(500).json({ error: err.message });
    }
});
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Auxiliary AI Node running on ${PORT}`));
