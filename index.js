const fs = require('fs');
const path = require('path');
const { initializeBot } = require('./bot');
const { startServer } = require('./server');

const DB_PATH = path.join(__dirname, 'database.json');

// --- 1. LOCAL DATA STORE & CONFIGURATION ---
function loadDb() {
    try {
        if (fs.existsSync(DB_PATH)) {
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('[!] Error loading database:', e.message);
    }
    
    // Default fallback in case file is deleted or corrupted
    return {
        settings: {
            botName: "Zabir Bot",
            ownerName: "Boss",
            ownerNumber: "8200210397",
            ownerEmail: "supportglobalunido@gmail.com",
            ownerCompany: "GLOBALUNIDO",
            prefix: ".",
            targetGroups: ["GlobalUnido loading requirements"],
            sourceChannels: [
                "Transport Parivar Corporation",
                "BANNA TRANSPORT & CONSTRUCTION",
                "shree shyam transport 🙏🏻🙏🏻",
                "National Freight Transport (NFS)",
                "ats transport service",
                "Sri Velavan Transport 🚚",
                "Mama Sarkar Group",
                "KK SAHA TR",
                "Top Logistics All India Truck & Container Load",
                "GADI WALA TRANSPORT SERVICE",
                "Ashirwad Transport Service",
                "Mayur transport and tempo services latur",
                "Traffic Thane Mumbai Zk",
                "Chavan Transport Agency ( CTA INDIA LOAD ) CTA Transport & Logistics"
            ],
            aiModeEnabled: true,
            geminiApiKey: "",
            instagramEnabled: true,
            telegramEnabled: false,
            telegramToken: "",
            telegramChannelId: ""
        },
        autoReplies: [
            { trigger: "hi", reply: "Hello Boss! How can I help you today? 🚚✨" },
            { trigger: "hello", reply: "Hello Boss! Zabir AI Bot is fully operational. How can I assist you?" },
            { trigger: "help", reply: "You can use .menu in WhatsApp chat to view all my options! Or manage me via the Web Dashboard." }
        ],
        stats: {
            messagesReceived: 0,
            messagesSent: 0,
            commandsExecuted: 0
        },
        todoList: [],
        reminders: []
    };
}

function saveDb(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[!] Error saving database:', e.message);
    }
}

// Load dynamic database configuration
const db = loadDb();

// Shared State Context
const sharedContext = {
    db,
    saveDb,
    currentBotState: 'initializing',
    currentBotHelper: 'Starting system background scripts, please wait...',
    latestQRCode: null,
    // Stub implementations — overridden by server.js once it starts
    broadcastWS: (type, payload) => {},
    setBotState: (state, helper) => {
        sharedContext.currentBotState = state;
        sharedContext.currentBotHelper = helper;
        if (state === 'qr') sharedContext.latestQRCode = helper;
        if (state === 'ready') sharedContext.latestQRCode = null;
    }
};

// Global in-memory caches
global.recentProcessedLoads = global.recentProcessedLoads || [];
global.processedLoadSignatures = global.processedLoadSignatures || [];

// --- GLOBAL LOGGER OVERRIDE ---
const originalLog = console.log;
const originalError = console.error;
const logFilePath = path.join(require('os').homedir(), 'Desktop', 'Bot_Activity_Logs.txt');

function broadcastAndSaveLog(level, args) {
    const message = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    
    try { fs.appendFileSync(logFilePath, `[${timeStr}] [${level.toUpperCase()}] ${message}\n`); } catch(e) {}
    
    if (sharedContext.broadcastWS) {
        sharedContext.broadcastWS('log', { time: timeStr, message: message, level: level });
    }
}

console.log = function() {
    originalLog.apply(console, arguments);
    broadcastAndSaveLog('system', arguments);
};

console.error = function() {
    originalError.apply(console, arguments);
    broadcastAndSaveLog('error', arguments);
};
// ------------------------------
global.processedLoadSignatures = global.processedLoadSignatures || [];

