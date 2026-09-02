require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const MistralClient = require('@mistralai/mistralai').default;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

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
    cachedScoutReport: String
});
const Player = mongoose.model('Player', PlayerSchema);

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

// Update Duo Score (Triggers Golden Boot update)
app.put('/api/duo/update-score/:id', async (req, res) => {
    try {
        const { scoreA, scoreB } = req.body;
        const fix = await DuoFixture.findByIdAndUpdate(req.params.id, { scoreA, scoreB, status: "Completed" });
        if (!fix) return res.status(404).json({ error: "Match not found" });

        const updateStats = async (name, myS, oppS) => {
            const pts = myS > oppS ? 3 : (myS === oppS ? 1 : 0);
            await DuoStanding.findOneAndUpdate(
                { tourId: fix.tourId, participant: name, group: fix.group },
                { $inc: { played: 1, wins: myS > oppS ? 1 : 0, draws: myS === oppS ? 1 : 0, losses: myS < oppS ? 1 : 0, gf: myS, ga: oppS, points: pts } },
                { upsert: true }
            );
            // Update Golden Boot (Team Goals)
            await DuoRank.findOneAndUpdate(
                { tourId: fix.tourId.toString(), category: "boot", playerName: name },
                { $inc: { totalValue: myS } },
                { upsert: true }
            );
        };
        await updateStats(fix.playerA, scoreA, scoreB);
        await updateStats(fix.playerB, scoreB, scoreA);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
// HYBRID RECOVERY: Show teams even if matches are unplayed (Upcoming)
app.get('/api/duo/recalculate/:tourId', async (req, res) => {
    try {
        const { tourId } = req.params;

        // 1. TOTAL WIPE: Clean the broken table
        await DuoStanding.deleteMany({ tourId: tourId });

        // 2. FETCH EVERY FIXTURE (Upcoming + Completed)
        const allFixtures = await DuoFixture.find({ tourId: tourId });

        if (allFixtures.length === 0) {
            return res.json({ success: false, error: "No fixtures found to build a table from." });
        }

        // 3. INITIALIZE TEAMS: Make sure every team in the fixtures appears in the table with 0s
        for (let m of allFixtures) {
            const teamsInMatch = [
                { name: m.playerA, group: m.group },
                { name: m.playerB, group: m.group }
            ];

            for (let t of teamsInMatch) {
                // This "upsert" ensures the team exists in the table for their group
                await DuoStanding.findOneAndUpdate(
                    { tourId: tourId, participant: t.name, group: t.group || "Group A" },
                    { tourId: tourId, participant: t.name, group: t.group || "Group A" }, 
                    { upsert: true, new: true }
                );
            }
        }

        // 4. CALCULATE COMPLETED MATCHES: Now add points for the ones actually played
        const completedMatches = allFixtures.filter(m => m.status === "Completed");

        for (let m of completedMatches) {
            const updateLogic = async (pName, myG, oppG) => {
                const isWin = myG > oppG ? 1 : 0;
                const isDraw = myG === oppG ? 1 : 0;
                const isLoss = myG < oppG ? 1 : 0;
                const pts = (isWin * 3) + (isDraw * 1);

                await DuoStanding.findOneAndUpdate(
                    { tourId: tourId, participant: pName, group: m.group },
                    { 
                        $inc: { 
                            played: 1, wins: isWin, draws: isDraw, losses: isLoss, 
                            gf: myG, ga: oppG, points: pts 
                        } 
                    }
                );
            };

            await updateLogic(m.playerA, m.scoreA, m.scoreB);
            await updateLogic(m.playerB, m.scoreB, m.scoreA);
        }

        res.json({ 
            success: true, 
            message: `Table Rebuilt! Found ${allFixtures.length} total teams across groups.` 
        });

    } catch (err) {
        console.error("Hybrid Recovery Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Auxiliary AI Node running on ${PORT}`));
