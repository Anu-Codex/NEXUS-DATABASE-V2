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
    played: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    gf: { type: Number, default: 0 },
    ga: { type: Number, default: 0 },
    points: { type: Number, default: 0 }
});

// 3. Define the Fixture Structure (for Duo matches)
const fixtureSchema = new mongoose.Schema({
    tourId: { type: mongoose.Schema.Types.ObjectId, ref: 'DuoTournament' },
    playerA: String,
    playerB: String,
    scoreA: { type: Number, default: 0 },
    scoreB: { type: Number, default: 0 },
    status: { type: String, default: "Upcoming" },
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
        const { tourId, playerA, playerB, type } = req.body;
        const fixture = await DuoFixture.create({ tourId, playerA, playerB, type: type || 'League' });

        // Auto-initialize Standings for manual names if they don't exist
        const names = [playerA, playerB];
        for (let name of names) {
            await DuoStanding.findOneAndUpdate(
                { tourId, participant: name },
                { tourId, participant: name },
                { upsert: true }
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json(err); }
});

// Update Duo Score (ONLY updates Duo Table/Rank - NO BDR/MV logic)
app.put('/api/duo/update-score/:id', async (req, res) => {
    try {
        const { scoreA, scoreB } = req.body;
        const fix = await DuoFixture.findByIdAndUpdate(req.params.id, { scoreA, scoreB, status: "Completed" });

        const updateDuoStats = async (pName, myS, oppS) => {
            const pts = myS > oppS ? 3 : (myS === oppS ? 1 : 0);
            // Update Table
            await DuoStanding.findOneAndUpdate(
                { tourId: fix.tourId, participant: pName },
                { $inc: { played: 1, wins: myS > oppS ? 1 : 0, draws: myS === oppS ? 1 : 0, losses: myS < oppS ? 1 : 0, gf: myS, ga: oppS, points: pts } }
            );
            // Update Duo Golden Boot
            await DuoRank.findOneAndUpdate(
                { tourId: fix.tourId, category: "boot", playerName: pName },
                { $inc: { totalValue: myS } },
                { upsert: true }
            );
        };

        await updateDuoStats(fix.playerA, scoreA, scoreB);
        await updateDuoStats(fix.playerB, scoreB, scoreA);
        res.json({ success: true });
    } catch (err) { res.status(500).json(err); }
});

// Fetching Routes
app.get('/api/duo/tournaments', async (req, res) => res.json(await DuoTournament.find().sort({createdAt: -1})));
app.get('/api/duo/standings/:tourId', async (req, res) => res.json(await DuoStanding.find({tourId: req.params.tourId})));
app.get('/api/duo/fixtures/:tourId', async (req, res) => res.json(await DuoFixture.find({tourId: req.params.tourId})));
app.get('/api/duo/boot/:tourId', async (req, res) => res.json(await DuoRank.find({tourId: req.params.tourId, category: 'boot'})));


const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Auxiliary AI Node running on ${PORT}`));
