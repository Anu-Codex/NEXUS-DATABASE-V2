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

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Auxiliary AI Node running on ${PORT}`));