let activeEngine = null;

// Bot engine wrapper to maintain stable reference
const botEngineWrapper = {
    getClient: () => activeEngine && activeEngine.getClient(),
    processConfirmedLoad: (...args) => activeEngine && activeEngine.processConfirmedLoad(...args),
    loadDrivers: () => activeEngine ? activeEngine.loadDrivers() : [],
    saveDrivers: (d) => activeEngine && activeEngine.saveDrivers(d)
};

// Initial bot setup
console.log('[i] Initializing WhatsApp Client Engine...');
activeEngine = initializeBot(sharedContext);

// Express and WebSockets server initialization
console.log('[i] Starting Glassmorphism Dashboard Server...');
const serverInstance = startServer(sharedContext, botEngineWrapper);

// Re-initialization mechanism for session clearing
sharedContext.reinitializeBot = () => {
    console.log('[i] Re-initializing WhatsApp Client Engine...');
    activeEngine = initializeBot(sharedContext);
};

// ==========================================
// 🔵 DAILY SUMMARY SCHEDULER (9 PM IST)
// ==========================================
async function sendDailySummary() {
    try {
        const client = botEngineWrapper.getClient();
        if (!client || sharedContext.currentBotState !== 'ready') return;
        
        const loads = global.recentProcessedLoads || [];
        const totalToday = loads.length;
        const channels = [...new Set(loads.map(l => l.channel))];
        const now = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        let summary = `📊 *GLOBALUNIDO DAILY SUMMARY REPORT*\n`;
        summary += `📅 *Date:* ${now}\n`;
        summary += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        summary += `📦 *Total Loads Processed:* ${totalToday}\n`;
        summary += `📥 *Messages Received:* ${db.stats.messagesReceived}\n`;
        summary += `📤 *Messages Sent:* ${db.stats.messagesSent}\n`;
        summary += `⚡ *Commands Executed:* ${db.stats.commandsExecuted}\n`;
        summary += `📡 *Channels Monitored:* ${(db.settings.sourceChannels || []).length}\n\n`;

        if (channels.length > 0) {
            summary += `🏆 *Active Source Channels Today:*\n`;
            channels.slice(0, 5).forEach((ch, i) => {
                summary += `   ${i+1}. ${ch}\n`;
            });
            if (channels.length > 5) summary += `   ...and ${channels.length - 5} more\n`;
        }

        if (totalToday > 0) {
            summary += `\n📝 *Last Processed Load:*\n`;
            const last = loads[loads.length - 1];
            summary += `   🕒 ${last.time} | 📍 ${last.channel}\n`;
            summary += `   "${last.text.substring(0, 80)}..."\n`;
        } else {
            summary += `\n💤 *No loads processed today. Monitoring continues 24/7!*\n`;
        }

        summary += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        summary += `🌐 *Dashboard:* http://localhost:3000\n`;
        summary += `_Zabir AI Bot • GLOBALUNIDO Logistics_ 🚚✨`;

        const ownerNum = db.settings.ownerNumber || "8200210397";
        const userWID = `91${ownerNum}@c.us`;
        await client.sendMessage(userWID, summary);
        console.log('[✔] Daily summary report sent to owner WhatsApp!');

        // Reset daily stats
        global.recentProcessedLoads = [];
        serverInstance.broadcastWS('loads', []);
    } catch (e) {
        console.error('[!] Failed to send daily summary:', e.message);
    }
}

function initializeSchedulers() {
    let lastSummaryDate = '';
    setInterval(() => {
        const now = new Date();
        const istHour = parseInt(new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours());
        const istMinute = parseInt(new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getMinutes());
        const todayDate = new Date().toDateString();

        if (istHour === 21 && istMinute === 0 && lastSummaryDate !== todayDate) {
            lastSummaryDate = todayDate;
            sendDailySummary();
        }
    }, 60000);
    console.log('[✔] Daily Summary Scheduler initialized (fires at 9:00 PM IST)');
}

initializeSchedulers();
